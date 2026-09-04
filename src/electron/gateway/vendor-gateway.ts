import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { performance } from "node:perf_hooks";
import type { AiProviderId, ApiVendor } from "../types";
import type { BrowserWindow } from "electron";
import { getGatewayVendorSnapshot } from "./vendor-registry";
import { getGatewayFailureThreshold, getGatewayPort } from "../core/settings";
import { detectWslGatewayHost } from "../core/wsl";
import { logGatewayEvent, recordGatewayRequest } from "./gateway-log";
import { chooseNextVendor, chooseVendor, hydrateGatewayVendorHealth, isCircuitOpen, recordGatewayVendorFailure, recordGatewayVendorSuccess } from "./gateway-resilience";
import { recordGatewayRequest as persistGatewayRequest } from "./gateway-request-store";
import { mergeGatewayUsage, parseGatewayUsage, parseUsageFromChunk } from "./gateway-usage";

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const ROUTE_PREFIX = "/gateway";
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_BUFFER_BYTES = 2 * 1024 * 1024;

// 拼接某路由在指定 host 上的完整 URL。host 形如 http://127.0.0.1:port 或 WSL 探测到的宿主地址。
export function buildRouteUrl(host: string, providerId: AiProviderId, routeId: string) {
  return `${host}${ROUTE_PREFIX}/${providerId}/${routeId}`;
}

export type VendorRoute = {
  routeId: string;
  providerId: AiProviderId;
  vendorId: string;
  localToken: string;
  baseUrl: string;
};

export type VendorRouteSwitchResult = {
  switched: 0 | 1;
  reason?: "route-not-found" | "provider-mismatch" | "vendor-not-found" | "vendor-disabled";
};

type MutableVendorRoute = VendorRoute & {
  createdAt: number;
  window?: BrowserWindow;
  terminalId?: string;
  // 终端句柄绑定前若已发生故障切换，暂存原因，绑定后补发给渲染层。
  pendingSwitchReason?: "manual" | "candidate-pool" | "failure";
};

let gatewayServer: ReturnType<typeof createServer> | null = null;
let gatewayAddress = "";
let gatewayStartPromise: Promise<void> | null = null;
const routes = new Map<string, MutableVendorRoute>();
const wslBaseUrlCache = new Map<string, { host: string; port: number }>();

export async function ensureVendorGateway() {
  if (gatewayServer?.listening && gatewayAddress) return gatewayAddress;
  if (gatewayStartPromise) {
    await gatewayStartPromise;
    return gatewayAddress;
  }
  gatewayStartPromise = startVendorGateway().finally(() => {
    gatewayStartPromise = null;
  });
  await gatewayStartPromise;
  return gatewayAddress;
}

async function startVendorGateway() {
  const configuredPort = await getGatewayPort();
  try {
    await listenOn(configuredPort);
  } catch (error) {
    // 固定端口被占用时回退到随机端口，避免终端启动整体失败；随机端口冲突属真异常，向上抛。
    if (!isAddrInUse(error) || configuredPort === 0) throw error;
    logGatewayEvent("warn", "fixed-port-busy", { configuredPort });
    await listenOn(0);
  }
}

function listenOn(port: number) {
  return new Promise<void>((resolve, reject) => {
    const server = createServer((request, response) => {
      void handleGatewayRequest(request, response);
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("本地 Gateway 未返回有效监听地址。"));
        return;
      }
      gatewayServer = server;
      // listen 阶段的 once 监听已失效；运行时换成持久监听，记录而非崩溃。
      server.off("error", reject);
      server.on("error", (error) => {
        logGatewayEvent("error", "server-runtime-error", { error: String(error) });
      });
      gatewayAddress = `http://127.0.0.1:${address.port}`;
      logGatewayEvent("info", "gateway-started", { configuredPort: port, actualPort: address.port });
      resolve();
    });
  });
}

function isAddrInUse(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "EADDRINUSE";
}

export function getVendorGatewayPort() {
  if (!gatewayAddress) return 0;
  return Number(new URL(gatewayAddress).port) || 0;
}

// 给 WSL 内的 CLI 进程解析可达宿主网关的 base URL。NAT 模式下 127.0.0.1 指向 WSL 自身，
// 必须改用默认路由网关地址；mirrored 模式下仍为 127.0.0.1。结果按 (distro,port) 缓存。
export async function resolveWslGatewayBaseUrl(distro: string): Promise<string> {
  const port = getVendorGatewayPort();
  if (!port) throw new Error("本地 Gateway 未启动。");
  const cached = wslBaseUrlCache.get(distro);
  if (cached && cached.port === port) {
    return `http://${cached.host}:${port}`;
  }
  const host = await detectWslGatewayHost(distro, port);
  wslBaseUrlCache.set(distro, { host, port });
  return `http://${host}:${port}`;
}

