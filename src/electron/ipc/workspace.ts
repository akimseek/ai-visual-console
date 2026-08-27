import { ipcMain } from "electron";
import {
  deleteCompressionPrompt,
  deleteWorkspacePreset,
  listCompressionPrompts,
  listWorkspacePresets,
  saveCompressionPrompt,
  saveWorkspacePreset
} from "../settings";
import { requireString, requireWorkspacePresetInput, requireCompressionPromptInput } from "../ipcValidation";

export function registerWorkspaceIpcHandlers() {
  ipcMain.handle("workspace:list-presets", () => listWorkspacePresets());
  ipcMain.handle("workspace:save-preset", (_event, input: unknown) =>
    saveWorkspacePreset(requireWorkspacePresetInput(input))
  );
  ipcMain.handle("workspace:delete-preset", (_event, presetId: unknown) =>
    deleteWorkspacePreset(requireString(presetId, "presetId"))
  );
  ipcMain.handle("compression-prompt:list", () => listCompressionPrompts());
  ipcMain.handle("compression-prompt:save", (_event, input: unknown) =>
    saveCompressionPrompt(requireCompressionPromptInput(input))
  );
  ipcMain.handle("compression-prompt:delete", (_event, promptId: unknown) =>
    deleteCompressionPrompt(requireString(promptId, "promptId"))
  );
}
