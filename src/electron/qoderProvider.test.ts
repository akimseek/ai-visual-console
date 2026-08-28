import { describe, expect, it } from "vitest";
import { buildQoderSessionStoragePaths, createQoderSessionParser, parseQoderModelList } from "./qoderProvider";

describe("parseQoderModelList", () => {
  it("解析 Qoder CLI 模型表并忽略表头、空行和 ANSI 前缀", () => {
    expect(parseQoderModelList("MODEL\n\u001b[32mAuto\u001b[0m\nQwen3.8-Max\n\n")).toEqual([
      { id: "Auto" },
      { id: "Qwen3.8-Max" }
    ]);
  });
});

describe("createQoderSessionParser", () => {
  it("读取 Qoder JSONL 的会话摘要、可见消息和用量", () => {
    const parser = createQoderSessionParser({
      filePath: "/tmp/qoder/projects/project/session.jsonl",
      mtimeMs: Date.parse("2026-08-27T10:00:00.000Z"),
      size: 512
    }, { maxMessages: 8 });

    parser.push(JSON.stringify({ type: "workspace-directories", sessionId: "session-1", directories: ["/work/demo"] }));
    parser.push(JSON.stringify({ type: "runtime-config", sessionId: "session-1", model: "Qwen3.8-Max" }));
    parser.push(JSON.stringify({
      type: "user",
      sessionId: "session-1",
      timestamp: "2026-08-27T09:00:00.000Z",
      cwd: "/work/demo",
      message: { role: "user", content: "请分析这个项目" }
    }));
    parser.push(JSON.stringify({
      type: "user",
      sessionId: "session-1",
      isMeta: true,
      message: { role: "user", content: "内部命令提示" }
    }));
    parser.push(JSON.stringify({
      type: "assistant",
      sessionId: "session-1",
      timestamp: "2026-08-27T09:01:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "我会先查看目录结构。" }],
        usage: { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 8, context_usage_ratio: 0.25 }
      }
    }));
    parser.push(JSON.stringify({ type: "ai-title", sessionId: "session-1", aiTitle: "项目分析" }));

    expect(parser.finish()).toMatchObject({
      id: "session-1",
      title: "项目分析",
      cwd: "/work/demo",
      model: "Qwen3.8-Max",
      messageCount: 2,
      preview: [
        { role: "user", text: "请分析这个项目" },
        { role: "assistant", text: "我会先查看目录结构。" }
      ],
      usage: {
        total: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 8, totalTokens: 23 },
        contextPercent: 25,
        source: "qoder-message-usage"
      }
    });
  });
});

describe("buildQoderSessionStoragePaths", () => {
  const context = { kind: "local" as const, configDir: "/tmp/qoder" };

  it("将会话 JSONL 与关联状态一起映射到应用回收站", () => {
    const paths = buildQoderSessionStoragePaths(
      context,
      "/tmp/qoder/projects/project-key/transcript.jsonl",
      "session-1",
      "active",
      "trash"
    );

    expect(paths).toEqual([
      {
        source: "/tmp/qoder/projects/project-key/session-1",
        destination: "/tmp/qoder/.visual-console-trash/projects/project-key/session-1"
      },
      {
        source: "/tmp/qoder/tasks/session-1",
        destination: "/tmp/qoder/.visual-console-trash/tasks/session-1"
      },
      {
        source: "/tmp/qoder/file-history/session-1",
        destination: "/tmp/qoder/.visual-console-trash/file-history/session-1"
      },
      {
        source: "/tmp/qoder/logs/sessions/project-key/session-1",
        destination: "/tmp/qoder/.visual-console-trash/logs/sessions/project-key/session-1"
      },
      {
        source: "/tmp/qoder/projects/project-key/transcript.jsonl",
        destination: "/tmp/qoder/.visual-console-trash/projects/project-key/transcript.jsonl",
        primary: true
      }
    ]);
  });

  it("从回收站恢复时保留原始相对路径", () => {
    const paths = buildQoderSessionStoragePaths(
      context,
      "/tmp/qoder/.visual-console-trash/projects/project-key/transcript.jsonl",
      "session-1",
      "trash",
      "active"
    );

    expect(paths.at(-1)).toEqual({
      source: "/tmp/qoder/.visual-console-trash/projects/project-key/transcript.jsonl",
      destination: "/tmp/qoder/projects/project-key/transcript.jsonl",
      primary: true
    });
  });

  it("拒绝 projects 根以外或嵌套层级不符合约定的路径", () => {
    expect(() => buildQoderSessionStoragePaths(context, "/tmp/other/session.jsonl", "session-1", "active", "trash"))
      .toThrow("拒绝操作 Qoder projects 目录之外的会话文件。");
    expect(() => buildQoderSessionStoragePaths(context, "/tmp/qoder/projects/a/nested/session.jsonl", "session-1", "active", "trash"))
      .toThrow("拒绝操作 Qoder projects 目录之外的会话文件。");
  });
});
