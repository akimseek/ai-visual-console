import fs from "node:fs/promises";
import path from "node:path";
import { readLocalLines, readWslLines, type LineHandler } from "../core/line-reader";
import { pathExists } from "../core/fs-utils";
import { runWslShell, wslPathExists, wslReadFile, wslRun, wslWriteFile } from "../core/wsl";
import { shellQuote } from "../../shared/wsl-paths";
import type { SessionFileKind } from "./session-file-ops";

export type SessionStorageContext = {
  kind: SessionFileKind;
  distro?: string;
};

export type SessionStorage = {
  readText(filePath: string): Promise<string>;
  writeText(filePath: string, content: string): Promise<void>;
  readLines(filePath: string, onLine: LineHandler, startLine?: number): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  move(source: string, destination: string, conflictMessage?: string): Promise<void>;
  remove(filePath: string): Promise<void>;
};

// 统一 Provider 的本机/WSL 会话文件 I/O；目录布局和 JSONL 解析仍由各 Provider 决定。
export function createSessionStorage(context: SessionStorageContext): SessionStorage {
  if (context.kind === "wsl") {
    if (!context.distro) throw new Error("缺少 WSL 发行版。");
    const distro = context.distro;
    return {
      readText: (filePath) => wslReadFile(distro, filePath),
      writeText: (filePath, content) => wslWriteFile(distro, filePath, content),
      readLines: (filePath, onLine, startLine = 1) => readWslLines(distro, filePath, onLine, startLine),
      exists: (filePath) => wslPathExists(distro, filePath),
      move: (source, destination, conflictMessage) => moveWslFile(distro, source, destination, conflictMessage),
      remove: (filePath) => removeWslFile(distro, filePath)
    };
  }

  return {
    readText: (filePath) => fs.readFile(filePath, "utf8"),
    writeText: async (filePath, content) => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
    },
    readLines: (filePath, onLine, startLine = 1) => readLocalLines(filePath, onLine, startLine),
    exists: (filePath) => pathExists(filePath),
    move: (source, destination, conflictMessage) => moveLocalFile(source, destination, conflictMessage),
    remove: (filePath) => fs.unlink(filePath)
  };
}

async function moveLocalFile(source: string, destination: string, conflictMessage?: string) {
  if (conflictMessage && await pathExists(destination)) throw new Error(conflictMessage);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
}

async function moveWslFile(distro: string, source: string, destination: string, conflictMessage?: string) {
  const conflictCheck = conflictMessage
    ? `if [ -e ${shellQuote(destination)} ]; then echo ${shellQuote(conflictMessage)} >&2; exit 17; fi`
    : "";
  await runWslShell(
    distro,
    [
      conflictCheck,
      `mkdir -p ${shellQuote(path.posix.dirname(destination))}`,
      `mv -- ${shellQuote(source)} ${shellQuote(destination)}`
    ].filter(Boolean).join("; ")
  );
}

async function removeWslFile(distro: string, filePath: string) {
  await wslRun(distro, "rm", ["-f", filePath]);
}

