import type { AiProviderId, TerminalAttentionKind, TerminalStatusEvent } from "../types";

const MAX_BUFFER_CHARS = 32 * 1024;

type Detection = {
  kind: TerminalAttentionKind;
  title: string;
  detail?: string;
};

// PTY 输出按任意边界到达，检测器只保留最近一小段可识别文本，避免大段恢复历史占用内存。
export class TerminalStatusDetector {
  private buffer = "";
  private turnActive = false;
  private hasUserSubmittedInput = false;
  private turnId = 0;
  private lastStatus: TerminalStatusEvent["status"] | undefined;
  private lastAttentionKey = "";
  private promptWasVisible = false;
  private promptDisappeared = false;
  private sawOutputWithoutPrompt = false;

  constructor(
    private readonly terminalId: string,
    private readonly providerId: AiProviderId,
    private readonly emit: (event: TerminalStatusEvent) => void
  ) {}

  markInput(data: string) {
    if (!hasUserInput(data)) return;
    // 同一轮中的后续输入（例如确认授权或补充终端按键）不应重置检测缓冲，
    // 否则运行中的界面重绘可能把旧的空闲提示误判成“本轮已完成”。
    if (this.turnActive && this.lastStatus !== "awaiting-confirmation") return;
    if (!this.turnActive) this.turnId += 1;
    this.hasUserSubmittedInput = true;
    this.turnActive = true;
    this.buffer = "";
    this.promptWasVisible = false;
    this.promptDisappeared = false;
    this.sawOutputWithoutPrompt = false;
    this.publish({ status: "running" });
  }

  inspectOutput(data: string) {
    if (!this.turnActive || !data) return;
    this.buffer = `${this.buffer}${stripAnsi(data)}`.slice(-MAX_BUFFER_CHARS);
    const promptVisible = isPrompt(this.providerId, this.buffer);
    if (!promptVisible) {
      this.sawOutputWithoutPrompt = true;
      if (this.promptWasVisible) this.promptDisappeared = true;
    }
    const detection = detectAttention(this.providerId, this.buffer);
    if (!detection) return;
    if (detection.kind === "completed") {
      if (!promptVisible) {
        return;
      }
      const canComplete = this.sawOutputWithoutPrompt && (!this.promptWasVisible || this.promptDisappeared);
      this.promptWasVisible = true;
      if (!canComplete) return;
    }
    this.turnActive = detection.kind !== "completed" && detection.kind !== "error";
    this.publish({ status: detection.kind, attention: detection });
  }

  markExit(exitCode: number) {
    if (exitCode === 0) {
      // 进程正常退出只表示终端生命周期结束，不代表助手完成了一轮回答。
      // 历史会话启动、CLI 自行结束或恢复失败都不应伪造“本轮已完成”提醒。
      this.turnActive = false;
      return;
    }
    this.turnActive = false;
    if (!this.hasUserSubmittedInput) return;
    this.publish({
      status: "error",
      attention: {
        kind: "error",
        title: "会话异常停止",
        detail: `进程退出码 ${exitCode}`
      }
    });
  }

  private publish(event: Omit<TerminalStatusEvent, "terminalId" | "updatedAt">) {
    const attentionKey = event.attention ? `${event.attention.kind}\0${event.attention.title}\0${event.attention.detail || ""}` : "";
    if (this.lastStatus === event.status && attentionKey === this.lastAttentionKey) return;
    this.lastStatus = event.status;
    this.lastAttentionKey = attentionKey;
    this.emit({ ...event, terminalId: this.terminalId, turnId: this.turnId || undefined, updatedAt: Date.now() });
  }
}

export function detectAttention(providerId: AiProviderId, text: string): Detection | undefined {
  const normalized = text.replace(/\r/g, "");
  if (isConfirmationPrompt(providerId, normalized)) {
    return {
      kind: "awaiting-confirmation",
      title: "等待确认",
      detail: "终端正在等待你的确认或授权。"
    };
  }
  const error = findError(normalized);
  if (error) return { kind: "error", title: "会话出现异常", detail: error };
  if (isPrompt(providerId, normalized)) return { kind: "completed", title: "本轮已完成" };
  return undefined;
}

function hasUserInput(data: string) {
  return stripAnsi(data).replace(/[\u0000-\u001f\u007f\r\n]/g, "").trim().length > 0;
}

function stripAnsi(value: string) {
  return value
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, "")
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
}

function isConfirmationPrompt(providerId: AiProviderId, text: string) {
  const tail = text.slice(-2400);
  if (/Press enter to confirm\s+or\s+esc to cancel\s*$/i.test(tail)) return true;
  if (/\b(?:Yes, proceed|Yes, and don't ask again|No, and tell Codex what to do differently)\b[^\n]*\n(?:[^\n]*\n){0,3}\s*Press enter to confirm/i.test(tail)) return true;
  if (/\b(?:y\/n|yes\/no|allow|approve|confirm)\b\s*[:?]?\s*$/i.test(tail)) return true;
  if (/(?:Would you like to run|Do you want to proceed|Approve this command|Permission required|需要确认|请求授权|是否执行)[^\n]{0,120}[?：:]?\s*$/iu.test(tail)) return true;
  if (/(?:是否允许|是否继续|确认执行|需要授权|请求提权|允许此操作)\s*[：:]?\s*$/u.test(tail)) return true;
  if (providerId === "codex" && /(?:Allow|Approve|Run command)\s*\[[^\]]+\]/i.test(tail)) return true;
  return false;
}

function findError(text: string) {
  const patterns = [
    /stream disconnected before completion[^\n]*/i,
    /transport error[^\n]*/i,
    /conversation interrupted[^\n]*/i,
    /(?:fatal error|unhandled exception)[^\n]*/i,
    /(?:codex|gemini|claude|qoder)\s+(?:已退出|退出)[^\n]*/i
  ];
  const match = patterns.map((pattern) => text.match(pattern)).find(Boolean);
  return match?.[0]?.trim().slice(0, 240);
}

function isPrompt(providerId: AiProviderId, text: string) {
  const tail = text.slice(-1200);
  if (providerId === "codex") return /(?:^|\n)\s*[›❯]\s*Ask Codex to do anything\s*$/u.test(tail);
  if (providerId === "gemini") return /(?:^|\n)\s*[›❯]\s*Ask Gemini to do anything\s*$/u.test(tail);
  if (providerId === "claude") return /(?:^|\n)\s*[›❯]\s*Ask Claude to do anything\s*$/u.test(tail);
  return /(?:^|\n)\s*[›❯>]\s*Ask (?:Qoder|anything) to do anything\s*$/iu.test(tail);
}
