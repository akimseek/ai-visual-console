import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

// 所有 WSL 子进程调用的兜底超时：WSL 内核或挂载点挂起时，避免主进程被无限期阻塞。
export const WSL_COMMAND_TIMEOUT_MS = 60_000;

// 给 spawn 出的子进程挂看门狗：超时则 SIGKILL 并 reject；返回的清理函数在正常结束时取消计时器。
// execFile 自带 timeout 选项，无需此辅助；spawn 不带，故统一在此处理。
export function attachSpawnTimeout(child: ChildProcess, reject: (error: Error) => void, label: string) {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error(`WSL 操作超时（${WSL_COMMAND_TIMEOUT_MS} ms）：${label}`));
  }, WSL_COMMAND_TIMEOUT_MS);
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

async function getWslExe() {
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
