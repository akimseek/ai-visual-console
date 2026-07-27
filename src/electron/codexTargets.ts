import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { CodexSession, CodexSessionFile, CodexTarget, SessionBatchMutationResult, SessionFileRef, SessionMutationRef } from "./types";
import {
  deleteSession as deleteLocalSession,
  deleteSessions as deleteLocalSessions,
  getCodexHome,
  getCachePath,
  getTrashRoot,
  getTrashCachePath,
  listCachedSessions as listCachedSessionsFromCache,
  listSessions as listLocalSessions,
  listTrashSessions as listLocalTrashSessions,
  listSessionsFromFiles,
  purgeSession as purgeLocalSession,
  readSessionFile,
  readSessionFileLines,
  removeSessionFromCache,
  removeSessionsFromCache,
  restoreSession as restoreLocalSession
} from "./codexStore";
import {
  clearWslCodexHomeOverride,
  getCachedTargets,
  getWslCodexHomeOverride,
  setCachedTargets,
  setWslCodexHomeOverride
} from "./settings";
import { applySessionMetadata, applySessionMetadataList, setSessionBranchMetadata } from "./sessionMetadata";
import { measure } from "./performance";
import {
  createSessionContentParser,
  extractMessage,
  parseSessionContent,
  safeJsonParse,
  shouldKeepMessage,
  type SessionLine
} from "../shared/sessionParser";
import {
  decodeWslOutput,
  isInsidePath,
  isInsidePosixDir,
  parseWslSessionFileList,
  sanitizeWslDistro
} from "../shared/wslPaths";
import { WSL_COMMAND_TIMEOUT_MS, attachSpawnTimeout } from "./wslProcess";

const execFileAsync = promisify(execFile);
const INTERNAL_WSL_DISTROS = new Set(["docker-desktop", "docker-desktop-data"]);
let targetsCache: { at: number; targets: CodexTarget[] } | null = null;
let targetsInFlight: Promise<CodexTarget[]> | null = null;
const TARGETS_CACHE_TTL_MS = 30_000;
const MAX_WSL_SESSION_READ_BYTES = 32 * 1024 * 1024;

export async function listTargets(): Promise<CodexTarget[]> {
  return measure("targets.list", listTargetsInner);
}

export async function listCachedTargets(): Promise<CodexTarget[]> {
  return (await getCachedTargets()).filter((target) => (target.provider || "codex") === "codex");
}

export async function listCachedSessions(targetId: string, view: "active" | "trash"): Promise<CodexSession[]> {
  if (targetId === "local") {
    return applySessionMetadataList(targetId, await listCachedSessionsFromCache(view === "trash" ? getTrashCachePath() : getCachePath()));
  }

  if (targetId.startsWith("wsl:")) {
    const distro = targetId.slice("wsl:".length);
    if (!distro) return [];
    return applySessionMetadataList(targetId, await listCachedSessionsFromCache(getWslCachePath(distro, view)));
  }

  return [];
}

async function listTargetsInner(): Promise<CodexTarget[]> {
  if (targetsCache && Date.now() - targetsCache.at < TARGETS_CACHE_TTL_MS) {
    return targetsCache.targets;
  }

  // 复用进行中的探测：两个并发请求若同时穿透 TTL，会各自重复一遍 wsl.exe 探测。
  // 缓存“进行中的 Promise”可让并发调用合流为一次探测。
  if (!targetsInFlight) {
    targetsInFlight = probeAllTargets().finally(() => {
      targetsInFlight = null;
    });
  }
  return targetsInFlight;
}

async function probeAllTargets(): Promise<CodexTarget[]> {
  const localTarget = await probeLocalTarget();

  const distros = await listWslDistros();
  const wslTargets = (
    await Promise.all(
      distros.map(async (distro): Promise<CodexTarget> => {
        const overrideCodexHome = await getWslCodexHomeOverride(distro);
        const probe = overrideCodexHome ? null : await probeWslDistro(distro);
        const codexHome = overrideCodexHome || probe?.codexHome;
        return {
          id: `wsl:${distro}`,
          provider: "codex",
          label: `WSL：${distro}`,
          kind: "wsl" as const,
          distro,
          codexHome,
          available: true,
          detail: overrideCodexHome ? `使用手动路径 ${overrideCodexHome}` : probe?.detail || "可进入 WSL，未找到 Codex 目录"
        };
      })
    )
  );

  const targets = process.platform === "win32"
    ? localTarget ? [...wslTargets, localTarget] : wslTargets
    : localTarget ? [localTarget, ...wslTargets] : wslTargets;
  targetsCache = { at: Date.now(), targets };
  await setCachedTargets(targets);
  return targets;
}

export async function listSessions(targetId: string): Promise<CodexSession[]> {
  return measure(`sessions.list.${targetId}`, async () => {
    const target = await resolveTarget(targetId);
    if (target.kind === "local") return applySessionMetadataList(targetId, await listLocalSessions());

    const codexHome = target.codexHome || (await resolveWslCodexHome(target.distro!));
    const files = await wslListSessionFiles(target.distro!, codexHome);
    const sessions = await listSessionsFromFiles(files, {
      readFile: (filePath) => wslReadSessionFile(target.distro!, filePath),
      readListFile: (filePath) => wslReadFileHead(target.distro!, filePath),
      cachePath: getWslCachePath(target.distro!),
      writeCache: true,
      lightweight: true
    });
    return applySessionMetadataList(targetId, sessions);
  });
}

