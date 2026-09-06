import { describe, expect, it } from "vitest";
import { getProvider, getProviderForTarget, listAiProviders, listProviderSummaries, type AiProvider } from "./ai-providers";

// 所有 Provider 都必须实现统一分发层使用的会话操作；平台不支持的能力也要保留明确的拒绝实现。
const REQUIRED_PROVIDER_METHODS: Array<keyof Omit<AiProvider, "id" | "label" | "capabilities">> = [
  "listCachedTargets",
  "listTargets",
  "listCachedSessions",
  "listSessions",
  "listTrashSessions",
  "searchSessions",
  "getSession",
  "getSessionMessagesPage",
  "getSessionSummary",
  "listSessionsByParent",
  "getSessionFolderPath",
  "branchSession",
  "duplicateSession",
  "deleteSession",
  "deleteSessions",
  "restoreSession",
  "purgeSession",
  "purgeSessions"
];

describe("AI Provider 公共契约", () => {
  it("每个平台都注册完整的会话操作方法", () => {
    const providers = listAiProviders();
    expect(providers.map((provider) => provider.id)).toEqual(["codex", "gemini", "claude", "qoder"]);
    expect(new Set(providers.map((provider) => provider.id)).size).toBe(providers.length);

    for (const provider of providers) {
      expect(provider.label.trim()).not.toBe("");
      for (const method of REQUIRED_PROVIDER_METHODS) {
        expect(typeof provider[method]).toBe("function");
      }
    }
  });

  it("能力矩阵与注册的平台保持一致", () => {
    expect(listProviderSummaries()).toEqual([
      {
        id: "codex",
        label: "Codex",
        capabilities: {
          skills: true,
          branch: true,
          usage: true,
          trash: true,
          batchActions: true,
          customCwd: true,
          export: true,
          sessionSettings: true,
          duplicate: true,
          vendorManagement: true
        }
      },
      {
        id: "gemini",
        label: "Gemini",
        capabilities: {
          skills: false,
          branch: true,
          usage: true,
          trash: true,
          batchActions: true,
          customCwd: true,
          export: true,
          sessionSettings: false,
          duplicate: true,
          vendorManagement: true
        }
      },
      {
        id: "claude",
        label: "Claude Code",
        capabilities: {
          skills: false,
          branch: true,
          usage: true,
          trash: true,
          batchActions: true,
          customCwd: true,
          export: true,
          sessionSettings: false,
          duplicate: true,
          vendorManagement: true
        }
      },
      {
        id: "qoder",
        label: "Qoder CN",
        capabilities: {
          skills: false,
          branch: false,
          usage: true,
          trash: true,
          batchActions: true,
          customCwd: true,
          export: true,
          sessionSettings: false,
          duplicate: false,
          vendorManagement: false
        }
      }
    ]);
  });

  it("按本地和 WSL targetId 分发到正确的平台", () => {
    expect(getProviderForTarget("local").id).toBe("codex");
    expect(getProviderForTarget("gemini:local").id).toBe("gemini");
    expect(getProviderForTarget("claude:wsl:Ubuntu").id).toBe("claude");
    expect(getProviderForTarget("qoder:wsl:Ubuntu").id).toBe("qoder");
  });

  it("Qoder 的不支持能力会明确拒绝调用", async () => {
    const qoder = getProvider("qoder");

    await expect(qoder.branchSession("qoder:local", "session-1", 1)).rejects.toThrow("当前不支持");
    await expect(qoder.duplicateSession("qoder:local", "session-1")).rejects.toThrow("当前不支持");
  });
});
