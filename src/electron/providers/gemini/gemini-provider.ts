import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CodexMessage, CodexSession, CodexTarget, SessionBatchMutationResult, SessionFileRef, SessionMessagePage, SessionMutationRef, SessionUsage, TokenUsage } from "../../types";
import type { SessionView } from "../ai-providers";
import { measure } from "../../core/performance";
import { hasAppDatabase, readSessionMessageIndex, saveSessionMessageIndex } from "../../core/app-database";
import { applySessionMetadataList, findSessionIdsByParent, setSessionBranchMetadata } from "../session-metadata";
import { readLocalLines, readWslLines } from "../../terminal/wsl-process";
import { getCachedTargets, setCachedTargets } from "../../core/settings";
import {
  findCachedProviderSession,
  listCachedProviderSessions,
  loadProviderSessionCache
} from "../provider-session-cache";

const execFileAsync = promisify(execFile);
const INTERNAL_WSL_DISTROS = new Set(["docker-desktop", "docker-desktop-data"]);
const GEMINI_SESSION_PREFIX = "session-";
const GEMINI_LIST_PREVIEW_LIMIT = 8;

type GeminiTargetContext = {
  targetId: string;
  kind: "local" | "wsl";
  distro?: string;
  configDir: string;
};

type GeminiSessionFile = {
  filePath: string;
  projectKey: string;
  cwd?: string;
  mtimeMs?: number;
  size?: number;
};

type GeminiSessionContentFile = GeminiSessionFile & {
  content: string;
};

type SessionMutationEntry = SessionMutationRef & {
  filePath: string;
  movedTo?: string;
  deleted?: string;
};

type GeminiUsageAccumulator = {
  total?: TokenUsage;
  last?: TokenUsage;
  contextUsedTokens?: number;
  contextWindow?: number;
  updatedAt?: string;
};

export async function listCachedTargets(): Promise<CodexTarget[]> {
  return (await getCachedTargets()).filter((target) => target.provider === "gemini");
}

export async function listTargets(): Promise<CodexTarget[]> {
  return measure("targets.list.gemini", async () => {
    const local = await probeLocalTarget();
    const wslTargets = process.platform === "win32" || process.platform === "linux"
      ? await probeWslTargets()
      : [];

    const targets = [
      ...wslTargets,
      ...(local ? [local] : [])
    ];
    await setCachedTargets(targets);
    return targets;
  });
}

export async function listCachedSessions(_targetId: string, _view: SessionView): Promise<CodexSession[]> {
  return (await applySessionMetadataList(
    _targetId,
    await listCachedProviderSessions<CodexSession>(getGeminiCacheKey(_targetId, _view))
  )).sort(sortSessionDesc);
}

export async function listSessions(targetId: string): Promise<CodexSession[]> {
  return measure(`sessions.list.${targetId}`, async () => {
    const sessions = await loadGeminiSessions(targetId, "active");
    return sessions.sort(sortSessionDesc);
  });
}

export async function listTrashSessions(targetId: string): Promise<CodexSession[]> {
  return measure(`sessions.trash.list.${targetId}`, async () => {
    const sessions = await loadGeminiSessions(targetId, "trash");
    return sessions.sort(sortSessionDesc);
  });
}

export async function searchSessions(targetId: string, view: SessionView, query: string): Promise<CodexSession[]> {
  const normalized = query.trim().toLowerCase();
  const source = view === "trash" ? await listTrashSessions(targetId) : await listSessions(targetId);
  if (!normalized) return source;

  const context = await resolveGeminiTargetContext(targetId);
  const matches: CodexSession[] = [];
  for (const session of source) {
    if (matchesGeminiSessionSummary(session, normalized) || await geminiSessionContains(context, session.filePath, normalized)) {
      matches.push(session);
    }
  }
  return matches;
}

export async function getSession(targetId: string, sessionId: string, ref?: SessionFileRef): Promise<CodexSession> {
  const context = await resolveGeminiTargetContext(targetId);
  if (ref?.filePath) {
    assertGeminiSessionPath(context, ref.filePath, "active");
    await verifyGeminiSessionId(context, ref.filePath, sessionId);
    const session = await readGeminiSessionLines(context, {
      filePath: ref.filePath,
      projectKey: getGeminiProjectKey(ref.filePath, context.kind)
    });
    if (!session || session.id !== sessionId) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
    return (await applySessionMetadataList(targetId, [session]))[0];
  }
  const cached = await findCachedGeminiSession(targetId, sessionId);
  if (cached) {
    try {
      const file = await readGeminiSessionContent(context, {
        filePath: cached.filePath,
        projectKey: getGeminiProjectKey(cached.filePath, context.kind),
        cwd: cached.cwd
      });
      const session = parseGeminiSessionFile(file);
      if (session?.id === sessionId) return (await applySessionMetadataList(targetId, [session]))[0];
    } catch {
      // 缓存命中但文件已移动或失效，回退到完整发现流程。
    }
  }
  const session = [
    ...(await loadGeminiSessions(targetId, "active")),
    ...(await loadGeminiSessions(targetId, "trash"))
  ].find((item) => item.id === sessionId);
  if (!session) throw new Error(`未找到 Gemini 会话：${sessionId}`);
  return session;
}

