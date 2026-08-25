import type { BrowserWindow } from "electron";
import { createRequire } from "node:module";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AiProviderId, SystemTerminalStartRequest, TerminalStartParams } from "./types";
import {
  buildCmdCommand,
  buildPosixShellCommand as buildShellCommand,
  parseCliArgs,
  posixShellQuote as shellQuote
} from "../shared/shellArgs";
import { getWslDistroFromTargetId, wslMountPathToWindowsPath } from "../shared/wslPaths";
import {
  createVendorRoute,
  destroyVendorRoute,
  switchVendorRoute,
  type VendorRoute
} from "./vendorGateway";
import { readLocalLines, readWslLines } from "./wslProcess";

type TerminalSession = {
  id: string;
  pty: import("node-pty").IPty;
  window: BrowserWindow;
  outputBuffer: string;
  outputTimer?: NodeJS.Timeout;
  vendorRouteId?: string;
};

type TerminalCommand = {
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
};

type TerminalProvider = {
  id: "codex" | "gemini" | "claude";
  canHandle: (targetId: string) => boolean;
  buildCommand: (params: TerminalStartParams & { vendorRoute?: VendorRoute }) => Promise<TerminalCommand>;
};

const sessions = new Map<string, TerminalSession>();
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

const terminalProviders: TerminalProvider[] = [claudeTerminalProvider, geminiTerminalProvider, codexTerminalProvider];

export async function startTerminalSession(
  window: BrowserWindow,
  params: TerminalStartParams & { cols?: number; rows?: number }
) {
  const provider = resolveTerminalProvider(params.targetId);
  const route = await createVendorRoute(provider.id, params.vendorId);
  try {
    const command = await provider.buildCommand({ ...params, vendorRoute: route });
    return await startPtySession(window, command, params.cols, params.rows, route?.routeId);
  } catch (error) {
    if (route) await destroyVendorRoute(route.routeId);
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
  vendorRouteId?: string
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

  const session: TerminalSession = { id: terminalId, pty: child, window, outputBuffer: "", vendorRouteId };
  sessions.set(terminalId, session);

  child.onData((data) => {
    queueTerminalOutput(session, data);
  });
  child.onExit(({ exitCode }) => {
    flushTerminalOutput(session);
    sessions.delete(terminalId);
    if (session.vendorRouteId) void destroyVendorRoute(session.vendorRouteId);
    sendToWindow(window, "terminal:exit", terminalId, exitCode);
  });

  return { terminalId };
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
  sessions.get(terminalId)?.pty.write(data);
}

export function resizeTerminalSession(terminalId: string, cols: number, rows: number) {
  sessions.get(terminalId)?.pty.resize(Math.max(10, cols), Math.max(4, rows));
}

export function stopTerminalSession(terminalId: string) {
  const session = sessions.get(terminalId);
  if (!session) return;
  if (session.outputTimer) clearTimeout(session.outputTimer);
  session.outputTimer = undefined;
  session.outputBuffer = "";
  session.pty.kill();
  sessions.delete(terminalId);
  if (session.vendorRouteId) void destroyVendorRoute(session.vendorRouteId);
}

export function switchTerminalVendor(terminalId: string, providerId: AiProviderId, vendorId: string) {
  const session = sessions.get(terminalId);
  if (!session) return { switched: 0, reason: "terminal-not-found" as const };
  if (!session.vendorRouteId) return { switched: 0, reason: "gateway-not-active" as const };
  return switchVendorRoute(session.vendorRouteId, providerId, vendorId);
}

function queueTerminalOutput(session: TerminalSession, data: string) {
  session.outputBuffer += data;
  if (session.outputTimer) return;
  session.outputTimer = setTimeout(() => flushTerminalOutput(session), 16);
}

function flushTerminalOutput(session: TerminalSession) {
  if (session.outputTimer) {
    clearTimeout(session.outputTimer);
    session.outputTimer = undefined;
  }
  if (!session.outputBuffer) return;
  const data = session.outputBuffer;
  session.outputBuffer = "";
  sendToWindow(session.window, "terminal:data", session.id, data);
}

export function stopAllTerminalSessions() {
  for (const session of sessions.values()) {
    try {
      if (session.outputTimer) clearTimeout(session.outputTimer);
      session.outputTimer = undefined;
      session.outputBuffer = "";
      session.pty.kill();
      if (session.vendorRouteId) void destroyVendorRoute(session.vendorRouteId);
    } catch {
      // 进程可能已经退出。
    }
  }
  sessions.clear();
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
  if (params.targetId.startsWith("wsl:")) {
    const distro = params.targetId.slice("wsl:".length);
    const providerNames = await readCodexProviderNames(params.codexHome, distro);
    const codexInvocation = buildCodexInvocation(extraArgs, params.vendorRoute, providerNames);
    const command = params.sessionId
      ? `${params.cwd ? `cd ${shellQuote(params.cwd)} && ` : ""}exec ${buildCodexInvocation(["resume", params.sessionId], params.vendorRoute, providerNames)}`
      : params.cwd && params.useCodexCwdFlag
        ? `exec ${buildCodexInvocation(["-C", params.cwd, ...extraArgs], params.vendorRoute, providerNames)}`
        : params.cwd
          ? `mkdir -p ${shellQuote(params.cwd)} && cd ${shellQuote(params.cwd)} && exec ${codexInvocation}`
          : `mkdir -p "$HOME/.akim" && cd "$HOME/.akim" && exec ${codexInvocation}`;
    const environment = buildCodexEnvironment(params.vendorRoute, params.codexHome);
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
  const providerNames = await readCodexProviderNames(codexHome);

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
      args: buildCodexArgs(args, params.vendorRoute, providerNames),
      cwd: windowsCwd,
      env: buildCodexEnvironment(params.vendorRoute, codexHome)
    };
  }

  if (!params.sessionId) {
    await fs.mkdir(cwd, { recursive: true });
  }

  const codexInvocation = buildCodexInvocation(extraArgs, params.vendorRoute, providerNames);
  const command = params.sessionId
    ? `exec ${buildCodexInvocation(["resume", params.sessionId], params.vendorRoute, providerNames)}`
    : params.cwd && params.useCodexCwdFlag
      ? `exec ${buildCodexInvocation(["-C", params.cwd, ...extraArgs], params.vendorRoute, providerNames)}`
      : `exec ${codexInvocation}`;
  return {
    file: process.env.SHELL || "bash",
    args: ["-ic", command],
    cwd,
    env: buildCodexEnvironment(params.vendorRoute, codexHome)
  };
}

