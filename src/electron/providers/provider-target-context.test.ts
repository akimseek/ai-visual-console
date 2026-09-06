import { describe, expect, it, vi } from "vitest";
import { resolveProviderTargetContext } from "./provider-target-context";

describe("resolveProviderTargetContext", () => {
  const options = {
    provider: "gemini" as const,
    localTargetId: "gemini:local",
    localConfigDir: "C:/Users/test/.gemini",
    resolveWslConfigDir: vi.fn(async (distro: string) => `/home/${distro}/.gemini`),
    displayName: "Gemini"
  };

  it("解析本地目标且不调用 WSL 配置目录解析器", async () => {
    await expect(resolveProviderTargetContext("gemini:local", options)).resolves.toEqual({
      targetId: "gemini:local",
      kind: "local",
      configDir: "C:/Users/test/.gemini"
    });
    expect(options.resolveWslConfigDir).not.toHaveBeenCalled();
  });

  it("只解析当前 Provider 的 WSL 前缀并返回发行版配置目录", async () => {
    await expect(resolveProviderTargetContext("gemini:wsl:Ubuntu", options)).resolves.toEqual({
      targetId: "gemini:wsl:Ubuntu",
      kind: "wsl",
      distro: "Ubuntu",
      configDir: "/home/Ubuntu/.gemini"
    });
    expect(options.resolveWslConfigDir).toHaveBeenCalledWith("Ubuntu");
  });

  it("拒绝其他 Provider 或未知格式的目标", async () => {
    await expect(resolveProviderTargetContext("claude:wsl:Ubuntu", options)).rejects.toThrow("未知 Gemini 目标");
    await expect(resolveProviderTargetContext("gemini:unknown", options)).rejects.toThrow("未知 Gemini 目标");
  });
});