export async function listTrashSessions(targetId: string): Promise<CodexSession[]> {
  return measure(`sessions.trash.list.${targetId}`, async () => {
    const target = await resolveTarget(targetId);
    if (target.kind === "local") return applySessionMetadataList(targetId, await listLocalTrashSessions());

    const codexHome = target.codexHome || (await resolveWslCodexHome(target.distro!));
    const files = await wslListTrashSessionFiles(target.distro!, codexHome);
    const sessions = await listSessionsFromFiles(files, {
      readFile: (filePath) => wslReadSessionFile(target.distro!, filePath),
      readListFile: (filePath) => wslReadFileHead(target.distro!, filePath),
      cachePath: getWslCachePath(target.distro!, "trash"),
      writeCache: true,
      lightweight: true
    });
    return applySessionMetadataList(targetId, sessions);
  });
}

export async function getSession(targetId: string, sessionId: string) {
  return measure(`sessions.get.${targetId}`, async () => {
    const target = await resolveTarget(targetId);
    if (target.kind === "local") {
      const source = await findLocalSessionFile(sessionId);
      return applySessionMetadata(targetId, await loadLocalSession(source));
    }

    const source = await findWslAnySessionFile(targetId, sessionId);
    return applySessionMetadata(targetId, await loadWslSession(target.distro!, source));
  });
}

export async function listSessionsByParent(targetId: string, parentSessionId: string): Promise<CodexSession[]> {
  return measure(`sessions.children.${targetId}`, async () => {
    const target = await resolveTarget(targetId);
    const sessions = target.kind === "local"
      ? await applySessionMetadataList(targetId, await listLocalSessions())
      : await listSessions(targetId);
    return sessions.filter((session) => session.metadata?.branch?.parentSessionId === parentSessionId);
  });
}

export async function searchSessions(targetId: string, view: "active" | "trash", query: string): Promise<CodexSession[]> {
  const terms = normalizeSearchTerms(query);
  const list = view === "trash" ? await listTrashSessions(targetId) : await listSessions(targetId);
  if (terms.length === 0) return list;

  return measure(`sessions.search.${view}.${targetId}`, async () => {
    const target = await resolveTarget(targetId);
    const matched = await mapLimit(list, 8, async (session) => {
      if (matchesSearch(session, terms)) return session;

      try {
        const content =
          target.kind === "local"
            ? await readSessionFile(session.filePath)
            : await wslReadSessionFile(target.distro!, session.filePath);
        const fullSession = parseSessionContent(session.filePath, content);
        const candidate = fullSession
          ? { ...fullSession, title: session.title, sourceTitle: session.sourceTitle, metadata: session.metadata }
          : null;
        if (candidate && matchesSearch(candidate, terms)) return candidate;
      } catch {
        return null;
      }

      return null;
    });

    return applySessionMetadataList(targetId, matched.filter((session): session is CodexSession => Boolean(session)));
  });
}

export async function getSessionFolderPath(targetId: string, sessionId: string) {
  const target = await resolveTarget(targetId);
  const source =
    target.kind === "local" ? await findLocalSessionFile(sessionId) : await findWslAnySessionFile(targetId, sessionId);
  return target.kind === "local" ? path.dirname(source) : path.posix.dirname(source);
}

export async function branchSession(targetId: string, sessionId: string, messageIndex: number) {
  return measure(`sessions.branch.${targetId}`, async () => {
    if (messageIndex <= 0) {
      throw new Error("请选择至少一条前置上下文后再创建分支。");
    }

    const session = await getSession(targetId, sessionId);
    const keepCount = Math.min(messageIndex, session.preview.length);
    if (keepCount <= 0) {
      throw new Error("当前会话没有可保留的上下文。");
    }

    const target = await resolveTarget(targetId);
    const effectiveTarget =
      target.kind === "wsl" && !target.codexHome
        ? { ...target, codexHome: await resolveWslCodexHome(target.distro!) }
        : target;
    const branchId = crypto.randomUUID();
    const branchPath = buildBranchSessionPath(effectiveTarget, session.filePath, branchId);
    await writeBranchSession(effectiveTarget, session, keepCount, branchId, branchPath);

    const branch = effectiveTarget.kind === "local"
      ? await loadLocalSession(branchPath)
      : await loadWslSession(effectiveTarget.distro!, branchPath);
    branch.metadata = await setSessionBranchMetadata(effectiveTarget.id, branch.id, {
      parentTargetId: targetId,
      parentSessionId: session.id,
      parentMessageIndex: keepCount,
      createdBy: "branch"
    });
    await appendHistoryEntry(effectiveTarget, branch);
    return branch;
  });
}

