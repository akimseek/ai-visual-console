import { describe, expect, it } from "vitest";
import {
  createSessionContentParser,
  extractMessage,
  extractModelStatus,
  extractUsage,
  parseSessionContent,
  safeJsonParse,
  shouldKeepMessage
} from "./sessionParser";

function jsonl(...lines: unknown[]) {
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

const VALID_ID = "11111111-2222-3333-4444-555555555555";
const FILE = `/home/u/.codex/sessions/rollout-2026-01-02T03-04-05-${VALID_ID}.jsonl`;

describe("safeJsonParse", () => {
  it("解析合法 JSON", () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  it("非法 JSON 返回 null（不抛错）", () => {
    expect(safeJsonParse("{not json")).toBeNull();
    expect(safeJsonParse("")).toBeNull();
  });
});

describe("parseSessionContent", () => {
  it("支持逐行解析完整会话", () => {
    const parser = createSessionContentParser(FILE);
    parser.push(JSON.stringify({ type: "session_meta", payload: { id: VALID_ID, cwd: "/work" } }));
    parser.push(JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "流式加载" } }));
    parser.push(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "完成" } }));

    const session = parser.finish();
    expect(session).toMatchObject({ id: VALID_ID, cwd: "/work", title: "流式加载", messageCount: 2 });
  });

  it("解析 session_meta 与对话，并用首条用户消息作标题", () => {
    const content = jsonl(
      { type: "session_meta", timestamp: "2026-01-02T03:04:05Z", payload: { id: VALID_ID, cwd: "/work", cli_version: "1.2.3" } },
      { type: "event_msg", timestamp: "2026-01-02T03:04:06Z", payload: { type: "user_message", message: "帮我写个函数" } },
      { type: "event_msg", timestamp: "2026-01-02T03:04:07Z", payload: { type: "agent_message", message: "好的" } }
    );
    const session = parseSessionContent(FILE, content);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(VALID_ID);
    expect(session!.cwd).toBe("/work");
    expect(session!.cliVersion).toBe("1.2.3");
    expect(session!.title).toBe("帮我写个函数");
    expect(session!.messageCount).toBe(2);
    expect(session!.preview.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("跳过非法 JSON 行，不影响整体解析", () => {
    const content = [
      "{garbage",
      JSON.stringify({ type: "session_meta", payload: { id: VALID_ID } }),
      "",
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } })
    ].join("\n");
    const session = parseSessionContent(FILE, content);
    expect(session!.id).toBe(VALID_ID);
    expect(session!.messageCount).toBe(1);
  });

  it("无 session_meta 时从文件名回退提取 id", () => {
    const content = jsonl({ type: "event_msg", payload: { type: "user_message", message: "hi" } });
    const session = parseSessionContent(FILE, content);
    expect(session!.id).toBe(VALID_ID);
  });

  it("既无 id 也无法从文件名提取时返回 null", () => {
    const content = jsonl({ type: "event_msg", payload: { type: "user_message", message: "hi" } });
    expect(parseSessionContent("/x/not-a-rollout.jsonl", content)).toBeNull();
  });

  it("过滤合成用户块（不作为标题/消息）", () => {
    const content = jsonl(
      { type: "session_meta", payload: { id: VALID_ID } },
      { type: "event_msg", payload: { type: "user_message", message: "<environment_context>系统注入</environment_context>" } },
      { type: "event_msg", payload: { type: "user_message", message: "真实问题" } }
    );
    const session = parseSessionContent(FILE, content);
    expect(session!.messageCount).toBe(1);
    expect(session!.title).toBe("真实问题");
  });

  it("折叠连续重复消息", () => {
    const content = jsonl(
      { type: "session_meta", payload: { id: VALID_ID } },
      { type: "event_msg", payload: { type: "agent_message", message: "重复" } },
      { type: "event_msg", payload: { type: "agent_message", message: "重复" } }
    );
    const session = parseSessionContent(FILE, content);
    expect(session!.messageCount).toBe(1);
  });
});

describe("extractMessage", () => {
  it("event_msg 用户/助手角色映射", () => {
    expect(extractMessage({ type: "event_msg", payload: { type: "user_message", message: "a" } })).toEqual({
      role: "user",
      text: "a"
    });
    expect(extractMessage({ type: "event_msg", payload: { type: "agent_message", message: "b" } })).toEqual({
      role: "assistant",
      text: "b"
    });
  });

  it("response_item 从 content 数组拼接文本", () => {
    const message = extractMessage({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ text: "第一段" }, { output_text: "第二段" }] }
    });
    expect(message).toEqual({ role: "assistant", text: "第一段\n第二段" });
  });

  it("无可识别内容返回 null", () => {
    expect(extractMessage({ type: "response_item", payload: { type: "message", role: "user", content: [] } })).toBeNull();
    expect(extractMessage({ type: "other", payload: {} })).toBeNull();
  });
});

describe("extractUsage", () => {
  it("从 token_count 事件解析用量与上下文剩余比例", () => {
    const usage = extractUsage({
      type: "event_msg",
      timestamp: "2026-01-02T03:04:08Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          last_token_usage: { input_tokens: 2000 },
          model_context_window: 10000
        }
      }
    });
    expect(usage).not.toBeNull();
    expect(usage!.total?.totalTokens).toBe(150);
    expect(usage!.contextWindow).toBe(10000);
    expect(usage!.contextUsedTokens).toBe(2000);
    expect(usage!.contextPercent).toBe(20);
    expect(usage!.contextLeftPercent).toBe(80);
    expect(usage!.source).toBe("codex-token-count");
  });

  it("非 token_count 事件返回 null", () => {
    expect(extractUsage({ type: "event_msg", payload: { type: "user_message", message: "x" } })).toBeNull();
  });
});

describe("extractModelStatus", () => {
  it("session_meta 提取 model / provider", () => {
    expect(
      extractModelStatus({ type: "session_meta", payload: { model: "gpt-5-codex", model_provider: "openai" } })
    ).toEqual({ model: "gpt-5-codex", modelProvider: "openai" });
  });

  it("turn_context 提取 reasoning / model", () => {
    const status = extractModelStatus({
      type: "turn_context",
      payload: { effort: "high", summary: "auto", collaboration_mode: { settings: { model: "gpt-5" } } }
    });
    expect(status).toEqual({ model: "gpt-5", reasoning: "high", summaries: "auto", modelProvider: "" });
  });

  it("无相关字段返回 null", () => {
    expect(extractModelStatus({ type: "turn_context", payload: {} })).toBeNull();
  });
});

describe("shouldKeepMessage", () => {
  it("空白文本丢弃，合成块丢弃，正常文本保留", () => {
    expect(shouldKeepMessage({ text: "   " })).toBe(false);
    expect(shouldKeepMessage({ text: "<skill>x</skill>" })).toBe(false);
    expect(shouldKeepMessage({ text: "正常" })).toBe(true);
  });
});
