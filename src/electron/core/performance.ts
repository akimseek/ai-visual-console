import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

let logPath = "";
let logWriteQueue = Promise.resolve();
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export function setPerformanceLogPath(filePath: string) {
  logPath = filePath;
}

export async function measure<T>(label: string, action: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await action();
    void writePerformanceLog(label, performance.now() - startedAt, "ok");
    return result;
  } catch (error) {
    void writePerformanceLog(label, performance.now() - startedAt, "error");
    throw error;
  }
}

export async function writePerformanceLog(label: string, durationMs: number, status = "ok") {
  if (!logPath) return;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    label,
    durationMs: Math.round(durationMs),
    status
  });

  const targetPath = logPath;
  const task = logWriteQueue.catch(() => undefined).then(async () => {
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const stat = await fs.stat(targetPath).catch(() => null);
      if (stat && stat.size >= MAX_LOG_BYTES) {
        await fs.rename(targetPath, `${targetPath}.1`).catch(async () => {
          await fs.unlink(`${targetPath}.1`).catch(() => undefined);
          await fs.rename(targetPath, `${targetPath}.1`);
        });
      }
      await fs.appendFile(targetPath, `${line}\n`, "utf8");
    } catch {
      // 性能日志不能影响主功能。
    }
  });
  logWriteQueue = task;
  await task;
}
