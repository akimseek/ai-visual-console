// 从任意形态的 Error 中提取可读消息，用于 catch 子句统一处理。
// 覆盖 Error 对象、含 message 属性的对象、字符串 reject、以及 IPC 返回的结构化错误。
// 替换全仓 43 处 `catch (error: any) { setXxxError(error?.message || "默认文案") }` 中的手动提取。

export function extractErrorMessage(error: unknown, fallback = "操作失败。"): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    // IPC 错误：`{ error: "message" }` 或 `{ message: "..." }`
    const obj = error as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error) return obj.error;
    if (typeof obj.message === "string" && obj.message) return obj.message;
  }
  return fallback;
}

// 在 catch 中同时打印错误到 console 再返回可读消息。
// 确保生产环境排障有迹可循，同时给用户友好提示。
export function captureError(error: unknown, context?: string, fallback = "操作失败。"): string {
  const message = extractErrorMessage(error, fallback);
  const prefix = context ? `[${context}]` : "";
  console.error(`${prefix} ${message}`, error);
  return message;
}
