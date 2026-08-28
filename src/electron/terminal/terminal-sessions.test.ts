import { describe, expect, it } from "vitest";
import { buildCodexInvocation, buildTerminalEnvironment } from "./terminal-sessions";

const route = {
  routeId: "route-id",
  providerId: "codex" as const,
  vendorId: "vendor-id",
  localToken: "token",
  baseUrl: "http://127.0.0.1:1234/gateway/codex/route-id"
};

describe("Codex Gateway command", () => {
  it("通过命令行覆盖路由 provider，不创建专用 CODEX_HOME", () => {
    expect(buildCodexInvocation(["resume", "session-id"], route))
      .toBe("codex '-c' 'model_provider=\"akim_gateway\"' '-c' 'model_providers.akim_gateway.name=\"akim_gateway\"' '-c' 'model_providers.akim_gateway.wire_api=\"responses\"' '-c' 'model_providers.akim_gateway.requires_openai_auth=true' '-c' 'model_providers.akim_gateway.env_key=\"OPENAI_API_KEY\"' '-c' 'model_providers.akim_gateway.base_url=\"http://127.0.0.1:1234/gateway/codex/route-id\"' 'resume' 'session-id'");
  });

  it("路由环境覆盖继承的 Codex 凭证，避免发送旧 bearer token", () => {
    const previousCodexKey = process.env.CODEX_API_KEY;
    const previousAccessToken = process.env.CODEX_ACCESS_TOKEN;
    process.env.CODEX_API_KEY = "old-codex-key";
    process.env.CODEX_ACCESS_TOKEN = "old-access-token";
    try {
      const environment = buildTerminalEnvironment({ OPENAI_API_KEY: "route-token" });
      expect(environment.OPENAI_API_KEY).toBe("route-token");
      expect(environment.CODEX_API_KEY).toBeUndefined();
      expect(environment.CODEX_ACCESS_TOKEN).toBeUndefined();
    } finally {
      if (previousCodexKey === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = previousCodexKey;
      if (previousAccessToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
      else process.env.CODEX_ACCESS_TOKEN = previousAccessToken;
    }
  });
});