export async function getSessionMessagesPage(targetId: string, sessionId: string, offset: number, limit: number): Promise<SessionMessagePage> {
  return measure(`sessions.page.${targetId}`, async () => {
    const context = await resolveGeminiTargetContext(targetId);
    const session = await getSessionSummary(targetId, sessionId);
    const latest = offset === -1;
    const pageOffset = latest ? 0 : Math.max(0, Math.floor(offset));
    const pageLimit = Math.max(1, Math.floor(limit));
    const messages: CodexMessage[] = [];
    let previous: CodexMessage | null = null;
    let hasMore = false;
    const fileMtimeMs = session.fileMtimeMs || Date.parse(session.updatedAt || "") || 0;
    const fileSize = session.fileSize || 0;
    const anchor = !latest && hasAppDatabase() ? await readSessionMessageIndex({ targetId, sessionId, filePath: session.filePath, mtimeMs: fileMtimeMs, size: fileSize }, pageOffset) : null;
    const anchors: Array<{ messageOffset: number; lineNumber: number }> = [];
    let visibleIndex = anchor?.messageOffset || 0;
    const pushMessage = (value: unknown, lineNumber: number, canAnchor: boolean) => {
      const message = toGeminiMessage(value);
      if (!message || !shouldKeepGeminiMessage(message)) return true;
      if (previous?.role === message.role && previous.text === message.text) return true;
      previous = message;
      if (!latest && visibleIndex >= pageOffset + pageLimit) {
        hasMore = true;
        return false;
      }
      if (canAnchor && visibleIndex % 100 === 0) anchors.push({ messageOffset: visibleIndex, lineNumber });
      if (latest) {
        messages.push(message);
        if (messages.length > pageLimit) messages.shift();
        visibleIndex += 1;
        return true;
      }
      if (visibleIndex >= pageOffset) messages.push(message);
      visibleIndex += 1;
      return true;
    };
    const push = (line: string, lineNumber: number) => {
      const item = safeJsonParse<Record<string, unknown>>(line);
      if (!item) return true;
      const patch = objectField(item.$set);
      if (Array.isArray(patch.messages)) {
        for (const [messageIndex, message] of patch.messages.entries()) {
          if (!pushMessage(message, lineNumber, messageIndex === 0)) return false;
        }
      }
      return typeof item.type === "string" ? pushMessage(item, lineNumber, true) : true;
    };
    const startLine = latest ? 1 : anchor?.lineNumber || 1;
    if (context.kind === "wsl") await readWslLines(context.distro!, session.filePath, push, startLine);
    else await readLocalLines(session.filePath, push, startLine);
    if (hasAppDatabase()) await saveSessionMessageIndex({
      targetId,
      sessionId,
      filePath: session.filePath,
      mtimeMs: fileMtimeMs,
      size: fileSize,
      anchors,
      messageCount: Math.max(session.messageCount, anchor?.messageCount || 0, hasMore ? 0 : visibleIndex)
    });
    return { offset: latest ? Math.max(0, visibleIndex - messages.length) : pageOffset, messages, hasMore: latest ? visibleIndex > messages.length : hasMore };
  });
}

export async function getSessionSummary(targetId: string, sessionId: string): Promise<CodexSession> {
  const cached = [
    ...(await listCachedSessions(targetId, "active")),
    ...(await listCachedSessions(targetId, "trash"))
  ].find((session) => session.id === sessionId);
  if (cached) return cached;

  const session = [
    ...(await listSessions(targetId)),
    ...(await listTrashSessions(targetId))
  ].find((item) => item.id === sessionId);
  if (!session) throw new Error(`未找到 Gemini 会话：${sessionId}`);
  return session;
}

export async function listSessionsByParent(targetId: string, parentSessionId: string): Promise<CodexSession[]> {
  return measure(`sessions.children.${targetId}`, async () => {
    const childIds = await findSessionIdsByParent(targetId, parentSessionId);
    if (childIds) {
      if (childIds.length === 0) return [];
      const idSet = new Set(childIds);
      const cached = (await listCachedSessions(targetId, "active")).filter((session) => idSet.has(session.id));
      if (cached.length === childIds.length) return cached;
    }

    const sessions = await listSessions(targetId);
    return sessions.filter((session) => session.metadata?.branch?.parentSessionId === parentSessionId);
  });
}

export async function getSessionFolderPath(targetId: string, sessionId: string): Promise<string> {
  const session = await getSession(targetId, sessionId);
  return targetId.startsWith("gemini:wsl:")
    ? path.posix.dirname(session.filePath)
    : path.dirname(session.filePath);
}

export async function branchSession(targetId: string, sessionId: string, messageIndex: number): Promise<CodexSession> {
  return measure(`sessions.branch.${targetId}`, async () => {
    if (messageIndex <= 0) {
      throw new Error("请选择至少一条前置上下文后再创建分支。");
    }

    const session = await getSessionSummary(targetId, sessionId);
    // 列表摘要的 messageCount 可能只覆盖 JSONL 首段，不能用它限制分页详情传入的绝对偏移。
    const keepCount = messageIndex;
    if (keepCount <= 0) {
      throw new Error("当前 Gemini 会话没有可保留的上下文。");
    }

    const context = await resolveGeminiTargetContext(targetId);
    const branchId = crypto.randomUUID();
    const branchText = await readGeminiBranchText(context, session.filePath, branchId, keepCount);
    const branchPath = buildGeminiBranchPath(context, session.filePath, branchId);

    if (context.kind === "wsl") {
      await wslWriteFile(context.distro!, branchPath, branchText);
    } else {
      await fs.mkdir(path.dirname(branchPath), { recursive: true });
      await fs.writeFile(branchPath, branchText, "utf8");
    }

    const branch = parseGeminiSessionFile({
      filePath: branchPath,
      content: branchText,
      projectKey: extractProjectKey(branchPath, context.kind),
      cwd: session.cwd
    });
    if (!branch) throw new Error("创建 Gemini 分支失败。");
    branch.metadata = await setSessionBranchMetadata(targetId, branch.id, {
      parentTargetId: targetId,
      parentSessionId: session.id,
      parentMessageIndex: keepCount,
      createdBy: "branch"
    });
    return branch;
  });
}

