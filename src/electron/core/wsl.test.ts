import { afterEach, describe, expect, it, vi } from "vitest";
import { attachSpawnTimeout, WSL_COMMAND_TIMEOUT_MS } from "./wsl";

// 健壮性回归：spawn 系 WSL 子进程没有内置超时，需靠看门狗在 WSL 挂起时 SIGKILL 并 reject，
// 正常结束时则必须取消计时器，避免误杀已完成的进程或泄漏定时器。

function fakeChild() {
  const killed: string[] = [];
  return {
    killed,
    child: { kill: (signal: string) => (killed.push(signal), true) } as any
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("attachSpawnTimeout", () => {
  it("超时后对子进程发 SIGKILL 并 reject，错误信息带上 label", () => {
    vi.useFakeTimers();
    const { child, killed } = fakeChild();
    const errors: Error[] = [];
    attachSpawnTimeout(child, (error) => errors.push(error), "读取 /home/me/x.jsonl");

    vi.advanceTimersByTime(WSL_COMMAND_TIMEOUT_MS);

    expect(killed).toEqual(["SIGKILL"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("WSL 操作超时");
    expect(errors[0].message).toContain("读取 /home/me/x.jsonl");
  });

  it("正常结束调用清理函数后，不再 kill 也不再 reject", () => {
    vi.useFakeTimers();
    const { child, killed } = fakeChild();
    const errors: Error[] = [];
    const clearTimer = attachSpawnTimeout(child, (error) => errors.push(error), "x");

    clearTimer();
    vi.advanceTimersByTime(WSL_COMMAND_TIMEOUT_MS * 3);

    expect(killed).toEqual([]);
    expect(errors).toEqual([]);
  });
});
