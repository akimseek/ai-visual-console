import { describe, expect, it } from "vitest";
import {
  buildWslProviderTargetId,
  getProviderIdFromTargetId,
  getWslDistroFromProviderTarget,
  getWslDistroFromTargetId
} from "./target-ids";

describe("getWslDistroFromTargetId", () => {
  it("解析裸 wsl: 前缀", () => {
    expect(getWslDistroFromTargetId("wsl:Ubuntu-22.04")).toBe("Ubuntu-22.04");
  });

  it("解析 gemini:/claude: 复合前缀", () => {
    expect(getWslDistroFromTargetId("gemini:wsl:Debian")).toBe("Debian");
    expect(getWslDistroFromTargetId("claude:wsl:Arch")).toBe("Arch");
    expect(getWslDistroFromTargetId("qoder:wsl:Fedora")).toBe("Fedora");
  });

  it("非 WSL 目标返回空串", () => {
    expect(getWslDistroFromTargetId("local")).toBe("");
    expect(getWslDistroFromTargetId("gemini:local")).toBe("");
    expect(getWslDistroFromTargetId("")).toBe("");
  });

  it("发行版名内含冒号时只剥离已知前缀", () => {
    expect(getWslDistroFromTargetId("wsl:a:b")).toBe("a:b");
  });
});

describe("getWslDistroFromProviderTarget", () => {
  it("只认本 provider 的前缀", () => {
    expect(getWslDistroFromProviderTarget("gemini", "gemini:wsl:Debian")).toBe("Debian");
    expect(getWslDistroFromProviderTarget("codex", "wsl:Ubuntu")).toBe("Ubuntu");
  });

  it("拒绝其他 provider 的 WSL 目标", () => {
    expect(getWslDistroFromProviderTarget("gemini", "claude:wsl:Debian")).toBe("");
    expect(getWslDistroFromProviderTarget("codex", "gemini:wsl:Debian")).toBe("");
    expect(getWslDistroFromProviderTarget("gemini", "wsl:Debian")).toBe("");
  });

  it("本地目标返回空串", () => {
    expect(getWslDistroFromProviderTarget("claude", "claude:local")).toBe("");
  });
});

describe("getProviderIdFromTargetId", () => {
  it("按前缀解析 provider", () => {
    expect(getProviderIdFromTargetId("gemini:local")).toBe("gemini");
    expect(getProviderIdFromTargetId("claude:wsl:Debian")).toBe("claude");
    expect(getProviderIdFromTargetId("qoder:local")).toBe("qoder");
    expect(getProviderIdFromTargetId("codex:local")).toBe("codex");
  });

  it("codex 的裸前缀 targetId 归属 codex", () => {
    expect(getProviderIdFromTargetId("local")).toBe("codex");
    expect(getProviderIdFromTargetId("wsl:Ubuntu")).toBe("codex");
  });
});

describe("buildWslProviderTargetId", () => {
  it("与解析函数互逆", () => {
    for (const provider of ["codex", "gemini", "claude", "qoder"] as const) {
      const targetId = buildWslProviderTargetId(provider, "Ubuntu-22.04");
      expect(getWslDistroFromProviderTarget(provider, targetId)).toBe("Ubuntu-22.04");
    }
  });

  it("codex 使用裸 wsl: 前缀，其余 provider 带前缀", () => {
    expect(buildWslProviderTargetId("codex", "Debian")).toBe("wsl:Debian");
    expect(buildWslProviderTargetId("gemini", "Debian")).toBe("gemini:wsl:Debian");
  });
});
