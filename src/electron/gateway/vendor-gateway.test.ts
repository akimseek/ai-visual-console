import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AiProviderId } from "../../shared/types";
import { rotateGatewayExternalApiToken, setGatewayExternalApiEnabled, setSettingsPath } from "../core/settings";

const mocks = vi.hoisted(() => ({
  listApiVendors: vi.fn(),
  getGatewayFailoverCustomResponse: vi.fn(async (message: string | undefined) => message?.toLocaleLowerCase().includes("credit insufficient balance")
    ? { customResponseStatus: 529, customResponseBody: '{"error":"custom upstream failure"}' }
    : undefined),
  matchesGatewayFailoverError: vi.fn(async (message: string | undefined, _providerId: string, _vendorId: string, statusCode?: number) => {
    const normalized = message?.toLocaleLowerCase() || "";
    return ["selected model is at capacity", "rate limit", "credit insufficient balance"]
      .some((pattern) => normalized.includes(pattern))
      || [401, 403, 404, 408, 425, 429, 500, 502, 503, 504].includes(statusCode || 0);
  })
}));
vi.mock("../vendors/vendor-manager", () => ({ listApiVendors: mocks.listApiVendors }));
vi.mock("./gateway-failover-rules", () => ({
  getGatewayFailoverCustomResponse: mocks.getGatewayFailoverCustomResponse,
  matchesGatewayFailoverError: mocks.matchesGatewayFailoverError
}));
const listApiVendorsMock = mocks.listApiVendors;

import {
  createVendorRoute,
  destroyVendorRoute,
  extractGatewayResponseError,
  setVendorRoute,
  stopVendorGateway,
  switchVendorRoute
} from "./vendor-gateway";
import { invalidateGatewayVendorSnapshot } from "./vendor-registry";

const servers: Server[] = [];

afterEach(async () => {
  await stopVendorGateway();
  invalidateGatewayVendorSnapshot();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.clearAllMocks();
});