export async function duplicateSession(targetId: string, sessionId: string) {
  return measure(`sessions.duplicate.${targetId}`, async () => {
    const session = await getSession(targetId, sessionId);
    const target = await resolveTarget(targetId);
    const effectiveTarget =
      target.kind === "wsl" && !target.codexHome
        ? { ...target, codexHome: await resolveWslCodexHome(target.distro!) }
        : target;
    const duplicateId = crypto.randomUUID();
    const sourceText = effectiveTarget.kind === "local"
      ? await readSessionFile(session.filePath)
      : await wslReadSessionFile(effectiveTarget.distro!, session.filePath);
    const duplicateText = buildDuplicateSessionText(sourceText, duplicateId);
    const duplicatePath = buildBranchSessionPath(effectiveTarget, session.filePath, duplicateId);

    if (effectiveTarget.kind === "local") {
      await fs.mkdir(path.dirname(duplicatePath), { recursive: true });
      await fs.writeFile(duplicatePath, duplicateText, "utf8");
    } else {
      await wslWriteFile(effectiveTarget.distro!, duplicatePath, duplicateText);
    }

    const duplicated = parseSessionContent(duplicatePath, duplicateText);
    if (!duplicated) throw new Error("复制会话失败。");
    await appendHistoryEntry(effectiveTarget, duplicated);
    return duplicated;
  });
}

export async function deleteSession(targetId: string, sessionId: string, ref?: SessionFileRef) {
  return measure(`sessions.delete.${targetId}`, async () => {
    const target = await resolveTarget(targetId);
    if (target.kind === "local") return deleteLocalSession(sessionId, ref?.filePath);

    const codexHome = target.codexHome || (await resolveWslCodexHome(target.distro!));
    const sessionsRoot = path.posix.join(codexHome, "sessions");
    const source = ref?.filePath || (await findWslActiveSessionFile(targetId, sessionId));
    if (!isInsidePosixDir(source, sessionsRoot)) {
      throw new Error("拒绝移动 sessions 目录之外的文件");
    }
    await verifyWslSessionId(target.distro!, source, sessionId);
    const relative = source.slice(codexHome.replace(/\/+$/, "").length + 1);
    const movedTo = path.posix.join(codexHome, ".visual-console-trash", relative);
    await wslRunShell(
      target.distro!,
      `mkdir -p ${shellQuote(path.posix.dirname(movedTo))} && mv -- ${shellQuote(source)} ${shellQuote(movedTo)}`
    );
    await removeSessionFromCache(getWslCachePath(target.distro!), source);
    await removeSessionFromCache(getWslCachePath(target.distro!, "trash"), movedTo);
    return { movedTo };
  });
}

export async function deleteSessions(targetId: string, sessions: SessionMutationRef[]): Promise<SessionBatchMutationResult> {
  return measure(`sessions.delete.batch.${targetId}`, async () => {
    if (sessions.length === 0) return { processed: [] };
    const target = await resolveTarget(targetId);
    if (target.kind === "local") {
      return { processed: await deleteLocalSessions(sessions) };
    }

    const codexHome = target.codexHome || (await resolveWslCodexHome(target.distro!));
    const sessionsRoot = path.posix.join(codexHome, "sessions");
    const entries = await Promise.all(sessions.map(async (session) => {
      const source = session.filePath || (await findWslActiveSessionFile(targetId, session.id));
      if (!isInsidePosixDir(source, sessionsRoot)) throw new Error("拒绝移动 sessions 目录之外的文件");
      await verifyWslSessionId(target.distro!, source, session.id);
      const relative = source.slice(codexHome.replace(/\/+$/, "").length + 1);
      return {
        ...session,
        filePath: source,
        movedTo: path.posix.join(codexHome, ".visual-console-trash", relative)
      };
    }));

    const script = entries
      .map((entry) => `mkdir -p ${shellQuote(path.posix.dirname(entry.movedTo))} && mv -- ${shellQuote(entry.filePath)} ${shellQuote(entry.movedTo)}`)
      .join("\n");
    await wslRunShell(target.distro!, script, 1024 * 1024 * 4);
    await Promise.all([
      removeSessionsFromCache(getWslCachePath(target.distro!), entries.map((entry) => entry.filePath)),
      removeSessionsFromCache(getWslCachePath(target.distro!, "trash"), entries.map((entry) => entry.movedTo))
    ]);
    return { processed: entries };
  });
}

export async function restoreSession(targetId: string, sessionId: string) {
  return measure(`sessions.restore.${targetId}`, async () => {
    const target = await resolveTarget(targetId);
    if (target.kind === "local") return restoreLocalSession(sessionId);

    const source = await findWslTrashSessionFile(targetId, sessionId);

    const codexHome = target.codexHome || (await resolveWslCodexHome(target.distro!));
    const trashRoot = path.posix.join(codexHome, ".visual-console-trash");
    const trashSessionsRoot = path.posix.join(trashRoot, "sessions");
    if (!isInsidePosixDir(source, trashSessionsRoot)) {
      throw new Error("拒绝恢复回收站目录之外的文件");
    }
    const relative = source.slice(trashRoot.replace(/\/+$/, "").length + 1);
    const restoredTo = path.posix.join(codexHome, relative);
    await wslRunShell(
      target.distro!,
      [
        `if [ -e ${shellQuote(restoredTo)} ]; then echo ${shellQuote("原位置已存在同名会话文件，无法恢复。")} >&2; exit 17; fi`,
        `mkdir -p ${shellQuote(path.posix.dirname(restoredTo))}`,
        `mv -- ${shellQuote(source)} ${shellQuote(restoredTo)}`
      ].join("; ")
    );
    await removeSessionFromCache(getWslCachePath(target.distro!), restoredTo);
    await removeSessionFromCache(getWslCachePath(target.distro!, "trash"), source);
    return { restoredTo };
  });
}

