import type { AiProviderId } from "../../shared/types";
import type { SessionFileKind } from "./session-file-ops";
import { getWslDistroFromProviderTarget } from "../../shared/target-ids";

export type ProviderTargetContext = {
  targetId: string;
  kind: SessionFileKind;
  distro?: string;
  configDir: string;
};

export type ProviderTargetContextOptions = {
  provider: AiProviderId;
  localTargetId: string;
  localConfigDir: string;
  resolveWslConfigDir: (distro: string) => Promise<string>;
  displayName: string;
};

// 统一 Provider 的本地/WSL targetId 解析；配置目录仍由各 Provider 提供，避免混入供应商布局规则。
export async function resolveProviderTargetContext(
  targetId: string,
  options: ProviderTargetContextOptions
): Promise<ProviderTargetContext> {
  if (targetId === options.localTargetId) {
    return {
      targetId,
      kind: "local",
      configDir: options.localConfigDir
    };
  }

  const distro = getWslDistroFromProviderTarget(options.provider, targetId);
  if (distro) {
    return {
      targetId,
      kind: "wsl",
      distro,
      configDir: await options.resolveWslConfigDir(distro)
    };
  }

  throw new Error(`未知 ${options.displayName} 目标：${targetId}`);
}
