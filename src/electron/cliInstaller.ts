import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getCliInstaller } from "../shared/cliInstallers";
import type { AiProviderId, CliEnvironmentRequest, CliEnvironmentStatus, CliInstallRequest, CliInstallResult } from "./types";

const execFileAsync = promisify(execFile);
const RECOMMENDED_NODE_MAJOR = 24;
const COMMAND_TIMEOUT = 1000 * 60 * 15;
const environmentSnapshotRequests = new Map<string, Promise<Record<string, string>>>();

// 命令的 stdout / stderr 分别保留，便于安装成功时分流展示、失败时透传真实诊断。
type CommandOutput = { stdout: string; stderr: string };

export async function checkCliEnvironment(request: CliEnvironmentRequest): Promise<CliEnvironmentStatus> {
  requireCliInstaller(request.providerId); // 校验 providerId 合法，未知平台直接抛错
  const targetId = request.targetId || "";
  const scope = isWslTarget(targetId) ? "wsl" : "local";
  const platform = scope === "wsl" ? "linux" : currentPlatform();
  const minimumNodeMajor = minimumNodeMajorForProvider(request.providerId);

  const snapshot = await getEnvironmentSnapshot(targetId);
  const nodeVersion = snapshot.NODE_VERSION || "";
  const npmVersion = snapshot.NPM_VERSION || "";
  const nvmVersion = snapshot.NVM_VERSION || "";
  const cliVersion = snapshot[cliVersionKey(request.providerId)] || "";
  const nodePath = snapshot.NODE_PATH || "";
  const npmPath = snapshot.NPM_PATH || "";

  const nodeMajor = parseNodeMajor(nodeVersion);
  const hasNode = Boolean(nodeVersion);
  const hasNpm = Boolean(npmVersion);
  const hasNvm = Boolean(nvmVersion);
  const hasCli = Boolean(cliVersion);
  const nodeManagedByNvm = Boolean(nodePath && /[\\/]nvm[\\/]|[\\.]nvm[\\/]/i.test(nodePath));
  const nodeMeetsMinimum = typeof nodeMajor === "number" && nodeMajor >= minimumNodeMajor;
  const canInstallNodeWithNvm = hasNvm;
  const canInstallCli = hasNode && hasNpm;
  const messages = buildEnvironmentMessages({
    hasNode,
    hasNpm,
    hasNvm,
    canInstallNodeWithNvm,
    detectionError: snapshot.DETECTION_ERROR || ""
  });

  return {
    providerId: request.providerId,
    targetId: request.targetId,
    scope,
    platform,
    minimumNodeMajor,
    recommendedNodeMajor: RECOMMENDED_NODE_MAJOR,
    nodeVersion: nodeVersion || undefined,
    npmVersion: npmVersion || undefined,
    nvmVersion: nvmVersion || undefined,
    cliVersion: cliVersion || undefined,
    nodePath: nodePath || undefined,
    npmPath: npmPath || undefined,
    hasNode,
    hasNpm,
    hasNvm,
    hasCli,
    nodeManagedByNvm,
    nodeMeetsMinimum,
    canInstallCli,
    canInstallNodeWithNvm,
    messages
  };
}

export async function installCli(request: CliInstallRequest): Promise<CliInstallResult> {
  const installer = requireCliInstaller(request.providerId);
  const targetId = request.targetId || "";
  const nodeMajor = request.nodeMajor || RECOMMENDED_NODE_MAJOR;
  const outputs: CommandOutput[] = [];

  try {
    if (request.ensureNode && !isWslTarget(targetId) && process.platform === "win32") {
      outputs.push(
        await runLocalWindows([
          "/d",
          "/s",
          "/c",
          `nvm install ${nodeMajor} && nvm use ${nodeMajor} && npm ${installer.installArgs.join(" ")}`
        ])
      );
    } else {
      if (request.ensureNode) {
        outputs.push(await installNodeWithNvm(targetId, nodeMajor));
      }
      outputs.push(await installPackage(targetId, installer.installArgs));
    }
  } catch (error: any) {
    // 安装失败：把命令的真实 stderr/stdout 透传给上层，避免只剩 “Command failed”。
    throw buildInstallError(error, outputs);
  }

  return {
    providerId: request.providerId,
    command: "npm install",
    stdout: mergeStreams(outputs, "stdout"),
    stderr: mergeStreams(outputs, "stderr")
  };
}

function requireCliInstaller(providerId: AiProviderId) {
  const installer = getCliInstaller(providerId);
  if (!installer) throw new Error(`未知 CLI：${providerId}`);
  return installer;
}