export async function duplicateSession(targetId: string, sessionId: string): Promise<CodexSession> {
  return measure(`sessions.duplicate.${targetId}`, async () => {
    const context = await resolveGeminiTargetContext(targetId);
    const session = await findGeminiSession(targetId, sessionId, "active");
    const duplicateId = crypto.randomUUID();
    const sourceText = context.kind === "wsl"
      ? await wslReadFile(context.distro!, session.filePath)
      : await fs.readFile(session.filePath, "utf8");
    const duplicateText = buildGeminiDuplicateSessionText(sourceText, duplicateId);
    const duplicatePath = buildGeminiBranchPath(context, session.filePath, duplicateId);

    if (context.kind === "wsl") {
      await wslWriteFile(context.distro!, duplicatePath, duplicateText);
    } else {
      await fs.mkdir(path.dirname(duplicatePath), { recursive: true });
      await fs.writeFile(duplicatePath, duplicateText, "utf8");
    }

    const duplicated = parseGeminiSessionFile({
      filePath: duplicatePath,
      content: duplicateText,
      projectKey: extractProjectKey(duplicatePath, context.kind),
      cwd: session.cwd
    });
    if (!duplicated) throw new Error("复制 Gemini 会话失败。");
    return duplicated;
  });
}

export async function deleteSession(targetId: string, sessionId: string, ref?: SessionFileRef): Promise<{ movedTo: string }> {
  return measure(`sessions.delete.${targetId}`, async () => {
    const context = await resolveGeminiTargetContext(targetId);
    const session = await getGeminiSessionForMutation(targetId, context, sessionId, "active", ref);
    const movedTo = buildGeminiTrashPath(context, session.filePath);

    if (context.kind === "wsl") {
      await moveWslSession(context, session.filePath, movedTo);
    } else {
      assertInsideLocal(session.filePath, path.join(context.configDir, "tmp"), "拒绝移动 Gemini tmp 目录之外的文件");
      await moveLocalSession(session.filePath, movedTo);
    }

    return { movedTo };
  });
}

export async function deleteSessions(targetId: string, sessions: SessionMutationRef[]): Promise<SessionBatchMutationResult> {
  return mutateGeminiSessionsBatch(targetId, sessions, "active");
}

export async function purgeSessions(targetId: string, sessions: SessionMutationRef[]): Promise<SessionBatchMutationResult> {
  return mutateGeminiSessionsBatch(targetId, sessions, "trash");
}

async function mutateGeminiSessionsBatch(
  targetId: string,
  sessions: SessionMutationRef[],
  view: SessionView
): Promise<SessionBatchMutationResult> {
  return measure(`sessions.${view === "trash" ? "purge" : "delete"}.batch.${targetId}`, async () => {
    if (sessions.length === 0) return { processed: [] };
    const context = await resolveGeminiTargetContext(targetId);
    const processed = await Promise.all(sessions.map(async (sessionRef): Promise<SessionMutationEntry> => {
      const session = await getGeminiSessionForMutation(targetId, context, sessionRef.id, view, sessionRef);
      if (view === "trash") {
        return { ...sessionRef, filePath: session.filePath, deleted: session.filePath };
      }
      return { ...sessionRef, filePath: session.filePath, movedTo: buildGeminiTrashPath(context, session.filePath) };
    }));

    if (context.kind === "wsl") {
      const script = processed
        .map((entry) =>
          view === "trash"
            ? `rm -f -- ${shellQuote(entry.filePath)}`
            : [
              `if [ -e ${shellQuote(entry.movedTo!)} ]; then echo ${shellQuote("目标位置已存在同名 Gemini 会话文件，无法移动。")} >&2; exit 17; fi`,
              `mkdir -p ${shellQuote(path.posix.dirname(entry.movedTo!))}`,
              `mv -- ${shellQuote(entry.filePath)} ${shellQuote(entry.movedTo!)}`
            ].join("; ")
        )
        .join("\n");
      await wslRunShell(context.distro!, script);
    } else {
      for (const entry of processed) {
        if (view === "trash") await fs.unlink(entry.filePath);
        else await moveLocalSession(entry.filePath, entry.movedTo!);
      }
    }

    return { processed };
  });
}

export async function restoreSession(targetId: string, sessionId: string): Promise<{ restoredTo: string }> {
  return measure(`sessions.restore.${targetId}`, async () => {
    const context = await resolveGeminiTargetContext(targetId);
    const session = await findGeminiSession(targetId, sessionId, "trash");
    const restoredTo = buildGeminiRestorePath(context, session.filePath);

    if (context.kind === "wsl") {
      await moveWslSession(context, session.filePath, restoredTo);
    } else {
      assertInsideLocal(session.filePath, getLocalTrashRoot(context), "拒绝恢复 Gemini 回收站之外的文件");
      await moveLocalSession(session.filePath, restoredTo);
    }

    return { restoredTo };
  });
}

export async function purgeSession(targetId: string, sessionId: string, ref?: SessionFileRef): Promise<{ deleted: string }> {
  return measure(`sessions.purge.${targetId}`, async () => {
    const context = await resolveGeminiTargetContext(targetId);
    const session = await getGeminiSessionForMutation(targetId, context, sessionId, "trash", ref);

    if (context.kind === "wsl") {
      assertInsidePosix(session.filePath, getWslTrashRoot(context), "拒绝删除 Gemini 回收站之外的文件");
      await wslRun(context.distro!, "rm", ["-f", session.filePath]);
    } else {
      assertInsideLocal(session.filePath, getLocalTrashRoot(context), "拒绝删除 Gemini 回收站之外的文件");
      await fs.unlink(session.filePath);
    }

    return { deleted: session.filePath };
  });
}

async function probeLocalTarget(): Promise<CodexTarget | null> {
  const command = process.platform === "win32" ? "gemini.cmd" : "gemini";
  const found = await commandExists(command);
  const configDir = path.join(os.homedir(), ".gemini");
  const hasConfigDir = await pathExists(configDir);
  if (!found && !hasConfigDir) return null;

  return {
    id: "gemini:local",
    provider: "gemini",
    label: `Gemini：本机（${os.platform()}）`,
    kind: "local",
    codexHome: hasConfigDir ? configDir : undefined,
    available: found,
    detail: found
      ? hasConfigDir ? "找到 Gemini 命令和配置目录" : "找到 Gemini 命令"
      : "找到 Gemini 配置目录，未找到 gemini 命令"
  };
}

