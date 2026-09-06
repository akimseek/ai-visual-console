import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearGatewayFileLogs,
  deleteGatewayFileEntries,
  flushGatewayLogs,
  getGatewayFileCleanupEntries,
  getRecentGatewayEvents,
  getRecentGatewayRequests,
  logGatewayEvent,
  recordGatewayRequest,
  setGatewayLogPath
} from "./gateway-log";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  setGatewayLogPath("");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("gateway file logs", () => {
  it("queries entries with stable IDs and deletes only selected lines", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-log-select-"));
    temporaryDirectories.push(directory);
    setGatewayLogPath(directory);
    await fs.writeFile(path.join(directory, "gateway.log"), [
      JSON.stringify({ ts: "2026-09-06T08:00:00.000Z", routeId: "r1", provider: "codex", vendorId: "vendor-a", method: "POST", path: "/v1/responses", outcome: "error", durationMs: 10 }),
      JSON.stringify({ ts: "2026-09-06T08:30:00.000Z", routeId: "r2", provider: "codex", vendorId: "vendor-b", method: "POST", path: "/v1/responses", outcome: "ok", durationMs: 20 })
    ].join("\n"), "utf8");

    const entries = await getGatewayFileCleanupEntries({});
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ source: "file", fileName: "gateway.log" });
    const result = await deleteGatewayFileEntries([entries[0].id]);
    const remaining = await fs.readFile(path.join(directory, "gateway.log"), "utf8");

    expect(result.deletedEntries).toBe(1);
    expect(remaining).toContain("vendor-b");
    expect(remaining).not.toContain("vendor-a");
  });

  it("removes only file entries matching the cleanup filter", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-log-filter-"));
    temporaryDirectories.push(directory);
    setGatewayLogPath(directory);
    await fs.writeFile(path.join(directory, "gateway.log"), [
      JSON.stringify({ ts: "2026-09-06T08:00:00.000Z", routeId: "r1", provider: "codex", vendorId: "vendor-a", method: "POST", path: "/v1/responses", outcome: "error" }),
      JSON.stringify({ ts: "2026-09-06T08:30:00.000Z", routeId: "r2", provider: "codex", vendorId: "vendor-b", method: "POST", path: "/v1/responses", outcome: "ok" }),
      "not-json"
    ].join("\n"), "utf8");

    const result = await clearGatewayFileLogs({ vendorId: "vendor-a", outcome: "error" });
    const remaining = await fs.readFile(path.join(directory, "gateway.log"), "utf8");

    expect(result.deletedEntries).toBe(1);
    expect(remaining).toContain("vendor-b");
    expect(remaining).toContain("not-json");
    expect(remaining).not.toContain("vendor-a");
  });

  it("clears rotated files, pending entries, and recent entries", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gateway-log-"));
    temporaryDirectories.push(directory);
    setGatewayLogPath(directory);
    recordGatewayRequest({
      routeId: "route-1",
      provider: "codex",
      vendorId: "vendor-1",
      method: "POST",
      path: "/v1/responses",
      durationMs: 10,
      outcome: "ok"
    });
    logGatewayEvent("info", "test-event");
    await flushGatewayLogs();
    await fs.writeFile(path.join(directory, "gateway.log.1"), "rotated\n", "utf8");

    const result = await clearGatewayFileLogs();

    expect(result.deletedFiles).toBe(2);
    await expect(fs.stat(path.join(directory, "gateway.log"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(directory, "gateway.log.1"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(getRecentGatewayRequests()).toEqual([]);
    expect(getRecentGatewayEvents()).toEqual([]);
  });
});
