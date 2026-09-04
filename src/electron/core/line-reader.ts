import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { attachSpawnTimeout, getWslExe } from "./wsl";

// 会话 JSONL 的流式逐行读取：本机与 WSL 一对，供各 provider 按 target.kind 二选一。
// 逐行回调而非整文件读入，配合 onLine 返回 false 可提前中止（分页、截断分支都依赖该语义）。

export type LineHandler = (line: string, lineNumber: number) => void | boolean | Promise<void | boolean>;

export async function readLocalLines(filePath: string, onLine: LineHandler, startLine = 1) {
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

export async function readWslLines(distro: string, filePath: string, onLine: LineHandler, startLine = 1) {
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
  let stoppedEarly = false;
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
        stoppedEarly = true;
        lines.close();
        child.stdout.destroy();
        child.kill("SIGKILL");
        await exit.catch(() => undefined);
        return;
      }
    }
    const code = await exit;
    if (timeoutError) throw timeoutError;
    // 提前停止时主动终止子进程，非零退出码是预期结果，不应误报为读取失败。
    if (stoppedEarly) return;
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
