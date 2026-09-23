import { describe, expect, it, vi } from "vitest";
import { createAppApi } from "./app-api";
import { createGatewayApi } from "./gateway-api";
import { createSessionApi } from "./session-api";
import { createSkillApi } from "./skill-api";
import { createTerminalApi } from "./terminal-api";
import { createVendorApi } from "./vendor-api";

function createIpcMock() {
  return {
    invoke: vi.fn(async () => undefined),
    on: vi.fn(),
    off: vi.fn()
  } as never;
}

describe("preload 业务域 API", () => {
  it("保留原有对外 API 方法，并使用原 IPC channel", async () => {
    const ipc = createIpcMock();
    const api = {
      ...createAppApi(ipc),
      ...createGatewayApi(ipc),
      ...createVendorApi(ipc),
      ...createSessionApi(ipc),
      ...createSkillApi(ipc),
      ...createTerminalApi(ipc)
    };

    expect(Object.keys(api).sort()).toEqual([
      "appCommand",
      "branchSession",
      "checkCliEnvironment",
      "chooseExitAction",
      "chooseDirectory",
      "deleteGatewayLogEntries",
      "deleteGatewayFailoverRule",
      "clearWslCodexHome",
      "copyText",
      "deleteApiVendor",
      "deleteCompressionPrompt",
      "deleteSession",
      "deleteSessions",
      "deleteSkill",
      "deleteWorkspacePreset",
      "duplicateSession",
      "enableApiVendor",
      "exportSession",
      "getGatewayFailureDiagnostics",
      "listGatewayFailoverRules",
      "getGatewayPort",
      "getGatewayExternalApiStatus",
      "setGatewayEnabled",
      "setGatewayExternalApiEnabled",
      "rotateGatewayExternalApiToken",
      "getGatewayRecentFailures",
      "getGatewayUsageSummary",
      "getGatewayUsageReport",
      "getGatewayVendorHealth",
      "getSession",
      "getSessionMessagesPage",
      "getSessionSummary",
      "importSkill",
      "installCli",
      "listApiVendors",
      "listCachedSessions",
      "listCachedTargets",
      "listCompressionPrompts",
      "listModels",
      "listProviders",
      "listSessionChildren",
      "listSessionQuickAccess",
      "listSessions",
      "listSkills",
      "listTargets",
      "listTrashSessions",
      "listTrashSkills",
      "listVendorModels",
      "listWorkspacePresets",
      "logPerformance",
      "onGatewayRequestRecorded",
      "onGatewayVendorSwitched",
      "onTerminalData",
      "onTerminalExit",
      "onTerminalStatus",
      "onTerminalAttentionNotificationClicked",
      "onExitConfirmationRequested",
      "openPath",
      "openSessionFolder",
      "openSkillFolder",
      "pathExists",
      "purgeSession",
      "purgeSessions",
      "purgeSkill",
      "readApiVendorConfigs",
      "readText",
      "refreshVendorBalance",
      "refreshVendorBalances",
      "resetGatewayVendorHealth",
      "resizeTerminal",
      "restoreSession",
      "restoreSkill",
      "saveApiVendor",
      "saveGatewayFailoverRule",
      "saveCompressionPrompt",
      "saveWorkspacePreset",
      "searchSessions",
      "queryGatewayLogs",
      "setApiVendorEnabled",
      "setVendorRouteMode",
      "setGatewayFailoverRuleEnabled",
      "setGatewayPort",
      "setSessionCustomTitle",
      "setSessionFavorite",
      "setSkillEnabled",
      "setWslCodexHome",
      "markSessionOpened",
      "startSystemTerminal",
      "startTerminal",
      "stopTerminal",
      "notifyTerminalAttention",
      "switchVendorRoute",
      "writeTerminal"
    ].sort());

    await api.listModels("gemini:local");
    expect(ipc.invoke).toHaveBeenCalledWith("models:list", "gemini:local");
  });
});