async function loadGeminiSessions(targetId: string, view: SessionView): Promise<CodexSession[]> {
  const context = await resolveGeminiTargetContext(targetId);
  const files = context.kind === "wsl" ? await listWslSessionFiles(context, view) : await listLocalSessionFiles(context, view);
  const cacheKey = getGeminiCacheKey(targetId, view);
  const sessions = await loadProviderSessionCache(cacheKey, files, async (file) =>
    readGeminiSessionLines(context, file, { maxMessages: GEMINI_LIST_PREVIEW_LIMIT })
  );
  return applySessionMetadataList(targetId, sessions);
}

async function findGeminiSession(targetId: string, sessionId: string, view: SessionView) {
  const session = (await loadGeminiSessions(targetId, view)).find((item) => item.id === sessionId);
  if (!session) throw new Error(view === "trash" ? `未在 Gemini 回收站找到会话：${sessionId}` : `未找到 Gemini 会话：${sessionId}`);
  return session;
}

function getGeminiCacheKey(targetId: string, view: SessionView) {
  return `sessions:gemini:${targetId}:${view}:v3`;
}

async function findCachedGeminiSession(targetId: string, sessionId: string): Promise<CodexSession | null> {
  return findCachedProviderSession<CodexSession>(
    [getGeminiCacheKey(targetId, "active"), getGeminiCacheKey(targetId, "trash")],
    sessionId
  );
}

async function readGeminiSessionContent(
  context: GeminiTargetContext,
  file: GeminiSessionFile
): Promise<GeminiSessionContentFile> {
  const content = context.kind === "wsl"
    ? await wslReadFile(context.distro!, file.filePath)
    : await fs.readFile(file.filePath, "utf8");
  return { ...file, content };
}

function getGeminiProjectKey(filePath: string, kind: GeminiTargetContext["kind"]) {
  return kind === "wsl"
    ? path.posix.basename(path.posix.dirname(path.posix.dirname(filePath)))
    : path.basename(path.dirname(path.dirname(filePath)));
}

async function getGeminiSessionForMutation(
  targetId: string,
  context: GeminiTargetContext,
  sessionId: string,
  view: SessionView,
  ref?: SessionFileRef
) {
  if (!ref?.filePath) return findGeminiSession(targetId, sessionId, view);
  const root = view === "trash" ? getGeminiTrashSessionRoot(context) : getGeminiActiveSessionRoot(context);
  if (context.kind === "wsl") {
    assertInsidePosix(ref.filePath, root, "拒绝操作 Gemini 会话目录之外的文件");
    const content = await wslReadFile(context.distro!, ref.filePath);
    const session = parseGeminiSessionFile({
      filePath: ref.filePath,
      content,
      projectKey: path.posix.basename(path.posix.dirname(path.posix.dirname(ref.filePath)))
    });
    if (!session || session.id !== sessionId) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
    return session;
  }
  assertInsideLocal(ref.filePath, root, "拒绝操作 Gemini 会话目录之外的文件");
  const content = await fs.readFile(ref.filePath, "utf8");
  const session = parseGeminiSessionFile({
    filePath: ref.filePath,
    content,
    projectKey: path.basename(path.dirname(path.dirname(ref.filePath)))
  });
  if (!session || session.id !== sessionId) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
  return session;
}

function assertGeminiSessionPath(context: GeminiTargetContext, filePath: string, view: SessionView) {
  const root = view === "trash" ? getGeminiTrashSessionRoot(context) : getGeminiActiveSessionRoot(context);
  if (context.kind === "wsl") assertInsidePosix(filePath, root, "拒绝操作 Gemini 会话目录之外的文件");
  else assertInsideLocal(filePath, root, "拒绝操作 Gemini 会话目录之外的文件");
}

async function verifyGeminiSessionId(context: GeminiTargetContext, filePath: string, sessionId: string) {
  let found = false;
  const inspect = (line: string) => {
    const value = safeJsonParse<Record<string, unknown>>(line);
    const candidate = stringField(value?.sessionId);
    if (!candidate) return true;
    found = true;
    if (candidate !== sessionId) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
    return false;
  };
  if (context.kind === "wsl") await readWslLines(context.distro!, filePath, inspect);
  else await readLocalLines(filePath, inspect);
  if (!found) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
}

async function resolveGeminiTargetContext(targetId: string): Promise<GeminiTargetContext> {
  if (targetId === "gemini:local") {
    return {
      targetId,
      kind: "local",
      configDir: path.join(os.homedir(), ".gemini")
    };
  }

  if (targetId.startsWith("gemini:wsl:")) {
    const distro = targetId.slice("gemini:wsl:".length);
    const home = await wslGetEnv(distro, "HOME");
    return {
      targetId,
      kind: "wsl",
      distro,
      configDir: path.posix.join(home, ".gemini")
    };
  }

  throw new Error(`未知 Gemini 目标：${targetId}`);
}

async function listLocalSessionFiles(context: GeminiTargetContext, view: SessionView): Promise<GeminiSessionFile[]> {
  const projects = await readLocalProjects(context.configDir);
  const tmpDir = view === "trash" ? path.join(getLocalTrashRoot(context), "tmp") : path.join(context.configDir, "tmp");
  const projectKeys = await fs.readdir(tmpDir).catch(() => []);
  const files: GeminiSessionFile[] = [];

  for (const projectKey of projectKeys) {
    const chatsDir = path.join(tmpDir, projectKey, "chats");
    const names = await fs.readdir(chatsDir).catch(() => []);
    for (const name of names) {
      if (!isGeminiSessionFile(name)) continue;
      const filePath = path.join(chatsDir, name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat) continue;
      files.push({
        filePath,
        projectKey,
        cwd: projects.get(projectKey),
        mtimeMs: stat.mtimeMs,
        size: stat.size
      });
    }
  }

  return files;
}