export function invalidateWslGatewayCache() {
  wslBaseUrlCache.clear();
}

export async function createVendorRoute(providerId: AiProviderId, vendorId?: string, window?: BrowserWindow) {
  // 健康状态只在实际请求转发时读取；终端启动阶段无需先执行一次数据库初始化。
  const vendors = await getGatewayVendorSnapshot();
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
    // 宿主进程（Windows/macOS/Linux 本地）访问用 127.0.0.1；WSL 终端启动时另行覆盖为探测地址。
    baseUrl: `${gatewayUrl}${ROUTE_PREFIX}/${providerId}/${routeId}`,
    createdAt: Date.now(),
    window
  };
  routes.set(routeId, route);
  return route;
}

export async function switchVendorRoute(routeId: string, providerId: AiProviderId, vendorId: string): Promise<VendorRouteSwitchResult> {
  const route = routes.get(routeId);
  if (!route) return { switched: 0, reason: "route-not-found" };
  if (route.providerId !== providerId) return { switched: 0, reason: "provider-mismatch" };
  // 手动切换也必须经过候选池校验，禁止切入已关闭或配置不完整的供应商。
  const vendors = await getGatewayVendorSnapshot();
  const vendor = vendors.find((item) => item.id === vendorId);
  if (!vendor) return { switched: 0, reason: "vendor-not-found" };
  if (vendor.providerId !== providerId) return { switched: 0, reason: "provider-mismatch" };
  if (!vendor.enabled || !vendor.apiKey.trim() || !vendor.apiBaseUrl.trim()) {
    return { switched: 0, reason: "vendor-disabled" };
  }
  notifyVendorSwitch(route, vendorId, "manual");
  return { switched: 1 };
}

export function bindVendorRouteTerminal(routeId: string, terminalId: string) {
  const route = routes.get(routeId);
  if (!route) return;
  route.terminalId = terminalId;
  if (route.pendingSwitchReason && route.window && !route.window.isDestroyed() && !route.window.webContents.isDestroyed()) {
    route.window.webContents.send("gateway:vendor-switched", {
      terminalId,
      vendorId: route.vendorId,
      reason: route.pendingSwitchReason
    });
    route.pendingSwitchReason = undefined;
  }
}

export function destroyVendorRoute(routeId: string) {
  routes.delete(routeId);
}

export async function stopVendorGateway() {
  routes.clear();
  invalidateWslGatewayCache();
  const server = gatewayServer;
  gatewayServer = null;
  gatewayAddress = "";
  if (!server) return;
  // closeAllConnections 强制关闭残留的 keep-alive 连接，避免 close 因等待空闲连接而挂起。
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export function getVendorRoute(routeId: string) {
  return routes.get(routeId);
}

// 路由前缀形如 /gateway/{provider}/{routeId}，routeId 是路径第三段，可直接 O(1) 命中。
function findRoute(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== ROUTE_PREFIX.slice(1)) return undefined;
  const providerId = segments[1] as AiProviderId;
  const routeId = segments[2];
  const route = routes.get(routeId);
  if (!route || route.providerId !== providerId) return undefined;
  const prefix = routePrefix(route);
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return undefined;
  return route;
}

