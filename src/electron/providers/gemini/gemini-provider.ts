import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexMessage, CodexSession, CodexTarget, SessionBatchMutationResult, SessionFileRef, SessionMessagePage, SessionMutationRef, SessionUsage, TokenUsage } from "../../types";
import type { SessionView } from "../ai-providers";
import { measure } from "../../core/performance";
import { hasAppDatabase, readSessionMessageIndex, saveSessionMessageIndex } from "../../core/app-database";
import { applySessionMetadataList, findSessionIdsByParent, setSessionBranchMetadata } from "../session-metadata";
import {
  runWslShell,
  wslGetEnv,
  wslRun
} from "../../core/wsl";
import { getWslDistroFromProviderTarget } from "../../../shared/target-ids";
import { isInsidePosixDir, shellQuote } from "../../../shared/wsl-paths";
import { isInsideLocalPath } from "../../core/fs-utils";
import { clampText, numberField, objectField, safeJsonParse, stringField } from "../../../shared/session-parser";
import { getCachedTargets } from "../../core/settings";
import {
  listCliTargets,
  probeLocalCliTarget,
  probeWslCliTargets,
  searchSessionsByContent,
  sortSessionsByRecency
} from "../provider-common";
import {
  findCachedProviderSession,
  listCachedProviderSessions,
  loadProviderSessionList
} from "../provider-session-cache";
import { assertSessionFileInside } from "../session-file-ops";
import { planSessionMutationBatch } from "../session-mutation-base";
import { createSessionStorage } from "../session-storage";
import { readSessionWithParser } from "../session-reader";
import { resolveProviderTargetContext, type ProviderTargetContext } from "../provider-target-context";

const GEMINI_SESSION_PREFIX = "session-";
const GEMINI_LIST_PREVIEW_LIMIT = 8;

type GeminiTargetContext = ProviderTargetContext;

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
  return listCliTargets("gemini", probeLocalTarget, probeWslTargets);
}

export async function listCachedSessions(_targetId: string, _view: SessionView): Promise<CodexSession[]> {
  return (await applySessionMetadataList(
    _targetId,
    await listCachedProviderSessions<CodexSession>(getGeminiCacheKey(_targetId, _view))
  )).sort(sortSessionsByRecency);
}

export async function listSessions(targetId: string): Promise<CodexSession[]> {
  return measure(`sessions.list.${targetId}`, async () => {
    const sessions = await loadGeminiSessions(targetId, "active");
    return sessions.sort(sortSessionsByRecency);
  });
}

export async function listTrashSessions(targetId: string): Promise<CodexSession[]> {
  return measure(`sessions.trash.list.${targetId}`, async () => {
    const sessions = await loadGeminiSessions(targetId, "trash");
    return sessions.sort(sortSessionsByRecency);
  });
}

