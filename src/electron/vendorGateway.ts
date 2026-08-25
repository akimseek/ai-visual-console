import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { AiProviderId, ApiVendor } from "./types";
import { listApiVendors } from "./vendorManager";

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const ROUTE_PREFIX = "/gateway";

export type VendorRoute = {
  routeId: string;
  providerId: AiProviderId;
  vendorId: string;
  localToken: string;
  baseUrl: string;
  codexHome?: string;
};

export type VendorRouteSwitchResult = {
  switched: 0 | 1;
  reason?: "route-not-found" | "provider-mismatch";
};

type MutableVendorRoute = VendorRoute & { createdAt: number };

let gatewayServer: ReturnType<typeof createServer> | null = null;
let gatewayAddress = "";
let gatewayStartPromise: Promise<void> | null = null;
const routes = new Map<string, MutableVendorRoute>();

export async function ensureVendorGateway() {
  if (gatewayServer?.listening && gatewayAddress) return gatewayAddress;
  if (gatewayStartPromise) {
    await gatewayStartPromise;
    return gatewayAddress;
  }
  gatewayStartPromise = new Promise<void>((resolve, reject) => {
    const server = createServer((request, response) => {
      void handleGatewayRequest(request, response);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("本地 Gateway 未返回有效监听地址。"));
        return;
      }
      gatewayServer = server;
      gatewayAddress = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  }).finally(() => {
    gatewayStartPromise = null;
  });
  await gatewayStartPromise;
  return gatewayAddress;
}

export async function createVendorRoute(providerId: AiProviderId, vendorId?: string) {
  const vendors = await listApiVendors();
  const vendor = resolveVendor(vendors, providerId, vendorId);
  if (!vendor) return undefined;
  const gatewayUrl = await ensureVendorGateway();
  const routeId = crypto.randomUUID();
  const localToken = crypto.randomBytes(32).toString("hex");
  const route: MutableVendorRoute = {
    routeId,
    providerId,
    vendorId: vendor.id,
    localToken,
    baseUrl: `${gatewayUrl}${ROUTE_PREFIX}/${providerId}/${routeId}`,
    createdAt: Date.now()
  };
  if (providerId === "codex") route.codexHome = await createCodexHome(route);
  routes.set(routeId, route);
  return route;
}

export function switchVendorRoute(routeId: string, providerId: AiProviderId, vendorId: string): VendorRouteSwitchResult {
  const route = routes.get(routeId);
  if (!route) return { switched: 0, reason: "route-not-found" };
  if (route.providerId !== providerId) return { switched: 0, reason: "provider-mismatch" };
  route.vendorId = vendorId;
  return { switched: 1 };
}

export async function destroyVendorRoute(routeId: string) {
  const route = routes.get(routeId);
  if (!route) return;
  routes.delete(routeId);
  if (route.codexHome) await fs.rm(route.codexHome, { recursive: true, force: true }).catch(() => undefined);
}

