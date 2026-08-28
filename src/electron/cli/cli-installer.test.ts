import { describe, expect, it } from "vitest";
import { buildInstallError, enrichExecError, mergeOutput, mergeStreams } from "./cli-installer";

// D3 回归：CLI 安装失败时必须把命令的真实 stderr 透传到对外 message，
// 因为跨 IPC 只有 Error.message 会保留；成功时 stdout/stderr 需分流填充。

describe("enrichExecError", () => {
  it("把 execFile 失败时的 stdout/stderr 附在错误上，message 取 stderr 首行", () => {
    const raw = Object.assign(new Error("Command failed: npm install"), {
      stdout: "added 1 package\n",
      stderr: "npm ERR! code EACCES\nnpm ERR! permission denied\n"
    });
    const enriched = enrichExecError(raw);
    expect(enriched.message).toBe("npm ERR! code EACCES");
    expect(enriched.stderr).toContain("permission denied");
    expect(enriched.stdout).toContain("added 1 package");
  });

  it("无 stderr 时回退到 stdout 首行，再回退到原始 message", () => {
    expect(enrichExecError({ stdout: "boom\nmore", stderr: "" }).message).toBe("boom");
    expect(enrichExecError({ message: "Command failed" }).message).toBe("Command failed");
    expect(enrichExecError({}).message).toBe("命令执行失败。");
  });
});

describe("buildInstallError", () => {
  it("把失败命令的 stderr 写进对外 message（这是跨 IPC 唯一能传达的诊断）", () => {
    const raw = enrichExecError({ stderr: "npm ERR! 404 Not Found - GET https://registry/...\n" });
    const error = buildInstallError(raw, []);
    expect(error.message).toContain("CLI 安装失败：");
    expect(error.message).toContain("404 Not Found");
    expect(error.stderr).toContain("404 Not Found");
  });

  it("stderr 缺失时用 stdout，再缺失时用原始 message", () => {
    expect(buildInstallError({ stdout: "disk full" }, []).message).toContain("disk full");
    expect(buildInstallError({ message: "Command failed" }, []).message).toContain("Command failed");
    expect(buildInstallError({}, []).message).toContain("未知错误");
  });

  it("聚合先前成功步骤（如装 Node）的输出，便于完整复盘", () => {
    const prior = [{ stdout: "Now using node v24", stderr: "nvm warn: legacy" }];
    const error = buildInstallError({ stderr: "npm ERR! boom" }, prior);
    expect(error.stdout).toContain("Now using node v24");
    expect(error.stderr).toContain("nvm warn: legacy");
    expect(error.stderr).toContain("npm ERR! boom");
  });
});

describe("mergeOutput", () => {
  it("合并 stdout 与 stderr，去除首尾空白", () => {
    expect(mergeOutput({ stdout: "  a  ", stderr: "  b  " })).toBe("a\nb");
  });

  it("过滤空白段", () => {
    expect(mergeOutput({ stdout: "only-out", stderr: "   " })).toBe("only-out");
    expect(mergeOutput({ stdout: "", stderr: "" })).toBe("");
  });
});

describe("mergeStreams", () => {
  it("按指定流合并多段输出，用空行分隔并丢弃空白段", () => {
    const outputs = [
      { stdout: "step1-out", stderr: "" },
      { stdout: "  ", stderr: "step2-err" },
      { stdout: "step3-out", stderr: "" }
    ];
    expect(mergeStreams(outputs, "stdout")).toBe("step1-out\n\nstep3-out");
    expect(mergeStreams(outputs, "stderr")).toBe("step2-err");
  });
});
