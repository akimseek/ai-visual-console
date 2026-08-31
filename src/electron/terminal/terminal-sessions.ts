import type { BrowserWindow } from "electron";
import { createRequire } from "node:module";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AiProviderId, SystemTerminalStartRequest, TerminalStartParams } from "../types";
import {
  buildCmdCommand,
  buildPosixShellCommand as buildShellCommand,
  parseCliArgs,
  posixShellQuote as shellQuote
} from "../../shared/shell-args";
import { getWslDistroFromTargetId, wslMountPathToWindowsPath } from "../../shared/wsl-paths";
import {
  buildRouteUrl,
  createVendorRoute,
  destroyVendorRoute,
  resolveWslGatewayBaseUrl,
  switchVendorRoute,
  bindVendorRouteTerminal,
  type VendorRoute
} from "../gateway/vendor-gateway";

type TerminalSession = {
  id: string;
  pty: import("node-pty").IPty;
  window: BrowserWindow;
  // 按块暂存 PTY 输出，避免大段历史恢复期间反复复制累计字符串。
  outputChunks: string[];
  outputTimer?: NodeJS.Timeout;
  vendorRouteId?: string;
  resumeKey?: string;
};

type TerminalCommand = {
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
};

type TerminalProvider = {
  id: AiProviderId;
  canHandle: (targetId: string) => boolean;
  buildCommand: (params: TerminalStartParams & { vendorRoute?: VendorRoute }) => Promise<TerminalCommand>;
  supportsVendorGateway?: boolean;
};

const sessions = new Map<string, TerminalSession>();
// 同一目标下同一历史会话只能存在一个 Codex resume 写入者，避免 CLI 返回 active writer。
const pendingResumeKeys = new Set<string>();
const activeResumeKeys = new Set<string>();
const requireFromHere = createRequire(__filename);

const codexTerminalProvider: TerminalProvider = {
  id: "codex",
  canHandle: (targetId) => !targetId.startsWith("gemini:") && !targetId.startsWith("claude:"),
  buildCommand: buildCodexCommand
};

const geminiTerminalProvider: TerminalProvider = {
  id: "gemini",
  canHandle: (targetId) => targetId.startsWith("gemini:"),
  buildCommand: buildGeminiCommand
};

const claudeTerminalProvider: TerminalProvider = {
  id: "claude",
  canHandle: (targetId) => targetId.startsWith("claude:"),
  buildCommand: buildClaudeCommand
};

const qoderTerminalProvider: TerminalProvider = {
  id: "qoder",
  canHandle: (targetId) => targetId.startsWith("qoder:"),
  buildCommand: buildQoderCommand,
  supportsVendorGateway: false
};

const terminalProviders: TerminalProvider[] = [qoderTerminalProvider, claudeTerminalProvider, geminiTerminalProvider, codexTerminalProvider];

export async function startTerminalSession(
  window: BrowserWindow,
  params: TerminalStartParams & { cols?: number; rows?: number }
) {
  const provider = resolveTerminalProvider(params.targetId);
  const resumeKey = params.sessionId ? `${params.targetId}\0${params.sessionId}` : undefined;
  if (resumeKey && (pendingResumeKeys.has(resumeKey) || activeResumeKeys.has(resumeKey))) {
    throw new Error("该历史会话正在打开，请勿重复操作。");
  }
  if (resumeKey) pendingResumeKeys.add(resumeKey);
  let route: VendorRoute | undefined;
  try {
    route = provider.supportsVendorGateway !== false
      ? await createVendorRoute(provider.id, params.vendorId, window)
      : undefined;
    const command = await provider.buildCommand({ ...params, vendorRoute: route });
    const result = await startPtySession(
      window,
      command,
      params.cols,
      params.rows,
      route?.routeId,
      resumeKey,
      route?.vendorId
    );
    if (route) bindVendorRouteTerminal(route.routeId, result.terminalId);
    return result;
  } catch (error) {
    if (route) await destroyVendorRoute(route.routeId);
    if (resumeKey) pendingResumeKeys.delete(resumeKey);
    throw error;
  }
}