export async function linkCodexRouteStorage(route: VendorRoute | undefined, sourceHome: string) {
  if (!route?.codexHome || !sourceHome) return;
  await fs.mkdir(path.join(sourceHome, "sessions"), { recursive: true });
  await fs.appendFile(path.join(sourceHome, "history.jsonl"), "");
  await linkPath(path.join(sourceHome, "sessions"), path.join(route.codexHome, "sessions"), process.platform === "win32" ? "junction" : undefined);
  if (process.platform === "win32") {
    try {
      await fs.link(path.join(sourceHome, "history.jsonl"), path.join(route.codexHome, "history.jsonl"));
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  } else {
    await linkPath(path.join(sourceHome, "history.jsonl"), path.join(route.codexHome, "history.jsonl"));
  }
}

async function linkPath(source: string, destination: string, type?: "junction") {
  try {
    await fs.symlink(source, destination, type);
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
}

export async function stopVendorGateway() {
  const routeIds = [...routes.keys()];
  await Promise.all(routeIds.map((routeId) => destroyVendorRoute(routeId)));
  const server = gatewayServer;
  gatewayServer = null;
  gatewayAddress = "";
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export function getVendorRoute(routeId: string) {
  return routes.get(routeId);
}

async function handleGatewayRequest(request: IncomingMessage, response: ServerResponse) {
  try {
    const parsed = new URL(request.url || "/", "http://127.0.0.1");
    const route = findRoute(parsed.pathname);
    if (!route) return respondJson(response, 404, { error: "gateway route not found" });
    if (!hasRouteToken(request, route.localToken)) return respondJson(response, 401, { error: "gateway unauthorized" });

    // 在读取数据库或请求体之前固定供应商，后续切换只影响新进入的请求。
    const selectedVendorId = route.vendorId;
    const vendors = await listApiVendors();
    const vendor = vendors.find((item) => item.id === selectedVendorId && item.providerId === route.providerId);
    if (!vendor || !vendor.apiKey) return respondJson(response, 503, { error: "gateway vendor unavailable" });

    const body = await readRequestBody(request);
    const suffix = parsed.pathname.slice(routePrefix(route).length) || "/";
    const upstreamUrl = joinUpstreamUrl(vendor.apiBaseUrl, suffix, parsed.search);
    if (gatewayAddress && upstreamUrl.startsWith(gatewayAddress)) {
      throw new Error("供应商地址不能指向本地 Gateway。");
    }
    const upstreamHeaders = buildUpstreamHeaders(request, vendor);
    const upstream = await fetch(upstreamUrl, {
      method: request.method || "GET",
      headers: upstreamHeaders,
      body: body.length > 0 && request.method !== "GET" && request.method !== "HEAD" ? body : undefined,
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
    response.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      if (key === "content-length" || key === "transfer-encoding" || key === "connection") return;
      response.setHeader(key, value);
    });
    if (!upstream.body) return response.end();
    for await (const chunk of Readable.fromWeb(upstream.body as any)) response.write(chunk);
    response.end();
  } catch (error: any) {
    if (!response.headersSent) respondJson(response, 502, { error: error?.message || "gateway upstream request failed" });
    else response.destroy();
  }
}

function resolveVendor(vendors: ApiVendor[], providerId: AiProviderId, vendorId?: string) {
  const explicit = vendorId?.trim() ? vendors.find((item) => item.id === vendorId) : undefined;
  if (explicit && explicit.providerId !== providerId) throw new Error("供应商协议与终端类型不匹配。");
  return explicit || vendors.find((item) => item.providerId === providerId && item.enabled);
}

function findRoute(pathname: string) {
  for (const route of routes.values()) {
    const prefix = routePrefix(route);
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return route;
  }
  return undefined;
}

function routePrefix(route: VendorRoute) {
  return `${ROUTE_PREFIX}/${route.providerId}/${route.routeId}`;
}

function hasRouteToken(request: IncomingMessage, token: string) {
  const authorization = request.headers.authorization || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const candidates = [bearer, request.headers["x-api-key"], request.headers["x-goog-api-key"]]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string");
  return candidates.some((value) => {
    const actual = Buffer.from(value);
    const expected = Buffer.from(token);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  });
}

function buildUpstreamHeaders(request: IncomingMessage, vendor: ApiVendor) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (["host", "authorization", "x-api-key", "x-goog-api-key", "content-length", "connection"].includes(name)) continue;
    for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
  }
  if (vendor.providerId === "claude") headers.set("x-api-key", vendor.apiKey);
  else if (vendor.providerId === "gemini") headers.set("x-goog-api-key", vendor.apiKey);
  else headers.set("authorization", `Bearer ${vendor.apiKey}`);
  return headers;
}

function joinUpstreamUrl(baseUrl: string, suffix: string, search: string) {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("供应商地址必须使用 HTTP 或 HTTPS。");
  if (base.search || base.hash) throw new Error("供应商地址不能包含查询参数或片段。");
  const basePath = base.pathname.replace(/\/+$/, "");
  const normalizedSuffix = suffix.startsWith("/v1/") && basePath.endsWith("/v1")
    ? suffix.slice("/v1".length)
    : suffix;
  base.pathname = `${basePath}${normalizedSuffix.startsWith("/") ? normalizedSuffix : `/${normalizedSuffix}`}`;
  base.search = search;
  return base.toString();
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("请求体超过本地 Gateway 限制。");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function createCodexHome(route: VendorRoute) {
  const tempRoot = path.join(process.cwd(), "temp");
  await fs.mkdir(tempRoot, { recursive: true });
  const home = await fs.mkdtemp(path.join(tempRoot, "ai-vendor-route-"));
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: route.localToken }, null, 2));
  await fs.writeFile(path.join(home, "config.toml"), [
    'model_provider = "akim_gateway"',
    "",
    "[model_providers.akim_gateway]",
    'name = "akim_gateway"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    `base_url = "${route.baseUrl}"`
  ].join("\n"));
  return home;
}

function respondJson(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}