export async function searchSessions(targetId: string, view: SessionView, query: string): Promise<CodexSession[]> {
  const sessions = view === "trash" ? await listTrashSessions(targetId) : await listSessions(targetId);
  return searchSessionsByContent({
    sessions,
    query,
    resolveContext: () => resolveGeminiTargetContext(targetId)
  });
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
    const storage = createSessionStorage(context);
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
    await storage.readLines(session.filePath, push, startLine);
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
  return getWslDistroFromProviderTarget("gemini", targetId)
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
    const storage = createSessionStorage(context);
    const branchId = crypto.randomUUID();
    const branchText = await readGeminiBranchText(context, session.filePath, branchId, keepCount);
    const branchPath = buildGeminiBranchPath(context, session.filePath, branchId);

    await storage.writeText(branchPath, branchText);

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
    const storage = createSessionStorage(context);
    const session = await findGeminiSession(targetId, sessionId, "active");
    const duplicateId = crypto.randomUUID();
    const sourceText = await storage.readText(session.filePath);
    const duplicateText = buildGeminiDuplicateSessionText(sourceText, duplicateId);
    const duplicatePath = buildGeminiBranchPath(context, session.filePath, duplicateId);

    await storage.writeText(duplicatePath, duplicateText);

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
    const storage = createSessionStorage(context);
    const session = await getGeminiSessionForMutation(targetId, context, sessionId, "active", ref);
    const movedTo = buildGeminiTrashPath(context, session.filePath);

    if (context.kind === "wsl") {
      await storage.move(session.filePath, movedTo, "目标位置已存在同名 Gemini 会话文件，无法移动。");
    } else {
      assertSessionFileInside(session.filePath, path.join(context.configDir, "tmp"), "local", "拒绝移动 Gemini tmp 目录之外的文件");
      await storage.move(session.filePath, movedTo, "目标位置已存在同名 Gemini 会话文件，无法移动。");
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
    const storage = createSessionStorage(context);
    const plans = await planSessionMutationBatch(sessions, view, async (sessionRef) => {
      const session = await getGeminiSessionForMutation(targetId, context, sessionRef.id, view, sessionRef);
      const source = session.filePath;
      if (!source) throw new Error("Gemini 会话缺少文件路径。");
      if (view === "trash") {
        return { session, source, result: { ...sessionRef, filePath: source, deleted: source } };
      }
      const movedTo = buildGeminiTrashPath(context, source);
      return { session, source, destination: movedTo, result: { ...sessionRef, filePath: source, movedTo } };
    });
    const processed = plans.map((plan) => plan.result);

    if (context.kind === "wsl") {
      const script = plans
        .map((plan) =>
          view === "trash"
            ? `rm -f -- ${shellQuote(plan.source)}`
            : [
              `if [ -e ${shellQuote(plan.destination!)} ]; then echo ${shellQuote("目标位置已存在同名 Gemini 会话文件，无法移动。")} >&2; exit 17; fi`,
              `mkdir -p ${shellQuote(path.posix.dirname(plan.destination!))}`,
              `mv -- ${shellQuote(plan.source)} ${shellQuote(plan.destination!)}`
            ].join("; ")
        )
        .join("\n");
      await runWslShell(context.distro!, script);
    } else {
      for (const plan of plans) {
        if (view === "trash") await storage.remove(plan.source);
        else await storage.move(plan.source, plan.destination!, "目标位置已存在同名 Gemini 会话文件，无法移动。");
      }
    }

    return { processed };
  });
}

export async function restoreSession(targetId: string, sessionId: string): Promise<{ restoredTo: string }> {
  return measure(`sessions.restore.${targetId}`, async () => {
    const context = await resolveGeminiTargetContext(targetId);
    const storage = createSessionStorage(context);
    const session = await findGeminiSession(targetId, sessionId, "trash");
    const restoredTo = buildGeminiRestorePath(context, session.filePath);

    if (context.kind === "wsl") {
      await storage.move(session.filePath, restoredTo, "目标位置已存在同名 Gemini 会话文件，无法恢复。");
    } else {
      assertSessionFileInside(session.filePath, getLocalTrashRoot(context), "local", "拒绝恢复 Gemini 回收站之外的文件");
      await storage.move(session.filePath, restoredTo, "目标位置已存在同名 Gemini 会话文件，无法恢复。");
    }

    return { restoredTo };
  });
}

export async function purgeSession(targetId: string, sessionId: string, ref?: SessionFileRef): Promise<{ deleted: string }> {
  return measure(`sessions.purge.${targetId}`, async () => {
    const context = await resolveGeminiTargetContext(targetId);
    const storage = createSessionStorage(context);
    const session = await getGeminiSessionForMutation(targetId, context, sessionId, "trash", ref);

    if (context.kind === "wsl") {
      assertSessionFileInside(session.filePath, getWslTrashRoot(context), "wsl", "拒绝删除 Gemini 回收站之外的文件");
      await storage.remove(session.filePath);
    } else {
      assertSessionFileInside(session.filePath, getLocalTrashRoot(context), "local", "拒绝删除 Gemini 回收站之外的文件");
      await storage.remove(session.filePath);
    }

    return { deleted: session.filePath };
  });
}

function probeLocalTarget() {
  return probeLocalCliTarget({
    provider: "gemini",
    displayName: "Gemini",
    windowsCommand: "gemini.cmd",
    unixCommand: "gemini",
    configDir: path.join(os.homedir(), ".gemini")
  });
}

async function loadGeminiSessions(targetId: string, view: SessionView): Promise<CodexSession[]> {
  const context = await resolveGeminiTargetContext(targetId);
  const files = context.kind === "wsl" ? await listWslSessionFiles(context, view) : await listLocalSessionFiles(context, view);
  const cacheKey = getGeminiCacheKey(targetId, view);
  return loadProviderSessionList(
    cacheKey,
    files,
    (file) => readGeminiSessionLines(context, file, { maxMessages: GEMINI_LIST_PREVIEW_LIMIT }),
    (sessions) => applySessionMetadataList(targetId, sessions)
  );
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
  const content = await createSessionStorage(context).readText(file.filePath);
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
  assertSessionFileInside(ref.filePath, root, context.kind, "拒绝操作 Gemini 会话目录之外的文件");
  const content = await createSessionStorage(context).readText(ref.filePath);
  const session = parseGeminiSessionFile({
    filePath: ref.filePath,
    content,
    projectKey: context.kind === "wsl"
      ? path.posix.basename(path.posix.dirname(path.posix.dirname(ref.filePath)))
      : path.basename(path.dirname(path.dirname(ref.filePath)))
  });
  if (!session || session.id !== sessionId) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
  return session;
}