export async function startSystemTerminalSession(
  window: BrowserWindow,
  params: SystemTerminalStartRequest & { cols?: number; rows?: number }
) {
  return startPtySession(window, await buildSystemTerminalCommand(params), params.cols, params.rows);
}

async function startPtySession(
  window: BrowserWindow,
  command: TerminalCommand,
  cols?: number,
  rows?: number,
  vendorRouteId?: string,
  resumeKey?: string,
  vendorId?: string
) {
  const pty = loadNodePty();
  const terminalId = crypto.randomUUID();
  const child = pty.spawn(command.file, command.args, {
    name: "xterm-256color",
    cols: cols || 100,
    rows: rows || 30,
    cwd: command.cwd,
    env: buildTerminalEnvironment(command.env)
  });

  const session: TerminalSession = {
    id: terminalId,
    pty: child,
    window,
    outputChunks: [],
    vendorRouteId,
    resumeKey
  };
  sessions.set(terminalId, session);
  if (resumeKey) {
    pendingResumeKeys.delete(resumeKey);
    activeResumeKeys.add(resumeKey);
  }

  child.onData((data) => {
    queueTerminalOutput(session, data);
  });
  child.onExit(({ exitCode }) => {
    flushTerminalOutput(session);
    sessions.delete(terminalId);
    if (session.resumeKey) pendingResumeKeys.delete(session.resumeKey);
    if (session.resumeKey) activeResumeKeys.delete(session.resumeKey);
    if (session.vendorRouteId) void destroyVendorRoute(session.vendorRouteId);
    sendToWindow(window, "terminal:exit", terminalId, exitCode);
  });

  return { terminalId, vendorId };
}

/**
 * Build the child environment while preventing credentials inherited from the
 * desktop process from taking precedence over the credentials injected for a
 * Gateway route. Codex recognizes several auth environment variables; leaving
 * CODEX_API_KEY/CODEX_ACCESS_TOKEN alongside OPENAI_API_KEY can make it send a
 * different bearer token than the one the local route generated.
 */
export function buildTerminalEnvironment(overrides?: Record<string, string>) {
  const environment: Record<string, string> = { ...process.env } as Record<string, string>;
  if (overrides?.OPENAI_API_KEY) {
    delete environment.CODEX_API_KEY;
    delete environment.CODEX_ACCESS_TOKEN;
  }
  environment.TERM = "xterm-256color";
  Object.assign(environment, overrides);
  return environment;
}

async function buildSystemTerminalCommand(params: SystemTerminalStartRequest): Promise<TerminalCommand> {
  const cwd = params.cwd?.trim() || os.homedir();
  const distro = getWslDistroFromTargetId(params.targetId || "");
  const kind = params.kind || "auto";
  if ((kind === "wsl" || kind === "auto") && distro) {
    const command = params.cwd?.trim()
      ? `cd ${shellQuote(params.cwd.trim())} && exec bash -il`
      : "exec bash -il";
    return {
      file: "wsl.exe",
      args: ["-d", distro, "--", "bash", "-lc", command],
      cwd: os.homedir()
    };
  }
  if (kind === "wsl-default") {
    const command = params.cwd?.trim()
      ? `cd ${shellQuote(params.cwd.trim())} && exec bash -il`
      : "exec bash -il";
    return {
      file: "wsl.exe",
      args: ["--", "bash", "-lc", command],
      cwd: os.homedir()
    };
  }
  if (process.platform === "win32" && (kind === "powershell" || kind === "auto")) {
    return {
      file: "powershell.exe",
      args: ["-NoLogo"],
      cwd: toWindowsShellCwd(cwd)
    };
  }
  if (process.platform === "win32" && kind === "cmd") {
    return {
      file: "cmd.exe",
      args: ["/d"],
      cwd: toWindowsShellCwd(cwd)
    };
  }
  if (process.platform === "win32" && kind === "git-bash") {
    return {
      file: resolveGitBashPath(),
      args: ["--login", "-i"],
      cwd: toWindowsShellCwd(cwd)
    };
  }
  if (kind === "bash" || kind === "zsh" || kind === "fish") {
    return {
      file: kind,
      args: ["-i"],
      cwd
    };
  }
  return {
    file: process.env.SHELL || "bash",
    args: ["-i"],
    cwd
  };
}

