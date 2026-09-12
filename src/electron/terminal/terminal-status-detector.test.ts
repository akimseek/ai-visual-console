import { describe, expect, it } from "vitest";
import { TerminalStatusDetector, detectAttention } from "./terminal-status-detector";

describe("terminal status detector", () => {
  it("识别明确的确认提示而不误判普通文本", () => {
    expect(detectAttention("codex", "\nAllow this command? (y/n)" )?.kind).toBe("awaiting-confirmation");
    expect(detectAttention("codex", "1. Yes, proceed (y)\n2. Yes, and don't ask again (a)\n3. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel")?.kind).toBe("awaiting-confirmation");
    expect(detectAttention("codex", "The word permission is part of this answer") ).toBeUndefined();
  });

  it("识别错误与完成提示", () => {
    expect(detectAttention("gemini", "stream disconnected before completion: network error")?.kind).toBe("error");
    expect(detectAttention("codex", "\n› Ask Codex to do anything")?.kind).toBe("completed");
    expect(detectAttention("codex", "\n›") ).toBeUndefined();
    expect(detectAttention("codex", "\n❯") ).toBeUndefined();
  });

  it("跨输出块保留有限状态并在输入后发布运行状态", () => {
    const events: Array<{ status: string; attention?: { kind: string } }> = [];
    const detector = new TerminalStatusDetector("terminal-1", "codex", (event) => events.push(event));
    detector.markInput("hello\r");
    detector.inspectOutput("stream disconnected before ");
    detector.inspectOutput("completion: transport error\n");
    detector.inspectOutput("stream disconnected before completion: transport error\n");
    expect(events.map((event) => event.status)).toEqual(["running", "error"]);
  });

  it("同一轮中的重复输入不会清空缓冲并误判空闲提示", () => {
    const events: string[] = [];
    const detector = new TerminalStatusDetector("terminal-2", "codex", (event) => events.push(event.status));
    detector.markInput("hello");
    detector.markInput("world");
    detector.inspectOutput("working...\n›");
    expect(events).toEqual(["running"]);
  });

  it("方向键和终端控制序列不启动新轮次", () => {
    const events: string[] = [];
    const detector = new TerminalStatusDetector("terminal-controls", "codex", (event) => events.push(event.status));
    detector.markInput("\u001b[A");
    detector.markInput("\u001b[200~\u001b[201~");
    detector.markInput("\r");
    expect(events).toEqual([]);
  });

  it("不会把启动界面残留的空闲提示当成本轮完成", () => {
    const events: string[] = [];
    const detector = new TerminalStatusDetector("terminal-static-prompt", "codex", (event) => events.push(event.status));
    detector.markInput("hello");
    detector.inspectOutput("OpenAI Codex\n› Ask Codex to do anything");
    expect(events).toEqual(["running"]);
    detector.inspectOutput("assistant is still generating");
    expect(events).toEqual(["running"]);
    detector.inspectOutput("\n› Ask Codex to do anything");
    expect(events).toEqual(["running", "completed"]);
  });

  it("确认提示收到用户确认后重新进入运行态", () => {
    const events: string[] = [];
    const detector = new TerminalStatusDetector("terminal-3", "codex", (event) => events.push(event.status));
    detector.markInput("hello");
    detector.inspectOutput("Allow this command? (y/n)");
    detector.markInput("y\r");
    expect(events).toEqual(["running", "awaiting-confirmation", "running"]);
  });

  it("正常退出不生成完成提醒，启动后直接退出同样不提醒", () => {
    const events: string[] = [];
    const idle = new TerminalStatusDetector("idle", "codex", (event) => events.push(event.status));
    idle.markExit(0);
    expect(events).toEqual([]);

    const active = new TerminalStatusDetector("active", "codex", (event) => events.push(event.status));
    active.markInput("prompt\r");
    active.markExit(0);
    expect(events).toEqual(["running"]);
  });

  it("历史会话启动阶段异常退出不生成提醒", () => {
    const events: string[] = [];
    const detector = new TerminalStatusDetector("history", "codex", (event) => events.push(event.status));
    detector.markExit(1);
    expect(events).toEqual([]);
  });
});
