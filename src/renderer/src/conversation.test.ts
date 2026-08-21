import { describe, expect, it } from "vitest";
import { buildConversationTurns, isVisibleConversationMessage } from "./conversation";
import type { AiMessage } from "./types";

function msg(role: AiMessage["role"], text: string): AiMessage {
  return { role, text, timestamp: "" } as AiMessage;
}

describe("isVisibleConversationMessage", () => {
  it("过滤 turn_aborted 与 permissions instructions", () => {
    expect(isVisibleConversationMessage(msg("assistant", "正常"))).toBe(true);
    expect(isVisibleConversationMessage(msg("assistant", "x<turn_aborted>y"))).toBe(false);
    expect(isVisibleConversationMessage(msg("user", "<permissions instructions>"))).toBe(false);
  });
});

describe("buildConversationTurns", () => {
  it("按用户消息切分轮次，助手回复归入当前轮", () => {
    const turns = buildConversationTurns([
      msg("user", "问题1"),
      msg("assistant", "回答1a"),
      msg("assistant", "回答1b"),
      msg("user", "问题2"),
      msg("assistant", "回答2")
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].user?.message.text).toBe("问题1");
    expect(turns[0].replies.map((r) => r.message.text)).toEqual(["回答1a", "回答1b"]);
    expect(turns[1].user?.message.text).toBe("问题2");
    expect(turns[1].replies).toHaveLength(1);
  });

  it("开头即助手回复时创建无 user 的轮次", () => {
    const turns = buildConversationTurns([msg("assistant", "孤立回复")]);
    expect(turns).toHaveLength(1);
    expect(turns[0].user).toBeUndefined();
    expect(turns[0].replies[0].message.text).toBe("孤立回复");
  });

  it("过滤不可见消息后再切分", () => {
    const turns = buildConversationTurns([
      msg("user", "<permissions instructions>"),
      msg("user", "真实问题"),
      msg("assistant", "y<turn_aborted>"),
      msg("assistant", "真实回答")
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].user?.message.text).toBe("真实问题");
    expect(turns[0].replies.map((r) => r.message.text)).toEqual(["真实回答"]);
  });

  it("保留原始消息索引（供分支裁剪使用）", () => {
    const turns = buildConversationTurns([msg("user", "a"), msg("assistant", "b")]);
    expect(turns[0].user?.index).toBe(0);
    expect(turns[0].replies[0].index).toBe(1);
  });

  it("分页窗口保留绝对消息索引", () => {
    const turns = buildConversationTurns([msg("user", "a"), msg("assistant", "b")], 200);
    expect(turns[0].user?.index).toBe(200);
    expect(turns[0].replies[0].index).toBe(201);
  });
});