export async function purgeSession(targetId: string, sessionId: string, ref?: SessionFileRef) {
  return measure(`sessions.purge.${targetId}`, async () => {
    const target = await resolveTarget(targetId);
    if (target.kind === "local") return purgeLocalSession(sessionId, ref?.filePath);

    const codexHome = target.codexHome || (await resolveWslCodexHome(target.distro!));
    const trashSessionsRoot = path.posix.join(codexHome, ".visual-console-trash", "sessions");
    const source = ref?.filePath || (await findWslTrashSessionFile(targetId, sessionId));
    if (!isInsidePosixDir(source, trashSessionsRoot)) {
      throw new Error("拒绝删除回收站目录之外的文件");
    }
    await verifyWslSessionId(target.distro!, source, sessionId);

    await wslRun(target.distro!, "rm", ["-f", source]);
    await removeSessionFromCache(getWslCachePath(target.distro!, "trash"), source);
    return { deleted: source };
  });
}

export async function purgeSessions(targetId: string, sessions: SessionMutationRef[]): Promise<SessionBatchMutationResult> {
  return measure(`sessions.purge.batch.${targetId}`, async () => {
    if (sessions.length === 0) return { processed: [] };
    const target = await resolveTarget(targetId);
    if (target.kind === "local") {
      const processed = [];
      for (const session of sessions) {
        const result = await purgeLocalSession(session.id, session.filePath);
        processed.push({ ...session, deleted: result.deleted });
      }
      return { processed };
    }

    const codexHome = target.codexHome || (await resolveWslCodexHome(target.distro!));
    const trashSessionsRoot = path.posix.join(codexHome, ".visual-console-trash", "sessions");
    const entries = await Promise.all(sessions.map(async (session) => {
      const source = session.filePath || (await findWslTrashSessionFile(targetId, session.id));
      if (!isInsidePosixDir(source, trashSessionsRoot)) throw new Error("拒绝删除回收站目录之外的文件");
      await verifyWslSessionId(target.distro!, source, session.id);
      return { ...session, filePath: source, deleted: source };
    }));

    await wslRun(target.distro!, "rm", ["-f", ...entries.map((entry) => entry.filePath)], 1024 * 1024 * 4);
    await removeSessionsFromCache(getWslCachePath(target.distro!, "trash"), entries.map((entry) => entry.filePath));
    return { processed: entries };
  });
}

async function findWslActiveSessionFile(targetId: string, sessionId: string) {
  const session = (await listSessions(targetId)).find((item) => item.id === sessionId);
  if (!session) throw new Error(`未找到会话：${sessionId}`);
  return session.filePath;
}

async function findWslTrashSessionFile(targetId: string, sessionId: string) {
  const session = (await listTrashSessions(targetId)).find((item) => item.id === sessionId);
  if (!session) throw new Error(`未在回收站找到会话：${sessionId}`);
  return session.filePath;
}

async function verifyWslSessionId(distro: string, filePath: string, sessionId: string) {
  const head = await wslReadFileHead(distro, filePath);
  if (!head.includes(sessionId)) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
}

export async function setWslCodexHome(distro: string, codexHome: string) {
  const normalized = codexHome.trim();
  if (!distro) throw new Error("缺少 WSL 发行版名称。");
  if (!normalized) throw new Error("请输入 WSL 内的 Codex 目录，例如 ~/.codex。");

  const candidate = await resolveWslInputPath(distro, normalized);
  if (!(await wslPathExists(distro, candidate))) throw new Error(`目录不存在：${candidate}`);
  const resolved = await wslRealpath(distro, candidate);
  await setWslCodexHomeOverride(distro, resolved);
  targetsCache = null;
  targetsInFlight = null;
  return { saved: true };
}

export async function clearWslCodexHome(distro: string) {
  if (!distro) throw new Error("缺少 WSL 发行版名称。");
  await clearWslCodexHomeOverride(distro);
  targetsCache = null;
  targetsInFlight = null;
  return { cleared: true };
}

async function loadLocalSession(filePath: string) {
  const parser = createSessionContentParser(filePath);
  await readSessionFileLines(filePath, parser.push);
  const session = parser.finish();
  if (!session) throw new Error(`未找到会话：${filePath}`);
  return session;
}

async function loadWslSession(distro: string, filePath: string) {
  const parser = createSessionContentParser(filePath);
  await wslReadSessionLines(distro, filePath, parser.push);
  const session = parser.finish();
  if (!session) throw new Error(`未找到会话：${filePath}`);
  return session;
}

