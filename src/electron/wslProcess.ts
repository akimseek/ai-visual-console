import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

// 所有 WSL 子进程调用的兜底超时：WSL 内核或挂载点挂起时，避免主进程被无限期阻塞。
export const WSL_COMMAND_TIMEOUT_MS = 60_000;

// 给 spawn 出的子进程挂看门狗：超时则 SIGKILL 并 reject；返回的清理函数在正常结束时取消计时器。
// execFile 自带 timeout 选项，无需此辅助；spawn 不带，故统一在此处理。
export function attachSpawnTimeout(
  child: ChildProcess,
  reject: (error: Error) => void,
  label: string,
  timeoutMs: number = WSL_COMMAND_TIMEOUT_MS
) {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error(`WSL 操作超时（${timeoutMs} ms）：${label}`));
  }, timeoutMs);
  return () => clearTimeout(timer);
}

export async function readLocalLines(
  filePath: string,
  onLine: (line: string, lineNumber: number) => void | boolean | Promise<void | boolean>,
  startLine = 1
) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (lineNumber < startLine) continue;
      if ((await onLine(line, lineNumber)) === false) break;
    }
  } finally {
    input.destroy();
  }
}

export async function readWslLines(
  distro: string,
  filePath: string,
  onLine: (line: string, lineNumber: number) => void | boolean | Promise<void | boolean>,
  startLine = 1
) {
  const wslExe = await getWslExe();
  if (!wslExe) throw new Error("未找到 wsl.exe。");

  const command = startLine > 1 ? "tail" : "cat";
  const args = startLine > 1 ? ["-n", `+${startLine}`, filePath] : [filePath];
  const child = spawn(wslExe, ["-d", distro, "--", command, ...args], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderr: Buffer[] = [];
  let timeoutError: Error | null = null;
  let processClosed = false;
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      processClosed = true;
      resolve(code);
    });
  });
  const clearTimer = attachSpawnTimeout(child, (error) => {
    timeoutError = error;
  }, `读取 ${filePath}`);
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let lineNumber = startLine - 1;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      if ((await onLine(line, lineNumber)) === false) {
        lines.close();
        child.stdout.destroy();
        child.kill("SIGKILL");
        await exit.catch(() => undefined);
        return;
      }
    }
    const code = await exit;
    if (timeoutError) throw timeoutError;
    if (code !== 0) throw new Error(Buffer.concat(stderr).toString("utf8").trim() || `cat 退出码：${code}`);
  } catch (error) {
    if (!processClosed) {
      lines.close();
      child.stdout.destroy();
      child.kill("SIGKILL");
      await exit.catch(() => undefined);
    }
    throw error;
  } finally {
    clearTimer();
  }
}

export async function getWslExe() {
  const candidates = process.platform === "win32"
    ? [
        process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "wsl.exe") : "",
        process.env.windir ? path.join(process.env.windir, "System32", "wsl.exe") : "",
        "C:\\Windows\\System32\\wsl.exe",
        "C:\\Windows\\Sysnative\\wsl.exe",
        "wsl.exe"
      ]
    : ["/mnt/c/Windows/System32/wsl.exe"];

  for (const candidate of candidates.filter(Boolean)) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    return candidate;
  }
  return null;
}

// 单引号 shell 引用：bash/POSIX 通用转义。
export function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// 在指定 WSL 发行版内执行 bash 脚本（base64 透传避免参数转义），返回 stdout。
// 统一了此前散落在 vendorManager 中的私有实现，供网关地址探测等场景复用。
export async function runWslShell(distro: string, script: string, timeoutMs: number = WSL_COMMAND_TIMEOUT_MS) {
  const wslExe = await getWslExe();
  if (!wslExe) throw new Error("未找到 wsl.exe。");
  const encodedScript = Buffer.from(script, "utf8").toString("base64");
  const shellScript = `printf %s ${shellQuote(encodedScript)} | base64 -d | bash`;
  return new Promise<string>((resolve, reject) => {
    const child = spawn(wslExe, ["-d", distro, "--", "bash", "-lc", shellScript], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const clearTimer = attachSpawnTimeout(child, reject, `WSL 执行（${distro}）`, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimer(); reject(error); });
    child.on("close", (code) => {
      clearTimer();
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `WSL 执行失败，退出码 ${code}`));
    });
    child.stdin.end();
  });
}

// 在 WSL 内探测可达宿主网关的网络地址。
// 顺序：mirrored/localhost 转发直连 127.0.0.1 → 默认路由网关 → resolv.conf nameserver → 退回 127.0.0.1。
// 用于 WSL2 NAT 模式下让 CLI 进程访问宿主上的本地 Gateway。
const WSL_GATEWAY_DETECT_TIMEOUT_MS = 5_000;

export async function detectWslGatewayHost(distro: string, port: number): Promise<string> {
  const script = [
    "set -e",
    `port=${port}`,
    // 1. mirrored 模式或 localhost 转发：127.0.0.1 直连
    "if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then exec 3>&- 3<&-; echo 127.0.0.1; exit 0; fi",
    // 2. NAT 模式：默认路由网关通常即宿主
    "host=$(ip route show default 2>/dev/null | awk '{print $3; exit}')",
    'if [ -n "$host" ]; then echo "$host"; exit 0; fi',
    // 3. 退路：resolv.conf nameserver
    "awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null || echo 127.0.0.1"
  ].join("\n");
  const result = await runWslShell(distro, script, WSL_GATEWAY_DETECT_TIMEOUT_MS);
  const host = result.trim().split("\n").pop()?.trim() || "127.0.0.1";
  return host || "127.0.0.1";
}