async function installNodeWithNvm(targetId: string, nodeMajor: number) {
  if (!Number.isInteger(nodeMajor) || nodeMajor < 18 || nodeMajor > 40) throw new Error("参数无效：nodeMajor");
  if (isWslTarget(targetId) || process.platform !== "win32") {
    return runPosix(targetId, nvmShellScript(`nvm install ${nodeMajor} && nvm use ${nodeMajor}`));
  }
  return runLocalWindows(["/d", "/s", "/c", `nvm install ${nodeMajor} && nvm use ${nodeMajor}`]);
}

async function installPackage(targetId: string, args: string[]) {
  if (isWslTarget(targetId) || process.platform !== "win32") {
    return runPosix(targetId, nvmShellScript(`npm ${shellJoin(args)}`));
  }
  return runLocalWindows(["/d", "/s", "/c", `npm ${args.join(" ")}`]);
}

async function runPosix(targetId: string, script: string, timeout = COMMAND_TIMEOUT): Promise<CommandOutput> {
  if (isWslTarget(targetId) && process.platform === "win32") {
    const distro = parseWslDistro(targetId);
    return execCommand(getWindowsWslExe(), ["-d", distro, "--", "bash", "-lc", script], timeout);
  }
  return execCommand("bash", ["-lc", script], timeout);
}

async function runLocalWindows(args: string[], timeout = COMMAND_TIMEOUT): Promise<CommandOutput> {
  return execCommand("cmd.exe", args, timeout);
}

// 统一执行入口：成功返回结构化 stdout/stderr；失败时把已捕获的 stdout/stderr 附在错误上抛出。
async function execCommand(file: string, args: string[], timeout: number): Promise<CommandOutput> {
  try {
    const result = await execFileAsync(file, args, { ...commandOptions(), timeout });
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch (error: any) {
    throw enrichExecError(error);
  }
}

export function enrichExecError(error: any) {
  const stdout = (error?.stdout ?? "").toString();
  const stderr = (error?.stderr ?? "").toString();
  const detail = firstLine(stderr) || firstLine(stdout) || (error?.message ? String(error.message) : "") || "命令执行失败。";
  const enriched = new Error(detail) as Error & CommandOutput;
  enriched.stdout = stdout;
  enriched.stderr = stderr;
  return enriched;
}

function commandOptions() {
  return {
    encoding: "utf8" as const,
    maxBuffer: 1024 * 1024 * 8,
    timeout: COMMAND_TIMEOUT,
    windowsHide: true
  };
}

function nvmShellScript(command: string) {
  return [
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
    command
  ].join("; ");
}

async function getEnvironmentSnapshot(targetId: string) {
  const cacheKey = targetId || "local";
  const cached = environmentSnapshotRequests.get(cacheKey);
  if (cached) return cached;
  const promise = runEnvironmentSnapshot(targetId);
  environmentSnapshotRequests.set(cacheKey, promise);
  promise.finally(() => {
    if (environmentSnapshotRequests.get(cacheKey) === promise) environmentSnapshotRequests.delete(cacheKey);
  });
  return promise;
}

async function runEnvironmentSnapshot(targetId: string) {
  const output = await runSnapshotSafely(targetId);

  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, line) => {
      const index = line.indexOf("=");
      if (index <= 0) return acc;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      acc[key] = value;
      return acc;
    }, {});
}

async function runSnapshotSafely(targetId: string) {
  try {
    const output =
      process.platform === "win32" && !isWslTarget(targetId)
        ? await runWindowsSnapshot()
        : await runPosixSnapshot(targetId);
    return mergeOutput(output);
  } catch (error: any) {
    return `DETECTION_ERROR=${firstLine(error?.stderr || error?.stdout || error?.message || String(error))}`;
  }
}

