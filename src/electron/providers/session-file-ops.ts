import path from "node:path";
import { isInsidePath, isInsidePosixDir } from "../../shared/wsl-paths";

export type SessionFileKind = "local" | "wsl";

// 会话文件操作共用的路径边界层。这里只计算和校验路径，不执行文件移动或删除。
// 实际 I/O 仍由各 Provider 控制，以保留不同 CLI 的目录布局和错误语义。
export function isInsideSessionRoot(filePath: string, root: string, kind: SessionFileKind) {
  return kind === "wsl" ? isInsidePosixDir(filePath, root) : isInsidePath(filePath, root);
}

export function assertSessionFileInside(
  filePath: string,
  root: string,
  kind: SessionFileKind,
  message: string
) {
  if (!isInsideSessionRoot(filePath, root, kind) || sameSessionPath(filePath, root, kind)) {
    throw new Error(message);
  }
}

// 将源文件在根目录下的相对位置映射到新根目录，供回收站和恢复操作复用。
export function relocateSessionPath(
  filePath: string,
  sourceRoot: string,
  destinationRoot: string,
  kind: SessionFileKind,
  message: string
) {
  assertSessionFileInside(filePath, sourceRoot, kind, message);
  const relative = kind === "wsl"
    ? path.posix.relative(path.posix.normalize(sourceRoot), path.posix.normalize(filePath))
    : path.relative(path.resolve(sourceRoot), path.resolve(filePath));
  return kind === "wsl"
    ? path.posix.join(destinationRoot, relative)
    : path.join(destinationRoot, relative);
}

function sameSessionPath(left: string, right: string, kind: SessionFileKind) {
  return kind === "wsl"
    ? path.posix.normalize(left) === path.posix.normalize(right)
    : path.resolve(left) === path.resolve(right);
}