async function findLocalSessionFile(sessionId: string) {
  const session =
    (await listLocalSessions()).find((item) => item.id === sessionId) ||
    (await listLocalTrashSessions()).find((item) => item.id === sessionId);
  if (!session) throw new Error(`未找到会话：${sessionId}`);
  return session.filePath;
}

async function findWslAnySessionFile(targetId: string, sessionId: string) {
  const session =
    (await listSessions(targetId)).find((item) => item.id === sessionId) ||
    (await listTrashSessions(targetId)).find((item) => item.id === sessionId);
  if (!session) throw new Error(`未找到会话：${sessionId}`);
  return session.filePath;
}

type SessionLineWriter = {
  write: (line: string) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
};

async function writeBranchSession(
  target: CodexTarget,
  session: CodexSession,
  keepCount: number,
  branchId: string,
  branchPath: string
) {
  const writer = target.kind === "local"
    ? await createLocalSessionLineWriter(branchPath)
    : await createWslSessionLineWriter(target.distro!, branchPath);
  const metaTimestamp = new Date().toISOString();
  let rewrittenMeta = false;
  let uniqueMessages = 0;
  let currentMessageKey = "";
  let cutoffKey = "";
  let complete = false;

  const writeLine = async (rawLine: string): Promise<boolean> => {
    if (complete) return false;
    if (!rawLine.trim()) return true;
    const item = safeJsonParse<SessionLine>(rawLine);
    if (!item) return true;

    if (item.type === "session_meta") {
      if (rewrittenMeta) return true;
      rewrittenMeta = true;
      await writer.write(JSON.stringify({
        timestamp: metaTimestamp,
        type: "session_meta",
        payload: {
          ...(item.payload || {}),
          id: branchId,
          timestamp: metaTimestamp,
          cwd: session.cwd,
          model: session.model,
          cli_version: session.cliVersion
        }
      }));
      return true;
    }

    const message = extractMessage(item);
    const messageKey = message && shouldKeepMessage(message) ? `${message.role}\u0000${message.text}` : "";
    if (cutoffKey && messageKey !== cutoffKey) {
      complete = true;
      return false;
    }
    if (messageKey && messageKey !== currentMessageKey) {
      uniqueMessages += 1;
      currentMessageKey = messageKey;
      if (uniqueMessages > keepCount) {
        complete = true;
        return false;
      }
      if (uniqueMessages === keepCount) cutoffKey = messageKey;
    }
    await writer.write(rawLine);
    return true;
  };

  try {
    if (target.kind === "local") await readSessionFileLines(session.filePath, writeLine);
    else await wslReadSessionLines(target.distro!, session.filePath, writeLine);
    if (!rewrittenMeta) throw new Error("创建分支失败：缺少 session_meta 记录。");
    await writer.close();
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

async function createLocalSessionLineWriter(filePath: string): Promise<SessionLineWriter> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(temporaryPath, "w");
  let closed = false;
  return {
    write: async (line) => {
      if (closed) throw new Error("分支文件写入已关闭。");
      await handle.write(`${line}\n`, undefined, "utf8");
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await handle.close();
      await fs.rename(temporaryPath, filePath);
    },
    abort: async () => {
      if (!closed) {
        closed = true;
        await handle.close().catch(() => undefined);
      }
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  };
}

async function createWslSessionLineWriter(distro: string, filePath: string): Promise<SessionLineWriter> {
  const wslExe = await getWslExe();
  if (!wslExe) throw new Error("未找到 wsl.exe。");
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const script = `mkdir -p ${shellQuote(path.posix.dirname(filePath))} && cat > ${shellQuote(temporaryPath)}`;
  const child = spawn(wslExe, ["-d", distro, "--", "bash", "-lc", script], {
    windowsHide: true,
    stdio: ["pipe", "ignore", "pipe"]
  });
  const stderr: Buffer[] = [];
  let timeoutError: Error | null = null;
  let writeError: Error | null = null;
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const clearTimer = attachSpawnTimeout(child, (error) => {
    timeoutError = error;
  }, `写入 ${filePath}`);
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.on("error", (error) => {
    writeError = error;
  });
  let closed = false;

  async function finish() {
    child.stdin.end();
    const code = await exit;
    clearTimer();
    if (timeoutError) throw timeoutError;
    if (writeError) throw writeError;
    if (code !== 0) {
      throw new Error(Buffer.concat(stderr).toString("utf8").trim() || `写入文件失败：${code}`);
    }
  }

  return {
    write: async (line) => {
      if (closed) throw new Error("分支文件写入已关闭。");
      if (writeError) throw writeError;
      if (!child.stdin.write(`${line}\n`, "utf8")) await once(child.stdin, "drain");
      if (writeError) throw writeError;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await finish();
      await wslRunShell(distro, `mv -f ${shellQuote(temporaryPath)} ${shellQuote(filePath)}`);
    },
    abort: async () => {
      if (!closed) {
        closed = true;
        child.stdin.destroy();
        child.kill("SIGKILL");
      }
      clearTimer();
      await exit.catch(() => undefined);
      await wslRunShell(distro, `rm -f ${shellQuote(temporaryPath)}`).catch(() => undefined);
    }
  };
}

function buildDuplicateSessionText(sourceText: string, duplicateId: string) {
  const now = new Date().toISOString();
  const lines: string[] = [];
  let rewrittenMeta = false;

  for (const rawLine of sourceText.split(/\r?\n/)) {
    if (!rawLine.trim()) {
      lines.push(rawLine);
      continue;
    }
    const item = safeJsonParse<SessionLine>(rawLine);
    if (!item) {
      lines.push(rawLine);
      continue;
    }
    if (item.type !== "session_meta") {
      lines.push(rawLine);
      continue;
    }
    lines.push(JSON.stringify({
      ...item,
      timestamp: now,
      payload: { ...(item.payload || {}), id: duplicateId, timestamp: now }
    }));
    rewrittenMeta = true;
  }

  if (!rewrittenMeta) throw new Error("复制会话失败：缺少 session_meta 记录。");
  return `${lines.join("\n")}\n`;
}

function buildBranchSessionPath(target: CodexTarget, sourcePath: string, branchId: string) {
  const nowStamp = formatSessionStamp(new Date());
  const branchName = `rollout-${nowStamp}-${branchId}.jsonl`;
  if (target.kind === "local") {
    const codexHome = target.codexHome || getCodexHome();
    const activeRoot = path.join(codexHome, "sessions");
    const trashRoot = path.join(getTrashRoot(), "sessions");

    if (isInsidePath(sourcePath, activeRoot)) {
      return path.join(path.dirname(sourcePath), branchName);
    }
    if (isInsidePath(sourcePath, trashRoot)) {
      const relativeDir = path.dirname(path.relative(trashRoot, sourcePath));
      return path.join(activeRoot, relativeDir, branchName);
    }
    throw new Error("分支只能从会话目录或回收站内的会话生成。");
  }

  const codexHome = target.codexHome || "";
  const activeRoot = path.posix.join(codexHome, "sessions");
  const trashRoot = path.posix.join(codexHome, ".visual-console-trash", "sessions");

  if (isInsidePosixDir(sourcePath, activeRoot)) {
    return path.posix.join(path.posix.dirname(sourcePath), branchName);
  }
  if (isInsidePosixDir(sourcePath, trashRoot)) {
    const relativeDir = path.posix.dirname(path.posix.relative(trashRoot, sourcePath));
    return path.posix.join(activeRoot, relativeDir, branchName);
  }
  throw new Error("分支只能从会话目录或回收站内的会话生成。");
}

async function wslWriteFile(distro: string, filePath: string, content: string) {
  const wslExe = await getWslExe();
  if (!wslExe) throw new Error("未找到 wsl.exe。");

  const script = `mkdir -p ${shellQuote(path.posix.dirname(filePath))} && cat > ${shellQuote(filePath)}`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(wslExe, ["-d", distro, "--", "bash", "-lc", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stderr: Buffer[] = [];
    const clearTimer = attachSpawnTimeout(child, reject, `写入 ${filePath}`);

    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimer();
      reject(error);
    });
    child.on("close", (code) => {
      clearTimer();
      if (code === 0) {
        resolve();
        return;
      }

      const message = Buffer.concat(stderr).toString("utf8").trim() || `写入文件失败：${code}`;
      reject(new Error(message));
    });

    child.stdin.end(content, "utf8");
  });
}

