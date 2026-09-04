import { ipcMain } from 'electron';
import { checkCliEnvironment, installCli } from '../cli/cli-installer';
import { listProviderSummaries } from '../providers/ai-providers';
import { requireCliEnvironmentRequest, requireCliInstallRequest } from './validation';

/** 注册 Provider 列表和 CLI 管理相关的 IPC 处理器。 */
export function registerCliIpcHandlers() {
  ipcMain.handle('ai:list-providers', () => listProviderSummaries());
  ipcMain.handle('cli:check-environment', (_event, request: unknown) =>
    checkCliEnvironment(requireCliEnvironmentRequest(request))
  );
  ipcMain.handle('cli:install', (_event, request: unknown) => installCli(requireCliInstallRequest(request)));
}
