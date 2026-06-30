import type { ChildProcess } from "node:child_process";

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