async function buildGeminiCommand(params: TerminalStartParams & { vendorRoute?: VendorRoute }) {
  const extraArgs = parseCliArgs(params.cliArgs || "");
  const resumeArgs = params.sessionId ? ["--resume", params.sessionId] : [];
  if (params.targetId.startsWith("gemini:wsl:")) {
    const distro = params.targetId.slice("gemini:wsl:".length);
    const invocation = buildShellCommand("gemini", [...resumeArgs, ...extraArgs]);
    const command = params.cwd
      ? `mkdir -p ${shellQuote(params.cwd)} && cd ${shellQuote(params.cwd)} && exec ${invocation}`
      : `mkdir -p "$HOME/.akim" && cd "$HOME/.akim" && exec ${invocation}`;

    return {
      file: "wsl.exe",
      args: ["-d", distro, "--", "bash", "-ic", params.vendorRoute
        ? `export GOOGLE_GEMINI_BASE_URL=${shellQuote(params.vendorRoute.baseUrl)} GEMINI_API_KEY=${shellQuote(params.vendorRoute.localToken)}; ${command}`
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
      env: params.vendorRoute ? {
        GOOGLE_GEMINI_BASE_URL: params.vendorRoute.baseUrl,
        GEMINI_API_KEY: params.vendorRoute.localToken
      } : undefined
    };
  }

  return {
    file: process.env.SHELL || "bash",
    args: ["-ic", `exec ${buildGatewayInvocation("gemini", [...resumeArgs, ...extraArgs], params.vendorRoute, {
      GOOGLE_GEMINI_BASE_URL: params.vendorRoute?.baseUrl || "",
      GEMINI_API_KEY: params.vendorRoute?.localToken || ""
    })}`],
    cwd,
    env: undefined
  };
}

async function buildClaudeCommand(params: TerminalStartParams & { vendorRoute?: VendorRoute }) {
  const extraArgs = parseCliArgs(params.cliArgs || "");
  const resumeArgs = params.sessionId ? ["--resume", params.sessionId] : [];
  if (params.targetId.startsWith("claude:wsl:")) {
    const distro = params.targetId.slice("claude:wsl:".length);
    const invocation = buildShellCommand("claude", [...resumeArgs, ...extraArgs]);
    const command = params.cwd
      ? `mkdir -p ${shellQuote(params.cwd)} && cd ${shellQuote(params.cwd)} && exec ${invocation}`
      : `mkdir -p "$HOME/.akim" && cd "$HOME/.akim" && exec ${invocation}`;

    return {
      file: "wsl.exe",
      args: ["-d", distro, "--", "bash", "-ic", params.vendorRoute
        ? `export ANTHROPIC_BASE_URL=${shellQuote(params.vendorRoute.baseUrl)} ANTHROPIC_AUTH_TOKEN=${shellQuote(params.vendorRoute.localToken)}; ${command}`
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
      env: params.vendorRoute ? {
        ANTHROPIC_BASE_URL: params.vendorRoute.baseUrl,
        ANTHROPIC_AUTH_TOKEN: params.vendorRoute.localToken
      } : undefined
    };
  }

  return {
    file: process.env.SHELL || "bash",
    args: ["-ic", `exec ${buildGatewayInvocation("claude", [...resumeArgs, ...extraArgs], params.vendorRoute, {
      ANTHROPIC_BASE_URL: params.vendorRoute?.baseUrl || "",
      ANTHROPIC_AUTH_TOKEN: params.vendorRoute?.localToken || ""
    })}`],
    cwd,
    env: undefined
  };
}

const CODEX_ROUTE_PROVIDER = "akim_gateway";

function buildCodexArgs(args: string[], route?: VendorRoute, providerNames: string[] = []) {
  return [...buildCodexRouteConfigArgs(route, providerNames), ...args];
}

function buildCodexRouteConfigArgs(route?: VendorRoute, providerNames: string[] = []) {
  if (!route) return [];
  return [
    "-c", `model_provider=${JSON.stringify(CODEX_ROUTE_PROVIDER)}`,
    "-c", `model_providers.${CODEX_ROUTE_PROVIDER}.name=${JSON.stringify(CODEX_ROUTE_PROVIDER)}`,
    "-c", `model_providers.${CODEX_ROUTE_PROVIDER}.wire_api=${JSON.stringify("responses")}`,
    "-c", `model_providers.${CODEX_ROUTE_PROVIDER}.requires_openai_auth=true`,
    "-c", `model_providers.${CODEX_ROUTE_PROVIDER}.env_key=${JSON.stringify("OPENAI_API_KEY")}`,
    "-c", `model_providers.${CODEX_ROUTE_PROVIDER}.base_url=${JSON.stringify(route.baseUrl)}`,
    ...providerNames
      .filter((name) => name !== CODEX_ROUTE_PROVIDER)
      .flatMap((name) => ["-c", `model_providers.${name}.base_url=${JSON.stringify(route.baseUrl)}`])
  ];
}

export function buildCodexInvocation(args: string[], route?: VendorRoute, providerNames: string[] = []) {
  return buildShellCommand("codex", buildCodexArgs(args, route, providerNames));
}

async function readCodexProviderNames(codexHome?: string, distro?: string) {
  const names: string[] = [];
  const addName = (line: string) => {
    const name = /^\s*\[model_providers\.([A-Za-z0-9_-]+)\]\s*$/.exec(line)?.[1];
    if (name && !names.includes(name)) names.push(name);
  };
  const sourceHome = codexHome?.trim();
  if (distro) {
    if (!sourceHome) return names;
    await readWslLines(distro, path.posix.join(sourceHome, "config.toml"), addName).catch(() => undefined);
    return names;
  }
  const configPath = path.join(sourceHome || os.homedir() + "/.codex", "config.toml");
  await readLocalLines(configPath, addName).catch(() => undefined);
  return names;
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
