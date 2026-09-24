import { ipcMain } from "electron";
import { deleteWorkspacePreset, listWorkspacePresets, saveWorkspacePreset } from "../core/settings";
import { requireString, requireWorkspacePresetInput } from "./validation";

export function registerWorkspaceIpcHandlers() {
  ipcMain.handle("workspace:list-presets", () => listWorkspacePresets());
  ipcMain.handle("workspace:save-preset", (_event, input: unknown) =>
    saveWorkspacePreset(requireWorkspacePresetInput(input))
  );
  ipcMain.handle("workspace:delete-preset", (_event, presetId: unknown) =>
    deleteWorkspacePreset(requireString(presetId, "presetId"))
  );
}
