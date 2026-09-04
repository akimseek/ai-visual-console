// targetId 生成与解析的唯一入口（纯字符串逻辑，无 Node 内置依赖，主进程与渲染进程均可安全引用）。
// 格式：codex 为裸 `wsl:<distro>`（历史原因），其余 provider 为 `<provider>:wsl:<distro>`。
import type { AiProviderId } from "./types";

// 从 targetId 中解析出 WSL 发行版名称，兼容各平台前缀；非 WSL 目标返回空串。
export function getWslDistroFromTargetId(targetId: string) {
  if (targetId.startsWith("gemini:wsl:")) return targetId.slice("gemini:wsl:".length);
  if (targetId.startsWith("claude:wsl:")) return targetId.slice("claude:wsl:".length);
  if (targetId.startsWith("qoder:wsl:")) return targetId.slice("qoder:wsl:".length);
  if (targetId.startsWith("wsl:")) return targetId.slice("wsl:".length);
  return "";
}

// 解析特定 provider 的 WSL targetId（`gemini:wsl:<distro>` 等；codex 历史上为裸 `wsl:`）。
// 只认该 provider 自己的前缀，避免把别的 provider 的 WSL 目标误判为本平台目标；非匹配返回空串。
export function getWslDistroFromProviderTarget(provider: AiProviderId, targetId: string) {
  const prefix = provider === "codex" ? "wsl:" : `${provider}:wsl:`;
  return targetId.startsWith(prefix) ? targetId.slice(prefix.length) : "";
}

// 生成 provider 的 WSL targetId，与 getWslDistroFromProviderTarget 互逆。
export function buildWslProviderTargetId(provider: AiProviderId, distro: string) {
  return provider === "codex" ? `wsl:${distro}` : `${provider}:wsl:${distro}`;
}

// 从 targetId 解析 provider：gemini/claude/qoder 带自身前缀，codex 历史上为裸前缀。
export function getProviderIdFromTargetId(targetId: string): AiProviderId {
  if (targetId.startsWith("gemini:")) return "gemini";
  if (targetId.startsWith("claude:")) return "claude";
  if (targetId.startsWith("qoder:")) return "qoder";
  if (targetId.startsWith("codex:")) return "codex";
  return "codex";
}