async function appendHistoryEntry(target: CodexTarget, session: CodexSession) {
  const entry = JSON.stringify({
    session_id: session.id,
    ts: Math.floor(Date.now() / 1000),
    text: session.title || session.id
  });

  if (target.kind === "local") {
    const historyPath = path.join(target.codexHome || getCodexHome(), "history.jsonl");
    await fs.mkdir(path.dirname(historyPath), { recursive: true });
    await fs.appendFile(historyPath, `${entry}\n`, "utf8");
    return;
  }

  const historyPath = path.posix.join(target.codexHome || "", "history.jsonl");
  await wslRunShell(
    target.distro!,
    `mkdir -p ${shellQuote(path.posix.dirname(historyPath))} && printf '%s\\n' ${shellQuote(entry)} >> ${shellQuote(historyPath)}`
  );
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeSearchTerms(query: string) {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matchesSearch(session: CodexSession, terms: string[]) {
  const haystack = [
    session.title,
    session.sourceTitle,
    session.id,
    session.cwd,
    session.model,
    session.cliVersion,
    ...session.preview.map((message) => message.text)
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function formatSessionStamp(date: Date) {
  return date.toISOString().slice(0, 19).replace(/:/g, "-");
}

async function resolveTarget(targetId: string): Promise<CodexTarget> {
  if (targetId === "local") {
    const target = await probeLocalTarget();
    if (target) return target;
  }

  if (targetId.startsWith("wsl:")) {
    const distro = targetId.slice("wsl:".length);
    if (!distro) throw new Error(`未知的 Codex 目标：${targetId}`);

    const overrideCodexHome = await getWslCodexHomeOverride(distro);
    const probe = overrideCodexHome ? null : await probeWslDistro(distro);
    return {
      id: targetId,
      provider: "codex",
      label: `WSL：${distro}`,
      kind: "wsl",
      distro,
      codexHome: overrideCodexHome || probe?.codexHome,
      available: true,
      detail: overrideCodexHome ? `使用手动路径 ${overrideCodexHome}` : probe?.detail || "可进入 WSL，未找到 Codex 目录"
    };
  }

  throw new Error(`未知的 Codex 目标：${targetId}`);
}

async function listWslDistros() {
  const wslExe = await getWslExe();
  if (!wslExe) return [];

  try {
    const { stdout } = await execFileAsync(wslExe, ["-l", "-q"], { encoding: "buffer" });
    return decodeWslOutput(stdout)
      .replace(/\0/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\*\s*/, ""))
      .filter((line) => line && !INTERNAL_WSL_DISTROS.has(line.toLowerCase()));
  } catch {
    return [];
  }
}

async function probeLocalTarget(): Promise<CodexTarget | null> {
  const codexHome = getCodexHome();
  const hasCodexHome = await pathExists(codexHome);
  const hasSessions = await pathExists(path.join(codexHome, "sessions"));
  const codexFound = await commandExists(process.platform === "win32" ? "codex.cmd" : "codex");

  if (!hasCodexHome && !codexFound) return null;

  return {
    id: "local",
    provider: "codex",
    label: `本机（${os.platform()}）`,
    kind: "local",
    codexHome,
    available: hasCodexHome,
    detail: hasSessions ? "找到 Codex 会话" : codexFound ? "找到 Codex 命令" : "找到 Codex 目录"
  };
}

async function wslListSessionFiles(distro: string, codexHome: string): Promise<CodexSessionFile[]> {
  if (!codexHome) return [];
  const root = `${codexHome}/sessions`;
  if (!(await wslPathExists(distro, root))) return [];
  const { stdout } = await wslRun(distro, "find", [root, "-type", "f", "-name", "rollout-*.jsonl", "-printf", "%p\t%T@\t%s\n"]);
  return parseWslSessionFileList(stdout);
}

async function wslListTrashSessionFiles(distro: string, codexHome: string): Promise<CodexSessionFile[]> {
  if (!codexHome) return [];
  const root = `${codexHome}/.visual-console-trash/sessions`;
  if (!(await wslPathExists(distro, root))) return [];
  const { stdout } = await wslRun(distro, "find", [root, "-type", "f", "-name", "rollout-*.jsonl", "-printf", "%p\t%T@\t%s\n"]);
  return parseWslSessionFileList(stdout);
}

async function probeWslDistro(
  distro: string
): Promise<{ codexHome: string; codexFound: boolean; detail: string } | null> {
  try {
    const codexHome = await resolveWslCodexHome(distro);
    const codexFound = await wslCommandExists(distro, "codex");
    const hasCodexHome = codexHome ? await wslPathExists(distro, codexHome) : false;
    const hasSessions = codexHome ? await wslPathExists(distro, path.posix.join(codexHome, "sessions")) : false;
    if (!hasSessions && !hasCodexHome && !codexFound) return null;
    if (!codexHome) return null;
    const user = await wslGetText(distro, "whoami");
    const home = await wslGetEnv(distro, "HOME");
    const userInfo = user?.trim() && home?.trim() ? `（${user.trim()}：${home.trim()}）` : "";
    return {
      codexHome: codexHome.trim(),
      codexFound,
      detail: `${hasSessions ? "找到 Codex 会话" : hasCodexHome ? "找到 Codex 目录" : "找到 Codex 命令"}${userInfo}`
    };
  } catch (error: any) {
    return {
      codexHome: "",
      codexFound: false,
      detail: `探测失败：${formatProcessError(error)}`
    };
  }
}

async function resolveWslCodexHome(distro: string) {
  const home = await wslGetEnv(distro, "HOME");
  const codexHome = await wslGetEnv(distro, "CODEX_HOME");
  const candidates = [
    codexHome,
    home ? path.posix.join(home, ".codex") : "",
    ...(await wslFindCodexHomes(distro))
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await wslPathExists(distro, path.posix.join(candidate, "sessions"))) return candidate;
  }
  for (const candidate of candidates) {
    if (await wslPathExists(distro, candidate)) return candidate;
  }
  return "";
}

async function wslRun(distro: string, command: string, args: string[] = [], maxBuffer = 1024 * 1024 * 16) {
  const wslExe = await getWslExe();
  if (!wslExe) throw new Error("未找到 wsl.exe。");

  return execFileAsync(wslExe, ["-d", distro, "--", command, ...args], {
    encoding: "utf8",
    maxBuffer,
    timeout: WSL_COMMAND_TIMEOUT_MS
  });
}

async function wslRunShell(distro: string, script: string, maxBuffer = 1024 * 1024) {
  const wslExe = await getWslExe();
  if (!wslExe) throw new Error("未找到 wsl.exe。");

  return execFileAsync(wslExe, ["-d", distro, "--", "bash", "-lc", script], {
    encoding: "utf8",
    maxBuffer,
    timeout: WSL_COMMAND_TIMEOUT_MS
  });
}

async function wslReadFile(distro: string, filePath: string) {
  const wslExe = await getWslExe();
  if (!wslExe) throw new Error("未找到 wsl.exe。");

  return new Promise<string>((resolve, reject) => {
    const child = spawn(wslExe, ["-d", distro, "--", "cat", filePath], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const clearTimer = attachSpawnTimeout(child, reject, `读取 ${filePath}`);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimer();
      reject(error);
    });
    child.on("close", (code) => {
      clearTimer();
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }

      const message = Buffer.concat(stderr).toString("utf8").trim() || `cat 退出码：${code}`;
      reject(new Error(message));
    });
  });
}