function assertGeminiSessionPath(context: GeminiTargetContext, filePath: string, view: SessionView) {
  const root = view === "trash" ? getGeminiTrashSessionRoot(context) : getGeminiActiveSessionRoot(context);
  assertSessionFileInside(filePath, root, context.kind, "拒绝操作 Gemini 会话目录之外的文件");
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
  await createSessionStorage(context).readLines(filePath, inspect);
  if (!found) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
}

async function resolveGeminiTargetContext(targetId: string): Promise<GeminiTargetContext> {
  return resolveProviderTargetContext(targetId, {
    provider: "gemini",
    localTargetId: "gemini:local",
    localConfigDir: path.join(os.homedir(), ".gemini"),
    resolveWslConfigDir: async (distro) => path.posix.join(await wslGetEnv(distro, "HOME"), ".gemini"),
    displayName: "Gemini"
  });
}

async function listLocalSessionFiles(context: GeminiTargetContext, view: SessionView): Promise<GeminiSessionFile[]> {
  const projects = await readLocalProjects(context);
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

async function readLocalProjects(context: GeminiTargetContext) {
  const content = await createSessionStorage(context).readText(path.join(context.configDir, "projects.json")).catch(() => "");
  return parseProjects(content);
}

async function readWslProjects(context: GeminiTargetContext) {
  if (!context.distro) return new Map<string, string>();
  const content = await createSessionStorage(context).readText(path.posix.join(context.configDir, "projects.json")).catch(() => "");
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
  return readSessionWithParser(createSessionStorage(context), file.filePath, parser);
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
    assertSessionFileInside(source, path.posix.join(context.configDir, "tmp"), "wsl", "拒绝移动 Gemini tmp 目录之外的文件");
    return path.posix.join(getWslTrashRoot(context), path.posix.relative(context.configDir, source));
  }

  assertSessionFileInside(source, path.join(context.configDir, "tmp"), "local", "拒绝移动 Gemini tmp 目录之外的文件");
  return path.join(getLocalTrashRoot(context), path.relative(context.configDir, source));
}

function buildGeminiRestorePath(context: GeminiTargetContext, source: string) {
  if (context.kind === "wsl") {
    const trashRoot = getWslTrashRoot(context);
    assertSessionFileInside(source, trashRoot, "wsl", "拒绝恢复 Gemini 回收站之外的文件");
    return path.posix.join(context.configDir, path.posix.relative(trashRoot, source));
  }

  const trashRoot = getLocalTrashRoot(context);
  assertSessionFileInside(source, trashRoot, "local", "拒绝恢复 Gemini 回收站之外的文件");
  return path.join(context.configDir, path.relative(trashRoot, source));
}

function buildGeminiBranchPath(context: GeminiTargetContext, source: string, branchId: string) {
  const branchName = `session-${formatGeminiSessionStamp(new Date())}-${branchId.slice(0, 8)}.jsonl`;
  if (context.kind === "wsl") {
    const activeRoot = path.posix.join(context.configDir, "tmp");
    const trashRoot = path.posix.join(getWslTrashRoot(context), "tmp");
    if (isInsidePosixDir(source, activeRoot)) return path.posix.join(path.posix.dirname(source), branchName);
    if (isInsidePosixDir(source, trashRoot)) {
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
  await createSessionStorage(context).readLines(filePath, push);
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

function probeWslTargets() {
  return probeWslCliTargets({
    provider: "gemini",
    displayName: "Gemini",
    command: "gemini",
    resolveConfigDir: async (distro) => {
      const home = await wslGetEnv(distro, "HOME").catch(() => "");
      return home ? path.posix.join(home, ".gemini") : "";
    }
  });
}

function addOptional(left: number | undefined, right: number | undefined) {
  if (typeof left !== "number" && typeof right !== "number") return undefined;
  return (left || 0) + (right || 0);
}
