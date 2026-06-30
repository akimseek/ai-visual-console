import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

let logPath = "";

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

  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${line}\n`, "utf8");
  } catch {
    // 性能日志不能影响主功能。
  }
}