async function wslReadSessionFile(distro: string, filePath: string) {
  const size = await wslFileSize(distro, filePath);
  if (size > MAX_WSL_SESSION_READ_BYTES) {
    throw new Error(`会话文件过大，拒绝一次性读取：${path.posix.basename(filePath)}`);
  }
  return wslReadFile(distro, filePath);
}

async function wslReadSessionLines(
  distro: string,
  filePath: string,
  onLine: (line: string) => void | boolean | Promise<void | boolean>
) {
  const wslExe = await getWslExe();
  if (!wslExe) throw new Error("未找到 wsl.exe。");

  const child = spawn(wslExe, ["-d", distro, "--", "cat", filePath], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderr: Buffer[] = [];
  let timeoutError: Error | null = null;
  let processClosed = false;
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      processClosed = true;
      resolve(code);
    });
  });
  const clearTimer = attachSpawnTimeout(child, (error) => {
    timeoutError = error;
  }, `读取 ${filePath}`);
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  try {
    for await (const line of lines) {
      if ((await onLine(line)) === false) {
        lines.close();
        child.stdout.destroy();
        child.kill("SIGKILL");
        await exit.catch(() => undefined);
        return;
      }
    }
    const code = await exit;
    if (timeoutError) throw timeoutError;
    if (code !== 0) throw new Error(Buffer.concat(stderr).toString("utf8").trim() || `cat 退出码：${code}`);
  } catch (error) {
    if (!processClosed) {
      lines.close();
      child.stdout.destroy();
      child.kill("SIGKILL");
      await exit.catch(() => undefined);
    }
    throw error;
  } finally {
    clearTimer();
  }
}