async function handleGatewayRequest(request: IncomingMessage, response: ServerResponse) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  let bytesIn = 0;
  let bytesOut = 0;
  let outcome: "ok" | "client-aborted" | "timeout" | "error" = "error";
  let upstreamStatus: number | undefined;
  let routeId = extractRouteId(request.url || "");
  let providerId = extractProvider(request.url || "");
  let vendorId = "";
  const requestId = crypto.randomUUID();
  let retryCount = 0;
  let switched = false;
  let model: string | undefined;
  const usage: import("../types").GatewayUsage = {};
  let inputPricePerMillion: number | undefined;
  let outputPricePerMillion: number | undefined;

  // 客户端断开（CLI 被 Ctrl+C / 标签关闭）→ 取消上游 fetch，止血并避免继续计费。
  // 注意：request 的 readable 侧在正常请求结束（body 读尽）时也会触发 close，不能据此判断断开；
  // 仅当 response 在尚未写完时被关闭，才视为客户端提前断开。
  const onClientClose = () => {
    if (response.writableEnded || controller.signal.aborted) return;
    controller.abort(new GatewayAbort("client-disconnected"));
  };
  response.on("close", onClientClose);

  try {
    const parsed = new URL(request.url || "/", "http://127.0.0.1");
    const route = findRoute(parsed.pathname);
    if (!route) {
      respondJson(response, 404, { error: "gateway route not found" });
      outcome = "ok";
      return;
    }
    routeId = route.routeId;
    providerId = route.providerId;
    if (!hasRouteToken(request, route.localToken)) {
      respondJson(response, 401, { error: "gateway unauthorized" });
      outcome = "ok";
      return;
    }

    // 每次请求读取最新候选池；当前供应商仍可用时保持会话粘性，只有候选池或健康状态使其不可用时才换供应商。
    const vendors = await getGatewayVendorSnapshot();
    await hydrateGatewayVendorHealth();
    const routeVendor = vendors.find((item) => item.id === route.vendorId && item.providerId === route.providerId);
    const vendor = chooseVendor(vendors, route.providerId, route.vendorId);
    if (!vendor || !vendor.apiKey) {
      respondJson(response, 503, { error: "gateway vendor unavailable" });
      outcome = "ok";
      return;
    }
    vendorId = vendor.id;
    if (vendor.id !== route.vendorId) {
      // 当前供应商被关闭、删除或熔断时才会在请求前切换；这不是请求失败，不显示异常提示。
      notifyVendorSwitch(route, vendor.id, routeVendor && isCircuitOpen(routeVendor.id) ? "failure" : "candidate-pool");
    }
    inputPricePerMillion = vendor.pricing?.inputPerMillionUsd;
    outputPricePerMillion = vendor.pricing?.outputPerMillionUsd;

    // 流式请求体：先按声明值拦截超大请求，再零缓冲透传给上游。
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const suffix = parsed.pathname.slice(routePrefix(route).length) || "/";
    const declaredLength = Number(request.headers["content-length"] || 0);
    let bufferedBody: Buffer | undefined;
    if (hasBody && declaredLength > 0 && declaredLength <= RETRY_BUFFER_BYTES) {
      bufferedBody = await readRequestBody(request, MAX_REQUEST_BYTES, (n) => { bytesIn += n; });
      try {
        const parsedBody = JSON.parse(bufferedBody.toString("utf8")) as Record<string, unknown>;
        model = typeof parsedBody.model === "string" ? parsedBody.model : undefined;
      } catch {
        // 非 JSON 请求仍可透传，但无法提取模型字段。
      }
    }

    // 只有请求体已缓冲时才能安全重试；阈值表示同一供应商连续失败多少次后才切换。
    const failureThreshold = await getGatewayFailureThreshold();
    const candidateCount = vendors.filter((item) => item.providerId === route.providerId && item.enabled && item.apiKey.trim() && item.apiBaseUrl.trim()).length;
    const maxAttempts = bufferedBody && isRetryableMethod(request.method)
      ? Math.max(1, failureThreshold * Math.max(1, candidateCount))
      : 1;
    let upstream: Response | undefined;
    let attemptVendor = vendor;
    let failuresOnVendor = 0;
    const attemptedVendorIds = new Set<string>();
    // 达到切换阈值后选取下一个候选供应商并更新本次请求的转发状态。
    // 供应商启停会使快照失效，故每次重新取快照，确保关闭项不会进入本次故障转移。
    // 返回 false 表示没有其他候选；调用方决定抛出错误还是回放最后一次上游响应。
    const failoverToNextVendor = async (): Promise<boolean> => {
      attemptedVendorIds.add(attemptVendor.id);
      const freshVendors = await getGatewayVendorSnapshot();
      const nextVendor = chooseNextVendor(freshVendors, route.providerId, attemptVendor.id, attemptedVendorIds);
      if (!nextVendor) return false;
      attemptVendor = nextVendor;
      failuresOnVendor = 0;
      retryCount += 1;
      switched = true;
      vendorId = nextVendor.id;
      inputPricePerMillion = nextVendor.pricing?.inputPerMillionUsd;
      outputPricePerMillion = nextVendor.pricing?.outputPerMillionUsd;
      notifyVendorSwitch(route, nextVendor.id, "failure");
      return true;
    };
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!attemptVendor?.apiKey) break;
      const attemptUrl = joinUpstreamUrl(attemptVendor.apiBaseUrl, suffix, parsed.search);
      if (gatewayAddress && attemptUrl.startsWith(gatewayAddress)) {
        throw new Error("供应商地址不能指向本地 Gateway。");
      }
      const attemptHeaders = buildUpstreamHeaders(request, attemptVendor);
      const body = bufferedBody ?? (hasBody
        ? sizeGuardStream(Readable.toWeb(request) as ReadableStream<Uint8Array>, MAX_REQUEST_BYTES, controller, (n) => { bytesIn += n; })
        : undefined);
      try {
        upstream = await fetch(attemptUrl, {
          method: request.method || "GET",
          headers: attemptHeaders,
          body: body instanceof Buffer ? body : body as BodyInit | undefined,
          duplex: body && !(body instanceof Buffer) ? "half" : undefined,
          signal: AbortSignal.any([controller.signal, timeoutSignal])
        } as RequestInit);
      } catch (error) {
        if (attempt < maxAttempts - 1 && isRetryableFetchError(error, controller, timeoutSignal)) {
          await recordGatewayVendorFailure(attemptVendor, error instanceof Error ? error.message : String(error));
          failuresOnVendor += 1;
          if (failuresOnVendor >= failureThreshold && !(await failoverToNextVendor())) throw error;
          continue;
        }
        throw error;
      }
      upstreamStatus = upstream.status;
      if (attempt < maxAttempts - 1 && isRetryableStatus(upstream.status)) {
        await recordGatewayVendorFailure(attemptVendor, `HTTP ${upstream.status}`);
        failuresOnVendor += 1;
        if (failuresOnVendor < failureThreshold) {
          // 当前供应商尚未达到切换阈值，先释放失败响应体再重试同一供应商。
          await upstream.body?.cancel().catch(() => undefined);
          continue;
        }
        await upstream.body?.cancel().catch(() => undefined);
        // 无其他候选时回放最后一次上游响应，让客户端看到真实错误而非 502。
        if (!(await failoverToNextVendor())) break;
        continue;
      }
      if (upstream.status >= 400) await recordGatewayVendorFailure(attemptVendor, `HTTP ${upstream.status}`);
      else await recordGatewayVendorSuccess(attemptVendor);
      break;
    }
    if (!upstream) throw new Error("没有可用的供应商。");
    response.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      if (key === "content-length" || key === "transfer-encoding" || key === "connection") return;
      response.setHeader(key, value);
    });
    if (!upstream.body) { response.end(); outcome = "ok"; return; }
    // 用量提取只捕获响应体前 512KB；按 Buffer 收集、结束一次性解码，
    // 避免长流式响应反复扩容拷贝字符串，也修复跨 chunk 的多字节字符被截断的问题。
    const capturedChunks: Buffer[] = [];
    let capturedBytes = 0;
    await pipeline(
      Readable.fromWeb(upstream.body as any),
      byteCountingTransform((n, chunk) => {
        bytesOut += n;
        if (capturedBytes < 512 * 1024) {
          capturedChunks.push(chunk);
          capturedBytes += n;
        }
      }),
      response
    );
    const captured = capturedChunks.length > 0 ? Buffer.concat(capturedChunks).toString("utf8") : "";
    const parsedUsage = parseGatewayUsage(captured.startsWith("data:") ? undefined : tryParseJson(captured))
      || parseUsageFromChunk(captured);
    if (parsedUsage) mergeGatewayUsage(usage, parsedUsage);
    if (usage.inputTokens !== undefined && inputPricePerMillion !== undefined) {
      usage.costUsd = (usage.costUsd || 0) + usage.inputTokens / 1_000_000 * inputPricePerMillion;
    }
    if (usage.outputTokens !== undefined && outputPricePerMillion !== undefined) {
      usage.costUsd = (usage.costUsd || 0) + usage.outputTokens / 1_000_000 * outputPricePerMillion;
    }
    outcome = upstream.status >= 400 ? "error" : "ok";
  } catch (error: any) {
    if (isClientAbort(error, controller)) {
      outcome = "client-aborted";
      return;
    }
    if (error?.name === "TimeoutError") {
      outcome = "timeout";
      if (!response.headersSent) respondJson(response, 504, { error: "上游响应超时。" });
      else response.destroy();
      return;
    }
    outcome = "error";
    if (!response.headersSent) respondJson(response, 502, { error: error?.message || "gateway upstream request failed" });
    else response.destroy();
  } finally {
    response.off("close", onClientClose);
    recordGatewayRequest({
      routeId,
      provider: providerId,
      vendorId,
      method: request.method || "GET",
      path: request.url || "/",
      upstreamStatus,
      durationMs: Math.round(performance.now() - startedAt),
      bytesIn,
      bytesOut,
      outcome
    });
    void persistGatewayRequest({
      requestId,
      routeId,
      providerId: providerId as AiProviderId,
      vendorId,
      method: request.method || "GET",
      path: request.url || "/",
      model,
      upstreamStatus,
      outcome,
      durationMs: Math.round(performance.now() - startedAt),
      bytesIn,
      bytesOut,
      retryCount,
      switched,
      usage: Object.keys(usage).length > 0 ? usage : undefined,
      createdAt: new Date().toISOString()
    });
  }
}

