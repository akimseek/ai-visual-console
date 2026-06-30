import { describe, expect, it } from "vitest";
import {
  compressionPromptPreview,
  renderCompressionPrompt,
  validateCompressionPromptDraft
} from "./compressionPrompt";
import type { AiSession } from "./types";

describe("validateCompressionPromptDraft", () => {
  it("名称/内容缺失时分别报错", () => {
    expect(validateCompressionPromptDraft({ name: "", content: "" })).toEqual({
      name: "请输入提示名称。",
      content: "请输入提示内容。"
    });
  });
  it("合法草稿无错误", () => {
    expect(validateCompressionPromptDraft({ name: "摘要", content: "内容" })).toEqual({});
  });
});

describe("compressionPromptPreview", () => {
  it("取首个非空行", () => {
    expect(compressionPromptPreview("\n\n  第一行  \n第二行")).toBe("第一行");
  });
  it("空内容回退占位", () => {
    expect(compressionPromptPreview("   \n  ")).toBe("无内容");
  });
});

describe("renderCompressionPrompt", () => {
  const session = {
    id: "abc",
    title: "我的会话",
    cwd: "/work"
  } as AiSession;

  it("替换会话占位符", () => {
    const result = renderCompressionPrompt("ID={{session_id}} 标题={{ session_title }} 目录={{session_cwd}}", session);
    expect(result).toBe("ID=abc 标题=我的会话 目录=/work");
  });

  it("无 usage 时 Token/上下文回退为 -，模型回退为无记录说明", () => {
    expect(renderCompressionPrompt("{{session_model}}/{{session_token}}/{{session_context}}", session)).toBe(
      "当前会话没有模型状态记录/-/-"
    );
  });

  it("未知占位符原样保留", () => {
    expect(renderCompressionPrompt("{{unknown_key}}", session)).toBe("{{unknown_key}}");
  });

  it("无 session 时全部回退", () => {
    expect(renderCompressionPrompt("{{session_id}}", null)).toBe("-");
  });
});