async function listWslSessionFiles(context: GeminiTargetContext, view: SessionView): Promise<GeminiSessionFile[]> {
  if (!context.distro) return [];
  const projects = await readWslProjects(context);
  const tmpDir = view === "trash" ? path.posix.join(getWslTrashRoot(context), "tmp") : path.posix.join(context.configDir, "tmp");
  const { stdout } = await wslRun(context.distro, "find", [
    tmpDir,
    "-path",
    "*/chats/session-*.jsonl",
    "-type",
    "f",
    "-printf",
    "%p\\t%T@\\t%s\\n"
  ]).catch(() => ({ stdout: "" }));
  const paths = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [filePath, mtime, size] = line.split("\t");
    return { filePath, mtimeMs: Number.parseFloat(mtime) * 1000, size: Number.parseInt(size, 10) };
  });
  const files: GeminiSessionFile[] = [];

  for (const file of paths) {
    if (!file.filePath) continue;
    const filePath = file.filePath;
    const projectKey = path.posix.basename(path.posix.dirname(path.posix.dirname(filePath)));
    files.push({
      filePath,
      projectKey,
      cwd: projects.get(projectKey),
      mtimeMs: Number.isFinite(file.mtimeMs) ? file.mtimeMs : 0,
      size: Number.isFinite(file.size) ? file.size : 0
    });
  }

  return files;
}

async function readLocalProjects(configDir: string) {
  const content = await fs.readFile(path.join(configDir, "projects.json"), "utf8").catch(() => "");
  return parseProjects(content);
}

async function readWslProjects(context: GeminiTargetContext) {
  if (!context.distro) return new Map<string, string>();
  const content = await wslReadFile(context.distro, path.posix.join(context.configDir, "projects.json")).catch(() => "");
  return parseProjects(content);
}

function parseProjects(content: string) {
  const projects = new Map<string, string>();
  const parsed = safeJsonParse<{ projects?: Record<string, string> }>(content);
  for (const [cwd, projectKey] of Object.entries(parsed?.projects || {})) {
    if (typeof projectKey === "string") projects.set(projectKey, cwd);
  }
  return projects;
}

function parseGeminiSessionFile(file: GeminiSessionContentFile): CodexSession | null {
  const parser = createGeminiSessionParser(file);
  for (const line of file.content.split(/\r?\n/)) parser.push(line);
  return parser.finish();
}

function createGeminiSessionParser(file: GeminiSessionFile, options: { maxMessages?: number } = {}) {
  let id = "";
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let summary: string | undefined;
  let userTitle = "";
  let kind = "main";
  let model: string | undefined;
  const usageAccumulator: GeminiUsageAccumulator = {};
  const messages: CodexMessage[] = [];
  let messageCount = 0;
  let previousMessage: CodexMessage | null = null;

  function countMessage(value: unknown) {
    const message = toGeminiMessage(value);
    if (!message || !shouldKeepGeminiMessage(message)) return;
    if (previousMessage?.role === message.role && previousMessage.text === message.text) return;
    previousMessage = message;
    messageCount += 1;
  }

  function push(line: string) {
    const item = safeJsonParse<Record<string, unknown>>(line);
    if (!item) return;

    if (typeof item.sessionId === "string") {
      id = item.sessionId || id;
      createdAt = stringField(item.startTime) || createdAt;
      updatedAt = stringField(item.lastUpdated) || updatedAt;
      summary = stringField(item.summary) || summary;
      kind = stringField(item.kind) || kind;
      return;
    }

    const patch = objectField(item.$set);
    if (patch.messages && Array.isArray(patch.messages)) {
      for (const message of patch.messages) {
        countMessage(message);
        pushGeminiMessage(messages, message, options.maxMessages, (text) => {
          userTitle ||= text;
        });
        collectGeminiUsage(usageAccumulator, message);
        model = extractGeminiModel(message) || model;
      }
    }
    updatedAt = stringField(patch.lastUpdated) || updatedAt;
    summary = stringField(patch.summary) || summary;

    if (typeof item.type === "string") {
      countMessage(item);
      pushGeminiMessage(messages, item, options.maxMessages, (text) => {
        userTitle ||= text;
      });
      collectGeminiUsage(usageAccumulator, item);
      model = extractGeminiModel(item) || model;
      updatedAt = stringField(item.timestamp) || updatedAt;
    }
  }

  function finish(): CodexSession | null {
    if (kind === "subagent") return null;
    id ||= extractGeminiSessionId(file.filePath);
    if (!id) return null;

    const visibleMessages = messages.filter((message) => shouldKeepGeminiMessage(message));
    if (visibleMessages.length === 0) return null;
    const firstVisibleUser = visibleMessages.find((message) => message.role === "user" && message.text.trim());

    return {
      id,
      title: clampText(summary || userTitle || firstVisibleUser?.text || id, 88),
      cwd: file.cwd,
      createdAt,
      updatedAt: updatedAt || (file.mtimeMs ? new Date(file.mtimeMs).toISOString() : createdAt),
      model,
      modelStatus: { model, modelProvider: "Gemini" },
      filePath: file.filePath,
      fileMtimeMs: file.mtimeMs,
      fileSize: file.size,
      messageCount,
      preview: visibleMessages,
      usage: buildGeminiUsage(usageAccumulator)
    };
  }

  return { push, finish };
}

async function readGeminiSessionLines(
  context: GeminiTargetContext,
  file: GeminiSessionFile,
  options?: { maxMessages?: number }
): Promise<CodexSession | null> {
  const parser = createGeminiSessionParser(file, options);
  if (context.kind === "wsl") await readWslLines(context.distro!, file.filePath, parser.push);
  else await readLocalLines(file.filePath, parser.push);
  return parser.finish();
}

