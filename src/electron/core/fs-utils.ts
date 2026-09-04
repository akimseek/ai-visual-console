import fs from "node:fs/promises";
import path from "node:path";

export async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// 本机路径边界判断：先解析绝对路径，避免相对路径和 `..` 绕过目录约束。
// 允许传入目录本身，调用方若只接受子项可额外判断 relative 是否为空。
export function isInsideLocalPath(filePath: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
