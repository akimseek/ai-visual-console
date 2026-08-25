import { describe, expect, it } from "vitest";
import { buildCodexInvocation, buildWslCodexRouteSetup } from "./terminalSessions";

const route = {
  routeId: "route-id",
  providerId: "codex" as const,
  vendorId: "vendor-id",
  localToken: "token",
  baseUrl: "http://127.0.0.1:1234/gateway/codex/route-id",
  codexHome: "/tmp/ai-vendor-route"
};

describe("Codex Gateway command", () => {
  it("在交互 shell 中以路由专用 CODEX_HOME 执行 Codex", () => {
    expect(buildCodexInvocation(["resume", "session-id"], route))
      .toBe("env 'CODEX_HOME=/tmp/ai-vendor-route' 'codex' 'resume' 'session-id'");
  });

  it("在 WSL 中将 Windows 临时目录转换为 WSL 路径", () => {
    expect(buildCodexInvocation([], { ...route, codexHome: "C:\\Users\\akim\\AppData\\Local\\Temp\\route" }, true))
      .toBe("env CODEX_HOME='/mnt/c/Users/akim/AppData/Local/Temp/route' 'codex'");
  });

  it("在 WSL 中把会话存储链接回原始 Codex 目录", () => {
    expect(buildWslCodexRouteSetup({ ...route, codexHome: "C:\\Temp\\route" }, "/home/akim/.codex"))
      .toContain("mkdir -p -- '/mnt/c/Temp/route'");
    expect(buildWslCodexRouteSetup({ ...route, codexHome: "C:\\Temp\\route" }, "/home/akim/.codex"))
      .toContain("'/mnt/c/Temp/route/sessions'");
  });
});
