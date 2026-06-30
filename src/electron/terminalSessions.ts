import { BrowserWindow } from "electron";
import { createRequire } from "node:module";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SystemTerminalStartRequest, TerminalStartParams } from "./types";
import {
  buildCmdCommand,
  buildPosixShellCommand as buildShellCommand,
  parseCliArgs,
  posixShellQuote as shellQuote
} from "../shared/shellArgs";
import { getWslDistroFromTargetId, wslMountPathToWindowsPath } from "../shared/wslPaths";

type TerminalSession = {
  id: string;
  pty: import("node-pty").IPty;
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
  buildCommand: (params: TerminalStartParams) => Promise<TerminalCommand>;
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
  return startPtySession(window, await resolveTerminalProvider(params.targetId).buildCommand(params), params.cols, params.rows);
}

export async function startSystemTerminalSession(
  window: BrowserWindow,
  params: SystemTerminalStartRequest & { cols?: number; rows?: number }
) {
  return startPtySession(window, await buildSystemTerminalCommand(params), params.cols, params.rows);
}

async function startPtySession(window: BrowserWindow, command: TerminalCommand, cols?: number, rows?: number) {
  const pty = loadNodePty();
  const terminalId = crypto.randomUUID();
  const child = pty.spawn(command.file, command.args, {
    name: "xterm-256color",
    cols: cols || 100,
    rows: rows || 30,
    cwd: command.cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      ...command.env
    }
  });

  sessions.set(terminalId, { id: terminalId, pty: child });

  child.onData((data) => {
    sendToWindow(window, "terminal:data", terminalId, data);
  });
  child.onExit(({ exitCode }) => {
    sessions.delete(terminalId);
    sendToWindow(window, "terminal:exit", terminalId, exitCode);
  });

  return { terminalId };
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
  session.pty.kill();
  sessions.delete(terminalId);
}

export function stopAllTerminalSessions() {
  for (const session of sessions.values()) {
    try {
      session.pty.kill();
    } catch {
      // 进程可能已经退出。
    }
  }
  sessions.clear();
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

async function buildCodexCommand(params: TerminalStartParams) {
  const extraArgs = parseCliArgs(params.cliArgs || "");
  if (params.targetId.startsWith("wsl:")) {
    const distro = params.targetId.slice("wsl:".length);
    const codexCommand = "codex";
    const codexInvocation = buildShellCommand(codexCommand, extraArgs);
    const command = params.sessionId
      ? `${params.cwd ? `cd ${shellQuote(params.cwd)} && ` : ""}exec ${buildShellCommand(codexCommand, ["resume", params.sessionId])}`
      : params.cwd && params.useCodexCwdFlag
        ? `exec ${buildShellCommand(codexCommand, ["-C", params.cwd, ...extraArgs])}`
        : params.cwd
          ? `mkdir -p ${shellQuote(params.cwd)} && cd ${shellQuote(params.cwd)} && exec ${codexInvocation}`
        : `mkdir -p "$HOME/.akim" && cd "$HOME/.akim" && exec ${codexInvocation}`;

    return {
      file: "wsl.exe",
      args: ["-d", distro, "--", "bash", "-ic", command],
      cwd: os.homedir()
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
      args,
      cwd: windowsCwd,
      env: codexHome ? { CODEX_HOME: codexHome } : undefined
    };
  }

  if (!params.sessionId) {
    await fs.mkdir(cwd, { recursive: true });
  }

  const codexCommand = "codex";
  const codexInvocation = buildShellCommand(codexCommand, extraArgs);
  const command = params.sessionId
    ? `exec ${buildShellCommand(codexCommand, ["resume", params.sessionId])}`
    : params.cwd && params.useCodexCwdFlag
      ? `exec ${buildShellCommand(codexCommand, ["-C", params.cwd, ...extraArgs])}`
      : `exec ${codexInvocation}`;
  return {
    file: process.env.SHELL || "bash",
    args: ["-ic", command],
    cwd,
    env: codexHome ? { CODEX_HOME: codexHome } : undefined
  };
}

async function buildGeminiCommand(params: TerminalStartParams) {
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
      args: ["-d", distro, "--", "bash", "-ic", command],
      cwd: os.homedir()
    };
  }

  const cwd = params.cwd || path.join(os.homedir(), ".akim");
  await fs.mkdir(cwd, { recursive: true });

  if (process.platform === "win32") {
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", buildCmdCommand("gemini", [...resumeArgs, ...extraArgs])],
      cwd
    };
  }

  return {
    file: process.env.SHELL || "bash",
    args: ["-ic", `exec ${buildShellCommand("gemini", [...resumeArgs, ...extraArgs])}`],
    cwd
  };
}

async function buildClaudeCommand(params: TerminalStartParams) {
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
      args: ["-d", distro, "--", "bash", "-ic", command],
      cwd: os.homedir()
    };
  }

  const cwd = params.cwd || path.join(os.homedir(), ".akim");
  await fs.mkdir(cwd, { recursive: true });

  if (process.platform === "win32") {
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", buildCmdCommand("claude", [...resumeArgs, ...extraArgs])],
      cwd
    };
  }

  return {
    file: process.env.SHELL || "bash",
    args: ["-ic", `exec ${buildShellCommand("claude", [...resumeArgs, ...extraArgs])}`],
    cwd
  };
}