class GatewayAbort extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "AbortError";
  }
}

function isClientAbort(error: unknown, controller: AbortController) {
  if (!(error instanceof Error) || error.name !== "AbortError") return false;
  const reason = controller.signal.reason;
  return reason instanceof GatewayAbort && reason.reason === "client-disconnected";
}

// 流式体积守卫：累计超限则 abort 上游，并统计上行字节，避免把整个请求体缓冲进内存。
function sizeGuardStream(
  webStream: ReadableStream<Uint8Array>,
  max: number,
  controller: AbortController,
  onChunk: (bytes: number) => void
): ReadableStream<Uint8Array> {
  const reader = webStream.getReader();
  let totalSeen = 0;
  return new ReadableStream({
    async pull(controller2) {
      const { done, value } = await reader.read();
      if (done) { controller2.close(); return; }
      onChunk(value.byteLength);
      totalSeen += value.byteLength;
      if (totalSeen > max) {
        controller.abort(new GatewayAbort("body-too-large"));
        try { await reader.cancel(); } catch { /* 已 abort */ }
        controller2.error(new Error("请求体超过本地 Gateway 限制。"));
        return;
      }
      controller2.enqueue(value);
    },
    cancel(reason) { reader.cancel(reason).catch(() => undefined); }
  });
}