function resolveGitBashPath() {
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe"
  ];
  const found = candidates.find((candidate) => fsSync.existsSync(candidate));
  if (!found) throw new Error("未找到 Git Bash。");
  return found;
}

function toWindowsShellCwd(cwd: string) {
  const converted = wslMountPathToWindowsPath(cwd);
  if (path.win32.isAbsolute(converted)) return converted;
  return os.homedir();
}

export function writeTerminalSession(terminalId: string, data: string) {
  const session = sessions.get(terminalId);
  if (session) session.pty.write(data);
}

export function resizeTerminalSession(terminalId: string, cols: number, rows: number) {
  sessions.get(terminalId)?.pty.resize(Math.max(10, cols), Math.max(4, rows));
}

export function stopTerminalSession(terminalId: string) {
  const session = sessions.get(terminalId);
  if (!session) return;
  if (session.outputTimer) clearTimeout(session.outputTimer);
  session.outputTimer = undefined;
  session.outputChunks = [];
  session.pty.kill();
  sessions.delete(terminalId);
  if (session.resumeKey) pendingResumeKeys.delete(session.resumeKey);
  if (session.resumeKey) activeResumeKeys.delete(session.resumeKey);
  if (session.vendorRouteId) void destroyVendorRoute(session.vendorRouteId);
}

export async function switchTerminalVendor(terminalId: string, providerId: AiProviderId, vendorId: string) {
  const session = sessions.get(terminalId);
  if (!session) return { switched: 0, reason: "terminal-not-found" as const };
  if (!session.vendorRouteId) return { switched: 0, reason: "gateway-not-active" as const };
  return switchVendorRoute(session.vendorRouteId, providerId, vendorId);
}

function queueTerminalOutput(session: TerminalSession, data: string) {
  session.outputChunks.push(data);
  if (session.outputTimer) return;
  session.outputTimer = setTimeout(() => flushTerminalOutput(session), 16);
}

function flushTerminalOutput(session: TerminalSession) {
  if (session.outputTimer) {
    clearTimeout(session.outputTimer);
    session.outputTimer = undefined;
  }
  if (session.outputChunks.length === 0) return;
  const data = session.outputChunks.join("");
  session.outputChunks = [];
  sendToWindow(session.window, "terminal:data", session.id, data);
}

export function stopAllTerminalSessions() {
  for (const session of sessions.values()) {
    try {
      if (session.outputTimer) clearTimeout(session.outputTimer);
      session.outputTimer = undefined;
      session.outputChunks = [];
      session.pty.kill();
      if (session.vendorRouteId) void destroyVendorRoute(session.vendorRouteId);
    } catch {
      // 进程可能已经退出。
    }
  }
  sessions.clear();
  pendingResumeKeys.clear();
  activeResumeKeys.clear();
}

export function getTerminalSessionCount() {
  return sessions.size;
}

function sendToWindow(window: BrowserWindow, channel: string, ...args: unknown[]) {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send(channel, ...args);
}

function loadNodePty() {
  const candidates = [
    "node-pty",
    path.join(process.resourcesPath || "", "node_modules", "node-pty"),
    path.join(process.resourcesPath || "", "app.asar.unpacked", "node_modules", "node-pty")
  ].filter(Boolean);

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return requireFromHere(candidate) as typeof import("node-pty");
    } catch (error: any) {
      errors.push(`${candidate}: ${error?.message || error}`);
    }
  }

  throw new Error(`无法加载 node-pty。已尝试：${errors.join(" | ")}`);
}

function resolveTerminalProvider(targetId: string) {
  const provider = terminalProviders.find((item) => item.canHandle(targetId));
  if (!provider) throw new Error(`未知终端平台：${targetId}`);
  return provider;
}