function pushGeminiMessage(
  messages: CodexMessage[],
  value: unknown,
  maxMessages?: number,
  onFirstUserText?: (text: string) => void
) {
  const record = objectField(value);
  const role = geminiRole(stringField(record.type));
  if (!role) return;

  const retainMessage = maxMessages === undefined || messages.length < maxMessages;
  const needsTitle = role === "user" && onFirstUserText;
  if (!retainMessage && !needsTitle) return;
  const text = extractGeminiText(record.displayContent) || extractGeminiText(record.content);
  if (!text) return;
  if (role === "user") onFirstUserText?.(text);
  if (!retainMessage) return;

  const message = {
    role,
    text,
    timestamp: stringField(record.timestamp) || undefined
  };
  const previous = messages[messages.length - 1];
  if (previous && previous.role === message.role && previous.text === message.text) return;
  messages.push(message);
}

function toGeminiMessage(value: unknown): CodexMessage | null {
  const record = objectField(value);
  const role = geminiRole(stringField(record.type));
  if (!role) return null;
  const text = extractGeminiText(record.displayContent) || extractGeminiText(record.content);
  return text ? { role, text, timestamp: stringField(record.timestamp) || undefined } : null;
}

function matchesGeminiSessionSummary(session: CodexSession, query: string) {
  return [session.id, session.title, session.sourceTitle || "", session.cwd || "", session.model || "", ...session.preview.map((message) => message.text)]
    .join("\n")
    .toLowerCase()
    .includes(query);
}

async function geminiSessionContains(context: GeminiTargetContext, filePath: string, query: string) {
  let found = false;
  const inspect = (line: string) => {
    found ||= line.toLowerCase().includes(query);
    return !found;
  };
  if (context.kind === "wsl") await readWslLines(context.distro!, filePath, inspect);
  else await readLocalLines(filePath, inspect);
  return found;
}

function geminiRole(type: string): CodexMessage["role"] | null {
  if (type === "user") return "user";
  if (type === "gemini") return "assistant";
  if (type === "info" || type === "warning" || type === "error") return "system";
  return null;
}