async function runPosixSnapshot(targetId: string) {
  const script = [
    "set +e",
    'load_nvm() {',
    '  for dir in "${NVM_DIR:-}" "$HOME/.nvm" "/usr/local/share/nvm" "/opt/nvm"; do',
    '    [ -n "$dir" ] || continue',
    '    [ -s "$dir/nvm.sh" ] || continue',
    '    export NVM_DIR="$dir"',
    '    . "$dir/nvm.sh"',
    '    break',
    '  done',
    '  if command -v nvm >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then',
    '    nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true',
    '  fi',
    '}',
    'find_node_bin() {',
    '  command -v node 2>/dev/null && return',
    '  command -v nodejs 2>/dev/null && return',
    '  local npm_bin npm_dir npm_prefix npm_exec',
    '  npm_bin="$(command -v npm 2>/dev/null || true)"',
    '  if [ -n "$npm_bin" ]; then',
    '    npm_dir="$(dirname "$(readlink -f "$npm_bin" 2>/dev/null || printf "%s" "$npm_bin")")"',
    '    [ -x "$npm_dir/node" ] && printf "%s\\n" "$npm_dir/node" && return',
    '    [ -x "$(dirname "$npm_dir")/bin/node" ] && printf "%s\\n" "$(dirname "$npm_dir")/bin/node" && return',
    '  fi',
    '  npm_prefix="$(npm config get prefix 2>/dev/null || true)"',
    '  [ -n "$npm_prefix" ] && [ "$npm_prefix" != "undefined" ] && [ -x "$npm_prefix/bin/node" ] && printf "%s\\n" "$npm_prefix/bin/node" && return',
    '  npm_exec="$(npm exec -- node -p process.execPath 2>/dev/null || true)"',
    '  [ -n "$npm_exec" ] && [ -x "$npm_exec" ] && printf "%s\\n" "$npm_exec" && return',
    '  find "$HOME/.nvm/versions/node" -type f -path "*/bin/node" -print 2>/dev/null | sort -V | tail -n 1',
    '}',
    'load_nvm',
    'NPM_BIN="$(command -v npm 2>/dev/null || true)"',
    'NODE_BIN="$(find_node_bin)"',
    '[ -n "$NODE_BIN" ] && export PATH="$(dirname "$NODE_BIN"):$PATH"',
    'NVM_VERSION="$(nvm --version 2>/dev/null || true)"',
    '[ -n "$NVM_VERSION" ] || [ ! -s "$HOME/.nvm/nvm.sh" ] || NVM_VERSION="installed"',
    'printf "NODE_VERSION=%s\\n" "$("$NODE_BIN" -v 2>/dev/null || true)"',
    'printf "NPM_VERSION=%s\\n" "$(npm -v 2>/dev/null || true)"',
    'printf "NVM_VERSION=%s\\n" "$NVM_VERSION"',
    'printf "CODEX_VERSION=%s\\n" "$(codex --version 2>/dev/null || true)"',
    'printf "GEMINI_VERSION=%s\\n" "$(gemini --version 2>/dev/null || true)"',
    'printf "CLAUDE_VERSION=%s\\n" "$(claude --version 2>/dev/null || true)"',
    'printf "NODE_PATH=%s\\n" "$NODE_BIN"',
    'printf "NPM_PATH=%s\\n" "$NPM_BIN"',
    "exit 0"
  ].join("\n");
  return runInteractivePosix(targetId, script, 1000 * 15);
}

async function runWindowsSnapshot() {
  const script = [
    'set "NVM_DIR=%USERPROFILE%\\.nvm"',
    'set "NODE_VERSION="',
    'set "NPM_VERSION="',
    'set "NVM_VERSION="',
    'set "CODEX_VERSION="',
    'set "GEMINI_VERSION="',
    'set "CLAUDE_VERSION="',
    'set "NODE_PATH="',
    'set "NPM_PATH="',
    'for /f "delims=" %i in (\'nvm version 2^>nul\') do set "NVM_VERSION=%i"',
    'for /f "delims=" %i in (\'where node 2^>nul\') do if not defined NODE_PATH set "NODE_PATH=%i"',
    'for /f "delims=" %i in (\'where nodejs 2^>nul\') do if not defined NODE_PATH set "NODE_PATH=%i"',
    'for /f "delims=" %i in (\'where npm 2^>nul\') do if not defined NPM_PATH set "NPM_PATH=%i"',
    'for /f "delims=" %i in (\'where npm 2^>nul\') do if not defined NODE_PATH if exist "%~dpinode.exe" set "NODE_PATH=%~dpinode.exe"',
    'if defined NODE_PATH for /f "delims=" %i in (\'"%NODE_PATH%" -v 2^>nul\') do set "NODE_VERSION=%i"',
    'if not defined NODE_VERSION for /f "delims=" %i in (\'node -v 2^>nul\') do set "NODE_VERSION=%i"',
    'for /f "delims=" %i in (\'npm -v 2^>nul\') do set "NPM_VERSION=%i"',
    'for /f "delims=" %i in (\'codex --version 2^>nul\') do set "CODEX_VERSION=%i"',
    'for /f "delims=" %i in (\'gemini --version 2^>nul\') do set "GEMINI_VERSION=%i"',
    'for /f "delims=" %i in (\'claude --version 2^>nul\') do set "CLAUDE_VERSION=%i"',
    'echo NODE_VERSION=%NODE_VERSION%',
    'echo NPM_VERSION=%NPM_VERSION%',
    'echo NVM_VERSION=%NVM_VERSION%',
    'echo CODEX_VERSION=%CODEX_VERSION%',
    'echo GEMINI_VERSION=%GEMINI_VERSION%',
    'echo CLAUDE_VERSION=%CLAUDE_VERSION%',
    'echo NODE_PATH=%NODE_PATH%',
    'echo NPM_PATH=%NPM_PATH%'
  ].join(" & ");
  return runLocalWindows(["/d", "/s", "/c", script], 1000 * 15);
}