async function buildCodexCommand(params: TerminalStartParams & { vendorRoute?: VendorRoute }) {
  const extraArgs = parseCliArgs(params.cliArgs || "");
  const route = await withResolvedBaseUrl(params.targetId, params.vendorRoute);
  if (params.targetId.startsWith("wsl:")) {
    const distro = params.targetId.slice("wsl:".length);
    const codexInvocation = buildCodexInvocation(extraArgs, route);
    const command = params.sessionId
      ? `${params.cwd ? `cd ${shellQuote(params.cwd)} && ` : ""}exec ${buildCodexInvocation(["resume", params.sessionId], route)}`
      : params.cwd && params.useCodexCwdFlag
        ? `exec ${buildCodexInvocation(["-C", params.cwd, ...extraArgs], route)}`
        : params.cwd
          ? `mkdir -p ${shellQuote(params.cwd)} && cd ${shellQuote(params.cwd)} && exec ${codexInvocation}`
          : `mkdir -p "$HOME/.akim" && cd "$HOME/.akim" && exec ${codexInvocation}`;
    const environment = buildCodexEnvironment(route, params.codexHome);
    const exportCommand = environment
      ? `unset CODEX_API_KEY CODEX_ACCESS_TOKEN; export ${Object.entries(environment).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")}; `
      : "";
    return {
      file: "wsl.exe",
      args: ["-d", distro, "--", "bash", "-ic", `${exportCommand}${command}`],
      cwd: os.homedir(),
      env: undefined
    };
  }

  const codexHome = params.codexHome?.trim();
  const cwd = params.cwd || path.join(os.homedir(), ".akim");
  if (process.platform === "win32") {
    const windowsCwd = toWindowsShellCwd(cwd);
    if (!params.sessionId) {
      await fs.mkdir(windowsCwd, { recursive: true });
    }
    const args = params.sessionId
      ? ["resume", params.sessionId]
      : params.cwd && params.useCodexCwdFlag
        ? ["-C", windowsCwd, ...extraArgs]
        : extraArgs;
    return {
      file: "codex.cmd",
      args: buildCodexArgs(args, route),
      cwd: windowsCwd,
      env: buildCodexEnvironment(route, codexHome)
    };
  }

  if (!params.sessionId) {
    await fs.mkdir(cwd, { recursive: true });
  }

  const codexInvocation = buildCodexInvocation(extraArgs, route);
  const command = params.sessionId
    ? `exec ${buildCodexInvocation(["resume", params.sessionId], route)}`
    : params.cwd && params.useCodexCwdFlag
      ? `exec ${buildCodexInvocation(["-C", params.cwd, ...extraArgs], route)}`
      : `exec ${codexInvocation}`;
  return {
    file: process.env.SHELL || "bash",
    args: ["-ic", command],
    cwd,
    env: buildCodexEnvironment(route, codexHome)
  };
}

async function buildGeminiCommand(params: TerminalStartParams & { vendorRoute?: VendorRoute }) {
  const extraArgs = parseCliArgs(params.cliArgs || "");
  const resumeArgs = params.sessionId ? ["--resume", params.sessionId] : [];
  const route = await withResolvedBaseUrl(params.targetId, params.vendorRoute);
  if (params.targetId.startsWith("gemini:wsl:")) {
    const distro = params.targetId.slice("gemini:wsl:".length);
    const invocation = buildShellCommand("gemini", [...resumeArgs, ...extraArgs]);
    const command = params.cwd
      ? `mkdir -p ${shellQuote(params.cwd)} && cd ${shellQuote(params.cwd)} && exec ${invocation}`
      : `mkdir -p "$HOME/.akim" && cd "$HOME/.akim" && exec ${invocation}`;

    return {
      file: "wsl.exe",
      args: ["-d", distro, "--", "bash", "-ic", route
        ? `export GOOGLE_GEMINI_BASE_URL=${shellQuote(route.baseUrl)} GEMINI_API_KEY=${shellQuote(route.localToken)}; ${command}`
        : command],
      cwd: os.homedir()
    };
  }

  const cwd = params.cwd || path.join(os.homedir(), ".akim");
  await fs.mkdir(cwd, { recursive: true });

  if (process.platform === "win32") {
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", buildCmdCommand("gemini", [...resumeArgs, ...extraArgs])],
      cwd,
      env: route ? {
        GOOGLE_GEMINI_BASE_URL: route.baseUrl,
        GEMINI_API_KEY: route.localToken
      } : undefined
    };
  }

  return {
    file: process.env.SHELL || "bash",
    args: ["-ic", `exec ${buildGatewayInvocation("gemini", [...resumeArgs, ...extraArgs], route, {
      GOOGLE_GEMINI_BASE_URL: route?.baseUrl || "",
      GEMINI_API_KEY: route?.localToken || ""
    })}`],
    cwd,
    env: undefined
  };
}

