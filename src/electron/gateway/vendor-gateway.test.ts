import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";

const listApiVendorsMock = vi.hoisted(() => vi.fn());
vi.mock("../vendors/vendor-manager", () => ({ listApiVendors: listApiVendorsMock }));

import {
  createVendorRoute,
  destroyVendorRoute,
  extractGatewayResponseError,
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
  it("从 JSON 或 SSE 错误响应提取受限的具体错误信息", () => {
    expect(extractGatewayResponseError('{"error":{"message":"模型不存在"}}')).toBe("模型不存在");
    expect(extractGatewayResponseError('data: {"error":{"message":"请求被限流"}}\n\ndata: [DONE]\n\n')).toBe("请求被限流");
    expect(extractGatewayResponseError('{"data":"private response"}')).toBeUndefined();
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

function vendor(id: string, apiKey: string, apiBaseUrl: string, enabled: boolean) {
  return {
    id,
    providerId: "codex" as const,
    name: id,
    apiKey,
    apiBaseUrl,
    configs: [],
    enabled,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