// 计数 Transform：插入 pipeline 中间，统计下行字节数，对数据本身不做改动。
function byteCountingTransform(onByte: (bytes: number, chunk: Buffer) => void) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      onByte(buffer.byteLength, buffer);
      callback(null, chunk);
    }
  });
}

async function readRequestBody(request: IncomingMessage, maxBytes: number, onChunk: (bytes: number) => void) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    onChunk(buffer.byteLength);
    if (total > maxBytes) throw new Error("请求体超过本地 Gateway 限制。");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function tryParseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRetryableMethod(method?: string) {
  return method === "POST" || method === "PUT" || method === "PATCH";
}

function isRetryableStatus(status: number) {
  return [401, 403, 404, 408, 425, 429, 500, 502, 503, 504].includes(status);
}

function isRetryableFetchError(error: unknown, controller: AbortController, timeoutSignal: AbortSignal) {
  if (controller.signal.aborted || timeoutSignal.aborted) return false;
  return error instanceof Error;
}

function extractRouteId(url: string) {
  const segments = url.split("?")[0].split("/").filter(Boolean);
  return segments[2] || "";
}

function extractProvider(url: string) {
  const segments = url.split("?")[0].split("/").filter(Boolean);
  return segments[1] || "";
}

function resolveVendor(vendors: ApiVendor[], providerId: AiProviderId, vendorId?: string) {
  const explicit = vendorId?.trim() ? vendors.find((item) => item.id === vendorId) : undefined;
  if (explicit && explicit.providerId !== providerId) throw new Error("供应商协议与终端类型不匹配。");
  return explicit?.enabled ? explicit : vendors.find((item) => item.providerId === providerId && item.enabled);
}

function notifyVendorSwitch(route: MutableVendorRoute, vendorId: string, reason: "manual" | "candidate-pool" | "failure") {
  if (route.vendorId === vendorId) return;
  route.vendorId = vendorId;
  if (!route.terminalId) {
    route.pendingSwitchReason = reason;
    return;
  }
  if (route.window && !route.window.isDestroyed() && !route.window.webContents.isDestroyed()) {
    route.window.webContents.send("gateway:vendor-switched", {
      terminalId: route.terminalId || "",
      vendorId,
      reason
    });
  }
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
    // transfer-encoding 必须剔除：流式 body 由 undici 自行 chunking，手动透传会导致 invalid transfer-encoding。
    if (["host", "authorization", "x-api-key", "x-goog-api-key", "content-length", "transfer-encoding", "connection"].includes(name)) continue;
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

function respondJson(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}