function extractGeminiText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";

  return value
    .map((part) => {
      if (typeof part === "string") return part;
      const record = objectField(part);
      return stringField(record.text) || stringField(record.input_text) || stringField(record.output_text);
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractGeminiModel(value: unknown) {
  const record = objectField(value);
  if (stringField(record.type) !== "gemini") return "";
  return stringField(record.model);
}

function collectGeminiUsage(accumulator: GeminiUsageAccumulator, value: unknown) {
  const record = objectField(value);
  if (stringField(record.type) !== "gemini") return;

  const usage = normalizeGeminiTokenUsage(objectField(record.tokens));
  if (!usage) return;

  accumulator.last = usage;
  accumulator.total = addTokenUsage(accumulator.total, usage);
  accumulator.contextUsedTokens = usage.inputTokens;
  accumulator.contextWindow = geminiTokenLimit(stringField(record.model));
  accumulator.updatedAt = stringField(record.timestamp) || accumulator.updatedAt;
}

function normalizeGeminiTokenUsage(tokens: Record<string, unknown>): TokenUsage | undefined {
  const outputTokens = numberField(tokens.output);
  const reasoningOutputTokens = numberField(tokens.thoughts);
  const usage: TokenUsage = {
    inputTokens: numberField(tokens.input),
    cachedInputTokens: numberField(tokens.cached),
    outputTokens,
    reasoningOutputTokens,
    totalTokens: numberField(tokens.total)
  };

  if (typeof usage.totalTokens !== "number") {
    const total = [
      usage.inputTokens,
      usage.cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      numberField(tokens.tool)
    ].reduce<number>((sum, value) => sum + (value || 0), 0);
    if (total > 0) usage.totalTokens = total;
  }

  return Object.values(usage).some((item) => typeof item === "number") ? usage : undefined;
}

function addTokenUsage(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  return {
    inputTokens: addOptional(current?.inputTokens, next.inputTokens),
    cachedInputTokens: addOptional(current?.cachedInputTokens, next.cachedInputTokens),
    outputTokens: addOptional(current?.outputTokens, next.outputTokens),
    reasoningOutputTokens: addOptional(current?.reasoningOutputTokens, next.reasoningOutputTokens),
    totalTokens: addOptional(current?.totalTokens, next.totalTokens)
  };
}

function buildGeminiUsage(accumulator: GeminiUsageAccumulator): SessionUsage | undefined {
  if (!accumulator.total && !accumulator.last) return undefined;

  const contextPercent =
    typeof accumulator.contextUsedTokens === "number" &&
    typeof accumulator.contextWindow === "number" &&
    accumulator.contextWindow > 0
      ? Math.min(100, Math.round((accumulator.contextUsedTokens / accumulator.contextWindow) * 1000) / 10)
      : undefined;
  const contextLeftPercent =
    typeof contextPercent === "number" ? Math.max(0, Math.round((100 - contextPercent) * 10) / 10) : undefined;

  return {
    total: accumulator.total,
    last: accumulator.last,
    contextWindow: accumulator.contextWindow,
    contextUsedTokens: accumulator.contextUsedTokens,
    contextPercent,
    contextLeftPercent,
    updatedAt: accumulator.updatedAt,
    source: "gemini-message-tokens"
  };
}

function geminiTokenLimit(model: string) {
  if (/gemma-4-(31b-it|26b-a4b-it)/i.test(model)) return 256000;
  return 1048576;
}

function shouldKeepGeminiMessage(message: CodexMessage) {
  const text = message.text.trim();
  return Boolean(text) && !text.startsWith("<session_context>");
}

function extractGeminiSessionId(filePath: string) {
  const name = path.basename(filePath);
  const match = name.match(/^session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-([a-f0-9]{8})\.jsonl$/i);
  return match?.[1] || "";
}

function isGeminiSessionFile(name: string) {
  return name.startsWith(GEMINI_SESSION_PREFIX) && name.endsWith(".jsonl");
}

function sortSessionDesc(a: CodexSession, b: CodexSession) {
  return new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime();
}

function getLocalTrashRoot(context: GeminiTargetContext) {
  return path.join(context.configDir, ".visual-console-trash");
}

function getWslTrashRoot(context: GeminiTargetContext) {
  return path.posix.join(context.configDir, ".visual-console-trash");
}

function getGeminiActiveSessionRoot(context: GeminiTargetContext) {
  return context.kind === "wsl" ? path.posix.join(context.configDir, "tmp") : path.join(context.configDir, "tmp");
}

function getGeminiTrashSessionRoot(context: GeminiTargetContext) {
  return context.kind === "wsl" ? path.posix.join(getWslTrashRoot(context), "tmp") : path.join(getLocalTrashRoot(context), "tmp");
}

function buildGeminiTrashPath(context: GeminiTargetContext, source: string) {
  if (context.kind === "wsl") {
    assertInsidePosix(source, path.posix.join(context.configDir, "tmp"), "拒绝移动 Gemini tmp 目录之外的文件");
    return path.posix.join(getWslTrashRoot(context), path.posix.relative(context.configDir, source));
  }

  assertInsideLocal(source, path.join(context.configDir, "tmp"), "拒绝移动 Gemini tmp 目录之外的文件");
  return path.join(getLocalTrashRoot(context), path.relative(context.configDir, source));
}

function buildGeminiRestorePath(context: GeminiTargetContext, source: string) {
  if (context.kind === "wsl") {
    const trashRoot = getWslTrashRoot(context);
    assertInsidePosix(source, trashRoot, "拒绝恢复 Gemini 回收站之外的文件");
    return path.posix.join(context.configDir, path.posix.relative(trashRoot, source));
  }

  const trashRoot = getLocalTrashRoot(context);
  assertInsideLocal(source, trashRoot, "拒绝恢复 Gemini 回收站之外的文件");
  return path.join(context.configDir, path.relative(trashRoot, source));
}

function buildGeminiBranchPath(context: GeminiTargetContext, source: string, branchId: string) {
  const branchName = `session-${formatGeminiSessionStamp(new Date())}-${branchId.slice(0, 8)}.jsonl`;
  if (context.kind === "wsl") {
    const activeRoot = path.posix.join(context.configDir, "tmp");
    const trashRoot = path.posix.join(getWslTrashRoot(context), "tmp");
    if (isInsidePosix(source, activeRoot)) return path.posix.join(path.posix.dirname(source), branchName);
    if (isInsidePosix(source, trashRoot)) {
      const relativeDir = path.posix.dirname(path.posix.relative(trashRoot, source));
      return path.posix.join(activeRoot, relativeDir, branchName);
    }
    throw new Error("Gemini 分支只能从会话目录或回收站内的会话生成。");
  }

  const activeRoot = path.join(context.configDir, "tmp");
  const trashRoot = path.join(getLocalTrashRoot(context), "tmp");
  if (isInsideLocalPath(source, activeRoot)) return path.join(path.dirname(source), branchName);
  if (isInsideLocalPath(source, trashRoot)) {
    const relativeDir = path.dirname(path.relative(trashRoot, source));
    return path.join(activeRoot, relativeDir, branchName);
  }
  throw new Error("Gemini 分支只能从会话目录或回收站内的会话生成。");
}

async function readGeminiBranchText(context: GeminiTargetContext, filePath: string, branchId: string, keepCount: number) {
  const now = new Date().toISOString();
  const lines: string[] = [];
  let rewrittenMeta = false;
  let visibleMessages = 0;
  const push = (rawLine: string) => {
    if (!rawLine.trim()) return true;
    const item = safeJsonParse<Record<string, unknown>>(rawLine);
    if (!item) return true;
    if (isGeminiMetadataRecord(item)) {
      if (!rewrittenMeta) {
        lines.push(JSON.stringify({ ...item, sessionId: branchId, startTime: now, lastUpdated: now, kind: stringField(item.kind) || "main" }));
        rewrittenMeta = true;
      }
      return true;
    }
    const patch = objectField(item.$set);
    if (Array.isArray(patch.messages)) {
      const nextMessages: unknown[] = [];
      for (const message of patch.messages) {
        if (!isVisibleGeminiRecord(message)) nextMessages.push(message);
        else if (visibleMessages < keepCount) {
          visibleMessages += 1;
          nextMessages.push(message);
        }
      }
      lines.push(JSON.stringify({ ...item, $set: { ...patch, messages: nextMessages } }));
      return visibleMessages >= keepCount ? false : true;
    }
    if (isVisibleGeminiRecord(item)) {
      if (visibleMessages >= keepCount) return false;
      visibleMessages += 1;
    }
    lines.push(rawLine);
    return visibleMessages < keepCount;
  };
  if (context.kind === "wsl") await readWslLines(context.distro!, filePath, push);
  else await readLocalLines(filePath, push);
  if (!rewrittenMeta) throw new Error("Gemini 源会话缺少 session 元数据。");
  if (visibleMessages < keepCount) throw new Error("Gemini 源会话上下文不足，无法创建分支。");
  lines.push(JSON.stringify({ $set: { lastUpdated: now } }));
  return `${lines.join("\n")}\n`;
}

function buildGeminiDuplicateSessionText(sourceText: string, duplicateId: string) {
  const now = new Date().toISOString();
  const lines: string[] = [];
  let rewrittenMeta = false;

  for (const rawLine of sourceText.split(/\r?\n/)) {
    if (!rawLine.trim()) {
      lines.push(rawLine);
      continue;
    }
    const item = safeJsonParse<Record<string, unknown>>(rawLine);
    if (!item) {
      lines.push(rawLine);
      continue;
    }
    if (!isGeminiMetadataRecord(item)) {
      lines.push(rawLine);
      continue;
    }
    lines.push(JSON.stringify({
      ...item,
      sessionId: duplicateId,
      startTime: now,
      lastUpdated: now,
      kind: stringField(item.kind) || "main"
    }));
    rewrittenMeta = true;
  }

  if (!rewrittenMeta) throw new Error("复制 Gemini 会话失败：缺少会话元数据。");
  // Gemini 按 lastUpdated 排序；复制时显式更新它，避免刷新后回到源会话的旧位置。
  lines.push(JSON.stringify({ $set: { lastUpdated: now } }));
  return `${lines.join("\n")}\n`;
}

async function moveLocalSession(source: string, destination: string) {
  if (await pathExists(destination)) {
    throw new Error("目标位置已存在同名 Gemini 会话文件，无法移动。");
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
}

async function moveWslSession(context: GeminiTargetContext, source: string, destination: string) {
  if (!context.distro) throw new Error("缺少 WSL 发行版。");
  await wslRunShell(
    context.distro,
    [
      `if [ -e ${shellQuote(destination)} ]; then echo ${shellQuote("目标位置已存在同名 Gemini 会话文件，无法移动。")} >&2; exit 17; fi`,
      `mkdir -p ${shellQuote(path.posix.dirname(destination))}`,
      `mv -- ${shellQuote(source)} ${shellQuote(destination)}`
    ].join("; ")
  );
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

    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const message = Buffer.concat(stderr).toString("utf8").trim() || `写入 Gemini 分支文件失败：${code}`;
      reject(new Error(message));
    });

    child.stdin.end(content, "utf8");
  });
}