async function buildClaudeCommand(params: TerminalStartParams & { vendorRoute?: VendorRoute }) {
  const extraArgs = parseCliArgs(params.cliArgs || "");
  const resumeArgs = params.sessionId ? ["--resume", params.sessionId] : [];
  const route = await withResolvedBaseUrl(params.targetId, params.vendorRoute);
  if (params.targetId.startsWith("claude:wsl:")) {
    const distro = params.targetId.slice("claude:wsl:".length);
    const invocation = buildShellCommand("claude", [...resumeArgs, ...extraArgs]);
    const command = params.cwd
      ? `mkdir -p ${shellQuote(params.cwd)} && cd ${shellQuote(params.cwd)} && exec ${invocation}`
      : `mkdir -p "$HOME/.akim" && cd "$HOME/.akim" && exec ${invocation}`;

    return {
      file: "wsl.exe",
      args: ["-d", distro, "--", "bash", "-ic", route
        ? `export ANTHROPIC_BASE_URL=${shellQuote(route.baseUrl)} ANTHROPIC_AUTH_TOKEN=${shellQuote(route.localToken)}; ${command}`
        : command],
      cwd: os.homedir()
    };
  }

  const cwd = params.cwd || path.join(os.homedir(), ".akim");
  await fs.mkdir(cwd, { recursive: true });

  if (process.platform === "win32") {
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", buildCmdCommand("claude", [...resumeArgs, ...extraArgs])],
      cwd,
      env: route ? {
        ANTHROPIC_BASE_URL: route.baseUrl,
        ANTHROPIC_AUTH_TOKEN: route.localToken
      } : undefined
    };
  }

  return {
    file: process.env.SHELL || "bash",
    args: ["-ic", `exec ${buildGatewayInvocation("claude", [...resumeArgs, ...extraArgs], route, {
      ANTHROPIC_BASE_URL: route?.baseUrl || "",
      ANTHROPIC_AUTH_TOKEN: route?.localToken || ""
    })}`],
    cwd,
    env: undefined
  };
}

async function buildQoderCommand(params: TerminalStartParams & { vendorRoute?: VendorRoute }) {
  const extraArgs = parseCliArgs(params.cliArgs || "");
  const resumeArgs = params.sessionId ? ["--resume", params.sessionId] : [];
  const cwd = params.cwd || path.join(os.homedir(), ".akim");
  const args = [...resumeArgs, ...(params.cwd && params.useCodexCwdFlag ? ["--cwd", params.cwd] : []), ...extraArgs];

  if (params.targetId.startsWith("qoder:wsl:")) {
    const distro = params.targetId.slice("qoder:wsl:".length);
    const command = params.cwd && !params.useCodexCwdFlag
      ? `mkdir -p ${shellQuote(params.cwd)} && cd ${shellQuote(params.cwd)} && exec ${buildShellCommand("qodercn", args)}`
      : `exec ${buildShellCommand("qodercn", args)}`;
    return {
      file: "wsl.exe",
      args: ["-d", distro, "--", "bash", "-ic", command],
      cwd: os.homedir()
    };
  }

  if (process.platform === "win32") {
    if (!params.sessionId) await fs.mkdir(cwd, { recursive: true });
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", buildCmdCommand("qodercn", args)],
      cwd: toWindowsShellCwd(cwd)
    };
  }

  if (!params.sessionId) await fs.mkdir(cwd, { recursive: true });
  return {
    file: process.env.SHELL || "bash",
    args: ["-ic", `exec ${buildShellCommand("qodercn", args)}`],
    cwd
  };
}

