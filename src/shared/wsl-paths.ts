import path from "node:path";
import type { CodexSessionFile } from "./types";

// 主进程 WSL / POSIX 路径处理的纯函数集合，集中于此以便单元测试覆盖。
// 这些函数承载安全边界（路径遍历防护、distro 名净化、WSL 输出解码），
// 从终端会话与 Codex 目标模块抽出，逻辑保持不变。
// targetId 的生成与解析在 ./target-ids.ts（无 Node 依赖，渲染进程可引用）。

// 将 WSL 的 /mnt/<盘符>/... 挂载路径转换为 Windows 原生路径；非挂载路径原样返回。
export function wslMountPathToWindowsPath(filePath: string) {
  const match = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(filePath);
  if (!match) return filePath;
  const drive = match[1].toUpperCase();
  const rest = (match[2] || "").replace(/\//g, "\\");
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

// 路径遍历防护（POSIX）：归一化后判断 filePath 是否严格位于 dirPath 之内。
// 先 normalize 再判断，可挫败 ../ 逃逸与 /a/sessions-evil 这类前缀混淆。
export function isInsidePosixDir(filePath: string, dirPath: string) {
  const normalizedFile = path.posix.normalize(filePath);
  const normalizedDir = path.posix.normalize(dirPath).replace(/\/+$/, "");
  return normalizedFile === normalizedDir || normalizedFile.startsWith(`${normalizedDir}/`);
}

// 路径遍历防护（本机 / win32）：基于相对路径判断 filePath 是否位于 dirPath 之内。
export function isInsidePath(filePath: string, dirPath: string) {
  const relative = path.relative(dirPath, filePath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

// 将 WSL 发行版名称净化为可安全用于缓存文件名的形式，阻断借 distro 名注入路径分隔符。
export function sanitizeWslDistro(distro: string) {
  return distro.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// 解析 `find ... -printf '%p\t%T@\t%s\n'` 的输出为会话文件列表，丢弃残缺/非法行。
export function parseWslSessionFileList(stdout: string): CodexSessionFile[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [filePath, mtime, size] = line.split("\t");
      return {
        filePath,
        mtimeMs: Number(mtime) * 1000,
        size: Number(size)
      };
    })
    .filter((file) => file.filePath && Number.isFinite(file.mtimeMs) && Number.isFinite(file.size));
}

// wsl.exe 的输出可能是 UTF-16LE 或 UTF-8，按去除 NUL 后的有效长度择优解码。
export function decodeWslOutput(output: Buffer) {
  const utf16 = output.toString("utf16le");
  const utf8 = output.toString("utf8");
  return utf16.replace(/\0/g, "").trim().length >= utf8.replace(/\0/g, "").trim().length ? utf16 : utf8;
}

// 单引号 shell 引用：bash/POSIX 通用转义。
export function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