function assertInsideLocal(filePath: string, root: string, message: string) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(message);
}

function isInsideLocalPath(filePath: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertInsidePosix(filePath: string, root: string, message: string) {
  if (isInsidePosix(filePath, root)) return;
  throw new Error(message);
}

function isInsidePosix(filePath: string, root: string) {
  const relative = path.posix.relative(normalizePosix(root), normalizePosix(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative));
}

function normalizePosix(value: string) {
  return path.posix.normalize(value).replace(/\/+$/, "") || "/";
}

function isGeminiMetadataRecord(value: Record<string, unknown>) {
  return typeof value.sessionId === "string" && typeof value.projectHash === "string";
}

function isVisibleGeminiRecord(value: unknown) {
  const record = objectField(value);
  const role = geminiRole(stringField(record.type));
  if (role !== "user" && role !== "assistant") return false;
  const text = extractGeminiText(record.displayContent) || extractGeminiText(record.content);
  return shouldKeepGeminiMessage({ role, text });
}

function extractProjectKey(filePath: string, kind: GeminiTargetContext["kind"]) {
  const parser = kind === "wsl" ? path.posix : path;
  return parser.basename(parser.dirname(parser.dirname(filePath)));
}

function formatGeminiSessionStamp(value: Date) {
  const pad = (input: number, size = 2) => String(input).padStart(size, "0");
  return [
    value.getFullYear(),
    "-",
    pad(value.getMonth() + 1),
    "-",
    pad(value.getDate()),
    "T",
    pad(value.getHours()),
    "-",
    pad(value.getMinutes())
  ].join("");
}

async function probeWslTargets(): Promise<CodexTarget[]> {
  const distros = await listWslDistros();
  return (
    await Promise.all(
      distros.map(async (distro): Promise<CodexTarget | null> => {
        const commandFound = await wslCommandExists(distro, "gemini").catch(() => false);
        const home = await wslGetEnv(distro, "HOME").catch(() => "");
        const configDir = home ? path.posix.join(home, ".gemini") : "";
        const hasConfigDir = configDir ? await wslPathExists(distro, configDir).catch(() => false) : false;
        if (!commandFound && !hasConfigDir) return null;

        return {
          id: `gemini:wsl:${distro}`,
          provider: "gemini",
          label: `Gemini：WSL：${distro}`,
          kind: "wsl",
          distro,
          codexHome: hasConfigDir ? configDir : undefined,
          available: commandFound,
          detail: commandFound
            ? hasConfigDir ? "找到 Gemini 命令和配置目录" : "找到 Gemini 命令"
            : "找到 Gemini 配置目录，未找到 gemini 命令"
        };
      })
    )
  ).filter((target): target is CodexTarget => Boolean(target));
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

async function wslCommandExists(distro: string, command: string) {
  await wslRun(distro, "bash", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`]);
  return true;
}

async function wslPathExists(distro: string, filePath: string) {
  await wslRun(distro, "test", ["-e", filePath]);
  return true;
}

async function wslGetEnv(distro: string, name: string) {
  const { stdout } = await wslRun(distro, "printenv", [name]);
  return stdout.trim();
}

async function wslReadFile(distro: string, filePath: string) {
  const { stdout } = await wslRun(distro, "cat", [filePath]);
  return stdout;
}

async function wslRunShell(distro: string, command: string) {
  return wslRun(distro, "bash", ["-lc", command]);
}

async function wslRun(distro: string, command: string, args: string[] = []) {
  const wslExe = await getWslExe();
  if (!wslExe) throw new Error("未找到 wsl.exe。");

  return execFileAsync(wslExe, ["-d", distro, "--", command, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
}

function decodeWslOutput(output: Buffer) {
  const utf16 = output.toString("utf16le");
  const utf8 = output.toString("utf8");
  return utf16.replace(/\0/g, "").trim().length >= utf8.replace(/\0/g, "").trim().length ? utf16 : utf8;
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

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function addOptional(left: number | undefined, right: number | undefined) {
  if (typeof left !== "number" && typeof right !== "number") return undefined;
  return (left || 0) + (right || 0);
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function clampText(value: string, length: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > length ? `${normalized.slice(0, length - 1)}...` : normalized;
}