const CODEX_ROUTE_PROVIDER = "akim_gateway";

// WSL 目标下 127.0.0.1 指向 WSL 自身而非宿主，需探测可达宿主地址后再拼路由 URL。
// 本地（Windows/macOS/Linux 宿主）终端直接复用 route.baseUrl（已为 127.0.0.1）。
async function resolveRouteBaseUrl(targetId: string, route?: VendorRoute) {
  if (!route) return undefined;
  if (targetId.startsWith("wsl:") || targetId.startsWith("gemini:wsl:") || targetId.startsWith("claude:wsl:")) {
    const distro = extractWslDistro(targetId);
    if (distro) {
      const base = await resolveWslGatewayBaseUrl(distro);
      return buildRouteUrl(base, route.providerId, route.routeId);
    }
  }
  return route.baseUrl;
}

function extractWslDistro(targetId: string) {
  if (targetId.startsWith("gemini:wsl:")) return targetId.slice("gemini:wsl:".length);
  if (targetId.startsWith("claude:wsl:")) return targetId.slice("claude:wsl:".length);
  if (targetId.startsWith("wsl:")) return targetId.slice("wsl:".length);
  return "";
}

// 返回 baseUrl 已按目标环境解析的 route 副本。WSL 目标会探测宿主地址；本地目标保持原值。
// baseUrl 未变时返回原对象，避免无谓复制。下游 buildCodexInvocation 等读取 route.baseUrl 即可获得正确地址。
async function withResolvedBaseUrl(targetId: string, route?: VendorRoute): Promise<VendorRoute | undefined> {
  if (!route) return undefined;
  const baseUrl = await resolveRouteBaseUrl(targetId, route);
  return baseUrl === route.baseUrl ? route : { ...route, baseUrl: baseUrl! };
}

function buildCodexArgs(args: string[], route?: VendorRoute) {
  return [...buildCodexRouteConfigArgs(route), ...args];
}

function buildCodexRouteConfigArgs(route?: VendorRoute) {
  if (!route) return [];
  return [
    "-c", `model_provider=${JSON.stringify(CODEX_ROUTE_PROVIDER)}`,
    "-c", `model_providers.${CODEX_ROUTE_PROVIDER}.name=${JSON.stringify(CODEX_ROUTE_PROVIDER)}`,
    "-c", `model_providers.${CODEX_ROUTE_PROVIDER}.wire_api=${JSON.stringify("responses")}`,
    "-c", `model_providers.${CODEX_ROUTE_PROVIDER}.requires_openai_auth=true`,
    "-c", `model_providers.${CODEX_ROUTE_PROVIDER}.env_key=${JSON.stringify("OPENAI_API_KEY")}`,
    "-c", `model_providers.${CODEX_ROUTE_PROVIDER}.base_url=${JSON.stringify(route.baseUrl)}`
  ];
}

export function buildCodexInvocation(args: string[], route?: VendorRoute) {
  return buildShellCommand("codex", buildCodexArgs(args, route));
}

function buildCodexEnvironment(route: VendorRoute | undefined, codexHome?: string) {
  const environment: Record<string, string> = {};
  if (route) environment.OPENAI_API_KEY = route.localToken;
  if (codexHome?.trim()) environment.CODEX_HOME = codexHome.trim();
  return Object.keys(environment).length > 0 ? environment : undefined;
}

function buildGatewayInvocation(
  command: string,
  args: string[],
  route: VendorRoute | undefined,
  environment: Record<string, string>
) {
  if (!route) return buildShellCommand(command, args);
  return buildShellCommand("env", [...Object.entries(environment).map(([key, value]) => `${key}=${value}`), command, ...args]);
}
