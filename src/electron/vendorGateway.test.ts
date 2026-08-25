import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";

const listApiVendorsMock = vi.hoisted(() => vi.fn());
vi.mock("./vendorManager", () => ({ listApiVendors: listApiVendorsMock }));

import {
  createVendorRoute,
  destroyVendorRoute,
  stopVendorGateway,
  switchVendorRoute
} from "./vendorGateway";

const servers: Server[] = [];

afterEach(async () => {
  await stopVendorGateway();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.clearAllMocks();
});

describe("vendor gateway", () => {
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
      vendor("two", "key-two", apiBaseUrl, false)
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

    switchVendorRoute(route.routeId, "codex", "two");
    const second = await fetch(`${route.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${route.localToken}`, "content-type": "application/json" },
      body: "{\"prompt\":\"two\"}"
    });
    expect(second.status).toBe(200);
    expect(requests[1].authorization).toBe("Bearer key-two");
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