describe("vendor gateway", () => {
  it("keeps the root path unavailable and requires the external API switch and token", async () => {
    listApiVendorsMock.mockResolvedValue([vendor("one", "key-one", "https://example.com", true)]);
    const route = await createVendorRoute("codex");
    if (!route) throw new Error("route was not created");
    const origin = new URL(route.baseUrl).origin;

    const root = await fetch(`${origin}/`);
    expect(root.status).toBe(404);
    expect(await root.json()).toEqual({ error: "gateway route not found" });

    const disabled = await fetch(`${origin}/external/codex/v1/responses`);
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toEqual({ error: "gateway external API is disabled" });

    const unknown = await fetch(`${origin}/external/unknown/v1/responses`);
    expect(unknown.status).toBe(404);
  });

  it("routes authenticated external API calls to their platform pools without forwarding the shared token", async () => {
    const received: Array<{ url: string; authorization: string; apiKey: string }> = [];
    const upstream = createServer((request, response) => {
      received.push({
        url: request.url || "",
        authorization: request.headers.authorization || "",
        apiKey: request.headers["x-api-key"] as string || request.headers["x-goog-api-key"] as string || ""
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not start");
    const apiBaseUrl = `http://127.0.0.1:${address.port}`;
    const providerIds: AiProviderId[] = ["codex", "claude", "gemini", "qoder"];
    listApiVendorsMock.mockResolvedValue(providerIds.map((providerId) => vendor(`${providerId}-vendor`, `${providerId}-vendor-key`, apiBaseUrl, true, providerId)));

    const settingsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-visual-console-gateway-"));
    setSettingsPath(path.join(settingsDirectory, "settings.json"));
    try {
      await setGatewayExternalApiEnabled(true);
      const token = await rotateGatewayExternalApiToken();
      const route = await createVendorRoute("codex");
      if (!route) throw new Error("route was not created");
      const origin = new URL(route.baseUrl).origin;
      const unauthorized = await fetch(`${origin}/external/codex/v1/responses`, {
        method: "POST",
        headers: { authorization: "Bearer invalid-token", "content-type": "application/json" },
        body: "{}"
      });
      expect(unauthorized.status).toBe(401);
      await unauthorized.text();
      const requests = [
        { url: `${origin}/external/codex/v1/responses`, headers: { authorization: `Bearer ${token}` }, expectedPath: "/v1/responses", expectedAuthorization: "Bearer codex-vendor-key" },
        { url: `${origin}/external/claude/v1/messages`, headers: { "x-api-key": token, "anthropic-version": "2023-06-01" }, expectedPath: "/v1/messages", expectedApiKey: "claude-vendor-key" },
        { url: `${origin}/external/gemini/v1beta/models/test:generateContent?key=${token}`, headers: {}, expectedPath: "/v1beta/models/test:generateContent", expectedApiKey: "gemini-vendor-key" },
        { url: `${origin}/external/qoder/v1/chat/completions`, headers: { authorization: `Bearer ${token}` }, expectedPath: "/v1/chat/completions", expectedAuthorization: "Bearer qoder-vendor-key" }
      ];
      for (const request of requests) {
        const response = await fetch(request.url, { method: "POST", headers: { "content-type": "application/json", ...request.headers }, body: "{}" });
        expect(response.status).toBe(200);
        await response.text();
      }

      expect(received.map((item) => item.url)).toEqual(requests.map((item) => item.expectedPath));
      for (const [index, request] of requests.entries()) {
        if (request.expectedAuthorization) expect(received[index].authorization).toBe(request.expectedAuthorization);
        if (request.expectedApiKey) expect(received[index].apiKey).toBe(request.expectedApiKey);
      }
      expect(received.some((item) => item.url.includes(token))).toBe(false);
    } finally {
      setSettingsPath("");
      await fs.rm(settingsDirectory, { recursive: true, force: true });
    }
  });

  it("fails over external calls on 429 and keeps the successful vendor for following requests", async () => {
    const authorizations: string[] = [];
    const upstream = createServer((request, response) => {
      const authorization = request.headers.authorization || "";
      authorizations.push(authorization);
      if (authorization === "Bearer key-one") {
        response.writeHead(429, { "content-type": "application/json" });
        response.end('{"error":"rate limit"}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not start");
    const apiBaseUrl = `http://127.0.0.1:${address.port}`;
    listApiVendorsMock.mockResolvedValue([
      vendor("first", "key-one", apiBaseUrl, true),
      vendor("second", "key-two", apiBaseUrl, true)
    ]);

    const settingsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-visual-console-gateway-"));
    setSettingsPath(path.join(settingsDirectory, "settings.json"));
    try {
      await setGatewayExternalApiEnabled(true);
      const token = await rotateGatewayExternalApiToken();
      const route = await createVendorRoute("codex");
      if (!route) throw new Error("route was not created");
      const url = `${new URL(route.baseUrl).origin}/external/codex/v1/responses`;
      for (let index = 0; index < 2; index += 1) {
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: "{}"
        });
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(authorizations).toEqual(["Bearer key-one", "Bearer key-two", "Bearer key-two"]);
    } finally {
      setSettingsPath("");
      await fs.rm(settingsDirectory, { recursive: true, force: true });
    }
  });

  it("external Claude requests fail over when a 400 error body contains a configured rule", async () => {
    const apiKeys: string[] = [];
    const upstream = createServer((request, response) => {
      const apiKey = request.headers["x-api-key"] || "";
      apiKeys.push(String(apiKey));
      if (apiKey === "claude-key-one") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"error":{"message":"credit insufficient balance"}}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not start");
    const apiBaseUrl = `http://127.0.0.1:${address.port}`;
    listApiVendorsMock.mockResolvedValue([
      vendor("claude-first", "claude-key-one", apiBaseUrl, true, "claude"),
      vendor("claude-second", "claude-key-two", apiBaseUrl, true, "claude")
    ]);

    const settingsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-visual-console-gateway-"));
    setSettingsPath(path.join(settingsDirectory, "settings.json"));
    try {
      await setGatewayExternalApiEnabled(true);
      const token = await rotateGatewayExternalApiToken();
      const route = await createVendorRoute("claude");
      if (!route) throw new Error("route was not created");
      const url = `${new URL(route.baseUrl).origin}/external/claude/v1/messages`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: "{}"
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(apiKeys).toEqual(["claude-key-one", "claude-key-two"]);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(mocks.getGatewayFailoverCustomResponse).toHaveBeenCalledWith("credit insufficient balance", "claude", "claude-first", 400);
      expect(mocks.matchesGatewayFailoverError).toHaveBeenCalledWith(
        "credit insufficient balance",
        "claude",
        "claude-first",
        400
      );
    } finally {
      setSettingsPath("");
      await fs.rm(settingsDirectory, { recursive: true, force: true });
    }
  });

  it("returns a configured custom response after all candidate vendors fail", async () => {
    const apiKeys: string[] = [];
    const upstream = createServer((request, response) => {
      apiKeys.push(String(request.headers["x-api-key"] || ""));
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":{"message":"credit insufficient balance: balance=23349 required=35852"}}');
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not start");
    const apiBaseUrl = `http://127.0.0.1:${address.port}`;
    listApiVendorsMock.mockResolvedValue([
      vendor("claude-first", "claude-key-one", apiBaseUrl, true, "claude"),
      vendor("claude-second", "claude-key-two", apiBaseUrl, true, "claude")
    ]);

    const settingsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-visual-console-gateway-"));
    setSettingsPath(path.join(settingsDirectory, "settings.json"));
    try {
      await setGatewayExternalApiEnabled(true);
      const token = await rotateGatewayExternalApiToken();
      const route = await createVendorRoute("claude");
      if (!route) throw new Error("route was not created");
      const response = await fetch(`${new URL(route.baseUrl).origin}/external/claude/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: "{}"
      });

      expect(response.status).toBe(529);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await response.json()).toEqual({ error: "custom upstream failure" });
      expect(apiKeys).toEqual(["claude-key-one", "claude-key-two"]);
    } finally {
      setSettingsPath("");
      await fs.rm(settingsDirectory, { recursive: true, force: true });
    }
  });

  it("keeps request bodies isolated when routes receive concurrent requests", async () => {
    const requests: Array<{ authorization: string; body: string }> = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        setTimeout(() => {
          requests.push({
            authorization: request.headers.authorization || "",
            body: Buffer.concat(chunks).toString("utf8")
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{\"ok\":true}");
        }, 10);
      });
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not start");
    const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    listApiVendorsMock.mockResolvedValue([
      vendor("codex-route", "key-codex", apiBaseUrl, true, "codex"),
      vendor("qoder-route", "key-qoder", apiBaseUrl, true, "qoder")
    ]);

    const codexRoute = await createVendorRoute("codex");
    const qoderRoute = await createVendorRoute("qoder");
    if (!codexRoute || !qoderRoute) throw new Error("routes were not created");
    const [codexResponse, qoderResponse] = await Promise.all([
      fetch(`${codexRoute.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${codexRoute.localToken}`, "content-type": "application/json" },
        body: '{"prompt":"codex-only"}'
      }),
      fetch(`${qoderRoute.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${qoderRoute.localToken}`, "content-type": "application/json" },
        body: '{"prompt":"qoder-only"}'
      })
    ]);

    expect(codexResponse.status).toBe(200);
    expect(qoderResponse.status).toBe(200);
    await Promise.all([codexResponse.text(), qoderResponse.text()]);
    expect(requests).toEqual(expect.arrayContaining([
      { authorization: "Bearer key-codex", body: '{"prompt":"codex-only"}' },
      { authorization: "Bearer key-qoder", body: '{"prompt":"qoder-only"}' }
    ]));
  });

  it("从 JSON 或 SSE 错误响应提取受限的具体错误信息", () => {
    expect(extractGatewayResponseError('{"error":{"message":"模型不存在"}}')).toBe("模型不存在");
    expect(extractGatewayResponseError('data: {"error":{"message":"请求被限流"}}\n\ndata: [DONE]\n\n')).toBe("请求被限流");
    expect(extractGatewayResponseError("Selected model is at capacity. Please try a different model.")).toContain("Selected model is at capacity");
    expect(extractGatewayResponseError("exceeded retry limit, last status: 429 Too Many Requests")).toContain("exceeded retry limit");
    expect(extractGatewayResponseError('{"data":"private response"}')).toBeUndefined();
    expect(extractGatewayResponseError('{"output_text":"The phrase rate limit is part of the answer."}')).toBeUndefined();
  });

  it("HTTP 200 携带容量或 429 错误时切换到下一个供应商", async () => {
    const authorizations: string[] = [];
    const upstream = createServer((request, response) => {
      const authorization = request.headers.authorization || "";
      authorizations.push(authorization);
      response.writeHead(200, { "content-type": "application/json" });
      if (authorization === "Bearer key-one") {
        response.end(JSON.stringify({ error: { message: "Selected model is at capacity. Please try a different model." } }));
      } else {
        response.end(JSON.stringify({ id: "ok", output: [] }));
      }
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not start");
    const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    listApiVendorsMock.mockResolvedValue([
      vendor("capacity", "key-one", apiBaseUrl, true),
      vendor("healthy", "key-two", apiBaseUrl, true)
    ]);

    const route = await createVendorRoute("codex");
    if (!route) throw new Error("route was not created");
    const response = await fetch(`${route.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${route.localToken}`, "content-type": "application/json" },
      body: '{"model":"gpt-test","input":"retry"}'
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"id":"ok"');
    expect(authorizations).toEqual(["Bearer key-one", "Bearer key-two"]);
  });

  it("HTTP 200 普通 JSON 内容包含限流短语时不应误切换", async () => {
    const authorizations: string[] = [];
    const upstream = createServer((request, response) => {
      authorizations.push(request.headers.authorization || "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output_text: "The phrase rate limit is part of the answer." }));
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not start");
    const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    listApiVendorsMock.mockResolvedValue([
      vendor("normal-one", "key-one", apiBaseUrl, true),
      vendor("normal-two", "key-two", apiBaseUrl, true)
    ]);

    const route = await createVendorRoute("codex");
    if (!route) throw new Error("route was not created");
    const response = await fetch(`${route.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${route.localToken}`, "content-type": "application/json" },
      body: '{"model":"gpt-test","input":"normal"}'
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("rate limit is part");
    expect(authorizations).toEqual(["Bearer key-one"]);
  });

  it("按 route token 转发并在切换后使用新供应商", async () => {
    const requests: Array<{ authorization?: string; body: string }> = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8")
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: {\"ok\":true}\n\n");
        response.end("data: [DONE]\n\n");
      });
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not start");
    const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    listApiVendorsMock.mockResolvedValue([
      vendor("one", "key-one", apiBaseUrl, true),
      vendor("two", "key-two", apiBaseUrl, true)
    ]);

    const route = await createVendorRoute("codex");
    if (!route) throw new Error("route was not created");
    const first = await fetch(`${route.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${route.localToken}`, "content-type": "application/json" },
      body: "{\"prompt\":\"one\"}"
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("[DONE]");
    expect(requests[0]).toEqual({ authorization: "Bearer key-one", body: '{"prompt":"one"}' });

    await switchVendorRoute(route.routeId, "codex", "two");
    const second = await fetch(`${route.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${route.localToken}`, "content-type": "application/json" },
      body: "{\"prompt\":\"two\"}"
    });
    expect(second.status).toBe(200);
    expect(requests[1].authorization).toBe("Bearer key-two");
  });

  it("正常请求保持当前供应商，不在候选池之间主动轮询", async () => {
    const authorizations: string[] = [];
    const upstream = createServer((request, response) => {
      authorizations.push(request.headers.authorization || "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"ok\":true}");
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not start");
    const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    listApiVendorsMock.mockResolvedValue([
      vendor("one", "key-one", apiBaseUrl, true),
      vendor("two", "key-two", apiBaseUrl, true)
    ]);

    const route = await createVendorRoute("codex");
    if (!route) throw new Error("route was not created");
    for (const prompt of ["one", "two"]) {
      const response = await fetch(`${route.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${route.localToken}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt })
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(authorizations).toEqual(["Bearer key-one", "Bearer key-one"]);
  });

  it("并发正常请求仍保持当前供应商粘性", async () => {
    const authorizations: string[] = [];
    const upstream = createServer((request, response) => {
      authorizations.push(request.headers.authorization || "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"ok\":true}");
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not start");
    const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    listApiVendorsMock.mockResolvedValue([
      vendor("sticky-one", "key-one", apiBaseUrl, true),
      vendor("sticky-two", "key-two", apiBaseUrl, true)
    ]);

    const route = await createVendorRoute("codex");
    if (!route) throw new Error("route was not created");
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => fetch(`${route.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${route.localToken}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: `concurrent-${index}` })
    })));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    await Promise.all(responses.map((response) => response.text()));
    expect(authorizations).toHaveLength(20);
    expect(authorizations.every((authorization) => authorization === "Bearer key-one")).toBe(true);
  });

  it("失败时按 sort 环形尝试候选供应商且不重复尝试", async () => {
    const authorizations: string[] = [];
    const upstream = createServer((request, response) => {
      const authorization = request.headers.authorization || "";
      authorizations.push(authorization);
      response.writeHead(authorization === "Bearer key-three" ? 200 : 500, { "content-type": "application/json" });
      response.end(authorization === "Bearer key-three" ? "{\"ok\":true}" : "{\"error\":\"down\"}");
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not start");
    const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    listApiVendorsMock.mockResolvedValue([
      vendor("first", "key-one", apiBaseUrl, true),
      vendor("second", "key-two", apiBaseUrl, true),
      vendor("third", "key-three", apiBaseUrl, true)
    ]);

    const route = await createVendorRoute("codex");
    if (!route) throw new Error("route was not created");
    const response = await fetch(`${route.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${route.localToken}`, "content-type": "application/json" },
      body: "{\"prompt\":\"retry\"}"
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(authorizations).toEqual(["Bearer key-one", "Bearer key-two", "Bearer key-three"]);
  });

  it("候选池只剩一个启用供应商时，不切换到已关闭供应商", async () => {
    const authorizations: string[] = [];
    const upstream = createServer((request, response) => {
      authorizations.push(request.headers.authorization || "");
      // 第一次请求开始后模拟用户关闭 second；故障转移必须重新读取候选池。
      if (authorizations.length === 1) {
        listApiVendorsMock.mockResolvedValue([
          vendor("first", "key-one", apiBaseUrl, true),
          vendor("second", "key-two", apiBaseUrl, false)
        ]);
        invalidateGatewayVendorSnapshot();
      }
      response.writeHead(500, { "content-type": "application/json" });
      response.end("{\"error\":\"down\"}");
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not start");
    const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    listApiVendorsMock.mockResolvedValue([
      vendor("first", "key-one", apiBaseUrl, true),
      vendor("second", "key-two", apiBaseUrl, true)
    ]);

    const route = await createVendorRoute("codex");
    if (!route) throw new Error("route was not created");
    const response = await fetch(`${route.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${route.localToken}`, "content-type": "application/json" },
      body: "{\"prompt\":\"retry\"}"
    });
    expect(response.status).toBe(500);
    await response.text();
    expect(authorizations.length).toBeGreaterThan(0);
    expect(authorizations.every((authorization) => authorization === "Bearer key-one")).toBe(true);
  });

  it("手动切换拒绝已关闭供应商", async () => {
    const first = vendor("first", "key-one", "https://example.com/v1", true);
    const second = vendor("second", "key-two", "https://example.com/v1", false);
    listApiVendorsMock.mockResolvedValue([first, second]);
    const route = await createVendorRoute("codex");
    if (!route) throw new Error("route was not created");

    const result = await switchVendorRoute(route.routeId, "codex", second.id);
    expect(result).toEqual({ switched: 0, reason: "vendor-disabled" });
    expect(route.vendorId).toBe(first.id);
  });

  it("锁定供应商后仅在同一供应商上重试，不故障转移到候选池", async () => {
    const authorizations: string[] = [];
    const upstream = createServer((request, response) => {
      authorizations.push(request.headers.authorization || "");
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"down"}');
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not start");
    const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    listApiVendorsMock.mockResolvedValue([
      vendor("locked", "key-one", apiBaseUrl, true),
      vendor("candidate", "key-two", apiBaseUrl, true)
    ]);

    const route = await createVendorRoute("codex");
    if (!route) throw new Error("route was not created");
    expect(await setVendorRoute(route.routeId, "codex", { mode: "locked" })).toEqual({
      switched: 1,
      vendorId: "locked",
      mode: "locked"
    });

    const response = await fetch(`${route.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${route.localToken}`, "content-type": "application/json" },
      body: '{"prompt":"retry"}'
    });
    expect(response.status).toBe(500);
    await response.text();
    expect(authorizations.length).toBeGreaterThan(0);
    expect(authorizations.every((authorization) => authorization === "Bearer key-one")).toBe(true);
  });

  it("锁定供应商拒绝已关闭的候选项", async () => {
    const first = vendor("first", "key-one", "https://example.com/v1", true);
    const second = vendor("second", "key-two", "https://example.com/v1", false);
    listApiVendorsMock.mockResolvedValue([first, second]);
    const route = await createVendorRoute("codex");
    if (!route) throw new Error("route was not created");

    expect(await setVendorRoute(route.routeId, "codex", { vendorId: second.id, mode: "locked" })).toEqual({
      switched: 0,
      reason: "vendor-disabled"
    });
    expect(route.vendorId).toBe(first.id);
    expect(route.mode).toBe("dynamic");
  });

  it("拒绝错误 route token", async () => {
    listApiVendorsMock.mockResolvedValue([vendor("one", "key-one", "https://example.com/v1", true)]);
    const route = await createVendorRoute("codex");
    if (!route) throw new Error("route was not created");
    const response = await fetch(`${route.baseUrl}/v1/responses`, {
      headers: { authorization: "Bearer wrong-token" }
    });
    expect(response.status).toBe(401);
    await destroyVendorRoute(route.routeId);
  });
});

function vendor(id: string, apiKey: string, apiBaseUrl: string, enabled: boolean, providerId: AiProviderId = "codex") {
  return {
    id,
    providerId,
    name: id,
    apiKey,
    apiBaseUrl,
    configs: [],
    enabled,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