async function wslReadFileHead(distro: string, filePath: string) {
  const { stdout } = await wslRun(distro, "head", ["-c", "65536", filePath]);
  return stdout;
}

async function wslFileSize(distro: string, filePath: string) {
  const { stdout } = await wslRun(distro, "stat", ["-c", "%s", filePath]);
  const size = Number(stdout.trim());
  if (!Number.isFinite(size)) throw new Error(`无法读取文件大小：${filePath}`);
  return size;
}

async function wslGetText(distro: string, command: string, args: string[] = []) {
  try {
    const { stdout } = await wslRun(distro, command, args);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function wslGetEnv(distro: string, name: string) {
  return wslGetText(distro, "printenv", [name]);
}

async function wslPathExists(distro: string, filePath: string) {
  if (!filePath) return false;
  try {
    await wslRun(distro, "test", ["-e", filePath]);
    return true;
  } catch {
    return false;
  }
}

async function wslCommandExists(distro: string, command: string) {
  try {
    await wslRun(distro, "which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function wslFindCodexHomes(distro: string) {
  try {
    const { stdout } = await wslRun(distro, "find", ["/home", "-mindepth", "2", "-maxdepth", "2", "-type", "d", "-name", ".codex", "-print"]);
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function resolveWslInputPath(distro: string, input: string) {
  if (input === "~") return await wslGetEnv(distro, "HOME");
  if (input.startsWith("~/")) {
    const home = await wslGetEnv(distro, "HOME");
    if (!home) throw new Error("无法读取 WSL HOME。");
    return path.posix.join(home, input.slice(2));
  }
  if (input.startsWith("/")) return input;
  throw new Error("请输入 WSL 内的绝对路径，或使用 ~/.codex。");
}

async function wslRealpath(distro: string, filePath: string) {
  try {
    const { stdout } = await wslRun(distro, "realpath", ["-m", filePath]);
    return stdout.trim() || filePath;
  } catch {
    return filePath;
  }
}

async function getWslExe() {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "wsl.exe") : "",
          process.env.windir ? path.join(process.env.windir, "System32", "wsl.exe") : "",
          "C:\\Windows\\System32\\wsl.exe",
          "C:\\Windows\\Sysnative\\wsl.exe",
          "wsl.exe"
        ]
      : ["/mnt/c/Windows/System32/wsl.exe"];

  for (const candidate of candidates.filter(Boolean)) {
    if (await commandExists(candidate)) return candidate;
  }
  return null;
}

function getWslCachePath(distro: string, view = "active") {
  const safeDistro = sanitizeWslDistro(distro);
  const suffix = view === "active" ? "" : `-${view}`;
  return path.join(path.dirname(getCachePath()), `sessions-wsl-${safeDistro}${suffix}.json`);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function commandExists(command: string) {
  if (command.includes("/") || command.includes("\\")) {
    try {
      await fs.access(command);
      return true;
    } catch {
      return false;
    }
  }

  const checker = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(checker, [command]);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatProcessError(error: any) {
  const detail = [error?.stderr, error?.stdout, error?.message]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .find(Boolean);
  return clampText(detail || "未知错误", 160);
}

function clampText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}