async function runInteractivePosix(targetId: string, script: string, timeout = COMMAND_TIMEOUT): Promise<CommandOutput> {
  const encodedScript = encodeBashScript(script);
  if (isWslTarget(targetId) && process.platform === "win32") {
    const distro = parseWslDistro(targetId);
    return execCommand(getWindowsWslExe(), ["-d", distro, "--", "bash", "-lc", encodedScript], timeout);
  }
  return execCommand("bash", ["-lc", encodedScript], timeout);
}

function encodeBashScript(script: string) {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `printf %s ${quote(encoded)} | base64 -d | bash`;
}

function getWindowsWslExe() {
  const candidates = [
    process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "wsl.exe") : "",
    process.env.windir ? path.join(process.env.windir, "System32", "wsl.exe") : "",
    "C:\\Windows\\System32\\wsl.exe",
    "C:\\Windows\\Sysnative\\wsl.exe",
    "wsl.exe"
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === "wsl.exe" || fs.existsSync(candidate)) || "wsl.exe";
}

function buildEnvironmentMessages(input: {
  hasNode: boolean;
  hasNpm: boolean;
  hasNvm: boolean;
  canInstallNodeWithNvm: boolean;
  detectionError: string;
}) {
  const messages: string[] = [];
  if (input.detectionError) messages.push(`检测失败：${input.detectionError}`);
  if (!input.hasNode) messages.push("未检测到 Node.js。");
  if (!input.hasNpm) messages.push("未检测到 npm。");
  if ((!input.hasNode || !input.hasNpm) && !input.hasNvm) {
    messages.push("未检测到 nvm，请先安装 nvm 后再由应用安装 Node.js。");
  }
  if (input.canInstallNodeWithNvm && (!input.hasNode || !input.hasNpm)) {
    messages.push("可通过 nvm 安装推荐 Node.js 版本后继续安装 CLI。");
  }
  return messages;
}

function minimumNodeMajorForProvider(providerId: AiProviderId) {
  if (providerId === "codex") return 22;
  if (providerId === "gemini") return 20;
  return 18;
}

function cliVersionKey(providerId: AiProviderId) {
  if (providerId === "codex") return "CODEX_VERSION";
  if (providerId === "gemini") return "GEMINI_VERSION";
  return "CLAUDE_VERSION";
}

function parseNodeMajor(version?: string) {
  const match = /^v?(\d+)/.exec((version || "").trim());
  return match ? Number(match[1]) : undefined;
}

function isWslTarget(targetId: string) {
  return targetId.startsWith("wsl:") || targetId.startsWith("gemini:wsl:") || targetId.startsWith("claude:wsl:");
}

function parseWslDistro(targetId: string) {
  if (targetId.startsWith("gemini:wsl:")) return targetId.slice("gemini:wsl:".length);
  if (targetId.startsWith("claude:wsl:")) return targetId.slice("claude:wsl:".length);
  if (targetId.startsWith("wsl:")) return targetId.slice("wsl:".length);
  throw new Error("目标不是 WSL 环境。");
}

function currentPlatform(): CliEnvironmentStatus["platform"] {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

function shellJoin(args: string[]) {
  return args.map(quote).join(" ");
}

function quote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// 合并一次命令的 stdout/stderr 为单段文本（用于环境快照解析）。
export function mergeOutput(output: CommandOutput) {
  return [output.stdout.trim(), output.stderr.trim()].filter(Boolean).join("\n");
}

// 合并多段命令的同一路输出，丢弃空白段，用 \n\n 分隔。
export function mergeStreams(outputs: CommandOutput[], stream: keyof CommandOutput) {
  return outputs.map((output) => output[stream].trim()).filter(Boolean).join("\n\n");
}

// 安装失败时构造对外错误：把真实 stderr（其次 stdout）写进 message，
// 因为跨 IPC 只有 Error.message 会保留，自定义属性会被丢弃。
export function buildInstallError(error: any, priorOutputs: CommandOutput[]) {
  const failedStdout = (error?.stdout ?? "").toString().trim();
  const failedStderr = (error?.stderr ?? "").toString().trim();
  const detail = failedStderr || failedStdout || (error?.message ? String(error.message) : "") || "未知错误";
  const enriched = new Error(`CLI 安装失败：\n${detail}`) as Error & CommandOutput;
  enriched.stdout = [...priorOutputs.map((output) => output.stdout.trim()), failedStdout].filter(Boolean).join("\n\n");
  enriched.stderr = [...priorOutputs.map((output) => output.stderr.trim()), failedStderr].filter(Boolean).join("\n\n");
  return enriched;
}

function firstLine(value: string) {
  return value.trim().split(/\r?\n/).find(Boolean)?.trim() || "";
}
