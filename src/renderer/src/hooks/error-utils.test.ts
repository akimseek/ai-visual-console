import { describe, expect, it, vi } from "vitest";
import { extractErrorMessage, captureError } from "./error-utils";

describe("extractErrorMessage", () => {
  it("提取 Error 对象的 message", () => {
    expect(extractErrorMessage(new Error("foo"))).toBe("foo");
  });

  it("Error 对象无 message 时回退到 fallback", () => {
    expect(extractErrorMessage(new Error(""), "默认")).toBe("默认");
  });

  it("处理字符串 reject", () => {
    expect(extractErrorMessage("foo")).toBe("foo");
  });

  it("处理 IPC 结构化错误 { error: ... }", () => {
    expect(extractErrorMessage({ error: "foo" })).toBe("foo");
  });

  it("处理 { message: ... }", () => {
    expect(extractErrorMessage({ message: "foo" })).toBe("foo");
  });

  it("处理 null/undefined", () => {
    expect(extractErrorMessage(null, "fallback")).toBe("fallback");
    expect(extractErrorMessage(undefined, "fallback")).toBe("fallback");
  });

  it("处理非错误对象", () => {
    expect(extractErrorMessage(42, "fallback")).toBe("fallback");
  });
});

describe("captureError", () => {
  it("返回 extractErrorMessage 的结果", () => {
    expect(captureError(new Error("foo"))).toBe("foo");
  });

  it("带 context 前缀打印到 console", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    captureError(new Error("foo"), "test");
    expect(spy).toHaveBeenCalledWith("[test] foo", expect.any(Error));
    spy.mockRestore();
  });
});