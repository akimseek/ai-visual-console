import type { SessionStorage } from "./session-storage";

export type SessionLineParser<T> = {
  push: (line: string, lineNumber: number) => void | boolean | Promise<void | boolean>;
  finish: () => T;
};

// 统一会话解析的执行顺序；解析器本身仍由各 Provider 按文件格式实现。
export async function readSessionWithParser<T>(
  storage: SessionStorage,
  filePath: string,
  parser: SessionLineParser<T>,
  startLine = 1
): Promise<T> {
  await storage.readLines(filePath, parser.push, startLine);
  return parser.finish();
}
