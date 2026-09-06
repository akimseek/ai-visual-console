import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AiMessage, AiSession, AiTarget, SessionBatchMutationResult, SessionFileRef, SessionMessagePage, SessionMutationRef, SessionUsage, TokenUsage } from "../../types";
import type { SessionView } from "../ai-providers";
import { measure } from "../../core/performance";
import { hasAppDatabase, readSessionMessageIndex, saveSessionMessageIndex } from "../../core/app-database";
import { applySessionMetadataList, findSessionIdsByParent, setSessionBranchMetadata } from "../session-metadata";
import {
  wslGetEnv,
  wslRun,
} from "../../core/wsl";
import { getWslDistroFromProviderTarget } from "../../../shared/target-ids";
import { shellQuote } from "../../../shared/wsl-paths";
import { safeJsonParse } from "../../../shared/session-parser";
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
import { assertSessionFileInside, relocateSessionPath } from "../session-file-ops";
import { planSessionMutationBatch } from "../session-mutation-base";
import { createSessionStorage } from "../session-storage";
import { readSessionWithParser } from "../session-reader";
import { resolveProviderTargetContext, type ProviderTargetContext } from "../provider-target-context";

const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000;
const CLAUDE_ONE_MILLION_CONTEXT_WINDOW = 1_000_000;
const CLAUDE_LIST_PREVIEW_LIMIT = 8;

type ClaudeTargetContext = ProviderTargetContext;

type ClaudeSessionFile = {
  filePath: string;
  mtimeMs?: number;
  size?: number;
};

type ClaudeSessionContentFile = ClaudeSessionFile & {
  content: string;
};

type ClaudeContextHint = {
  model?: string;
  contextWindow?: number;
};

type ClaudeUsageAccumulator = {
  total: Required<Pick<TokenUsage, "inputTokens" | "cachedInputTokens" | "outputTokens" | "totalTokens">>;
  last?: TokenUsage;
  updatedAt?: string;
};

const CLAUDE_TELEMETRY_CACHE_TTL_MS = 15_000;
const claudeTelemetryCache = new Map<string, { expiresAt: number; hints: Map<string, ClaudeContextHint> }>();

export async function listCachedTargets(): Promise<AiTarget[]> {
  return (await getCachedTargets()).filter((target) => target.provider === "claude");
}

export async function listTargets(): Promise<AiTarget[]> {
  return listCliTargets("claude", probeLocalTarget, probeWslTargets);
}

export async function listCachedSessions(_targetId: string, _view: SessionView): Promise<AiSession[]> {
  return (await applySessionMetadataList(
    _targetId,
    await listCachedProviderSessions<AiSession>(getClaudeCacheKey(_targetId, _view))
  )).sort(sortSessionsByRecency);
}

export async function listSessions(targetId: string): Promise<AiSession[]> {
  return measure(`sessions.list.${targetId}`, async () => {
    const sessions = await loadClaudeSessions(targetId, "active");
    return sessions.sort(sortSessionsByRecency);
  });
}

export async function listTrashSessions(targetId: string): Promise<AiSession[]> {
  return measure(`sessions.trash.list.${targetId}`, async () => {
    const sessions = await loadClaudeSessions(targetId, "trash");
    return sessions.sort(sortSessionsByRecency);
  });
}

export async function searchSessions(targetId: string, view: SessionView, query: string): Promise<AiSession[]> {
  const sessions = view === "trash" ? await listTrashSessions(targetId) : await listSessions(targetId);
  return searchSessionsByContent({
    sessions,
    query,
    resolveContext: () => resolveClaudeTargetContext(targetId)
  });
}

export async function getSession(targetId: string, sessionId: string, ref?: SessionFileRef): Promise<AiSession> {
  const context = await resolveClaudeTargetContext(targetId);
  if (ref?.filePath) {
    assertClaudeSessionPath(context, ref.filePath, "active");
    await verifyClaudeSessionId(context, ref.filePath, sessionId);
    const session = await readClaudeSessionLines(context, { filePath: ref.filePath });
    if (!session || session.id !== sessionId) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
    return (await applySessionMetadataList(targetId, [session]))[0];
  }
  const cached = await findCachedClaudeSession(targetId, sessionId);
  if (cached) {
    try {
      const session = parseClaudeSessionFile(await readClaudeSessionContent(context, { filePath: cached.filePath }));
      if (session?.id === sessionId) return (await applySessionMetadataList(targetId, [session]))[0];
    } catch {
      // 缓存命中但会话已被移动或删除，回退到完整发现流程。
    }
  }
  const session = [
    ...(await loadClaudeSessions(targetId, "active")),
    ...(await loadClaudeSessions(targetId, "trash"))
  ].find((item) => item.id === sessionId);
  if (!session) throw new Error(`未找到 Claude Code 会话：${sessionId}`);
  return session;
}

export async function getSessionMessagesPage(targetId: string, sessionId: string, offset: number, limit: number): Promise<SessionMessagePage> {
  const context = await resolveClaudeTargetContext(targetId);
  const storage = createSessionStorage(context);
  const session = await getSessionSummary(targetId, sessionId);
  const latest = offset === -1;
  const pageOffset = latest ? 0 : offset;
  const messages: AiMessage[] = [];
  let previous: AiMessage | null = null;
  let hasMore = false;
  const fileMtimeMs = session.fileMtimeMs || Date.parse(session.updatedAt || "") || 0;
  const fileSize = session.fileSize || 0;
  const anchor = !latest && hasAppDatabase() ? await readSessionMessageIndex({ targetId, sessionId, filePath: session.filePath, mtimeMs: fileMtimeMs, size: fileSize }, pageOffset) : null;
  const anchors: Array<{ messageOffset: number; lineNumber: number }> = [];
  let index = anchor?.messageOffset || 0;
  const push = (line: string, lineNumber: number) => {
    const value = safeJsonParse(line.trim()) as Record<string, any> | null;
    const message = value?.message;
    if (!value || (value.type !== "user" && value.type !== "assistant") || value.isMeta || !message || typeof message !== "object") return true;
    const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
    const text = role ? extractClaudeContentText(message.content) : "";
    if (!role || !text) return true;
    const next: AiMessage = { role, text, timestamp: typeof value.timestamp === "string" ? value.timestamp : undefined };
    if (previous?.role === next.role && previous.text === next.text) return true;
    previous = next;
    if (!latest && index >= pageOffset + limit) { hasMore = true; return false; }
    if (index % 100 === 0) anchors.push({ messageOffset: index, lineNumber });
    if (latest) {
      messages.push(next);
      if (messages.length > limit) messages.shift();
      index += 1;
      return true;
    }
    if (index++ >= pageOffset) messages.push(next);
    return true;
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
    messageCount: Math.max(session.messageCount, anchor?.messageCount || 0, hasMore ? 0 : index)
  });
  return { offset: latest ? Math.max(0, index - messages.length) : pageOffset, messages, hasMore: latest ? index > messages.length : hasMore };
}

export async function getSessionSummary(targetId: string, sessionId: string): Promise<AiSession> {
  const cached = [
    ...(await listCachedSessions(targetId, "active")),
    ...(await listCachedSessions(targetId, "trash"))
  ].find((session) => session.id === sessionId);
  if (cached) return cached;

  const session = [
    ...(await listSessions(targetId)),
    ...(await listTrashSessions(targetId))
  ].find((item) => item.id === sessionId);
  if (!session) throw new Error(`未找到 Claude Code 会话：${sessionId}`);
  return session;
}

export async function listSessionsByParent(targetId: string, parentSessionId: string): Promise<AiSession[]> {
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
  return getWslDistroFromProviderTarget("claude", targetId)
    ? path.posix.dirname(session.filePath)
    : path.dirname(session.filePath);
}

export async function branchSession(targetId: string, sessionId: string, messageIndex: number): Promise<AiSession> {
  return measure(`sessions.branch.${targetId}`, async () => {
    if (messageIndex <= 0) throw new Error("请选择至少一条前置上下文后再创建分支。");

    const context = await resolveClaudeTargetContext(targetId);
    const session = await findClaudeSession(targetId, sessionId, "active");
    const branchId = crypto.randomUUID();
    const branchText = await readClaudeBranchText(context, session.filePath, branchId, messageIndex);
    const branchPath = buildClaudeBranchPath(context, session.filePath, branchId);

    await createSessionStorage(context).writeText(branchPath, branchText);

    const branch = parseClaudeSessionFile({
      filePath: branchPath,
      content: branchText,
      mtimeMs: Date.now()
    });
    if (!branch) throw new Error("创建 Claude 分支失败。");
    branch.metadata = await setSessionBranchMetadata(targetId, branch.id, {
      parentTargetId: targetId,
      parentSessionId: session.id,
      parentMessageIndex: messageIndex,
      createdBy: "branch"
    });
    return branch;
  });
}

export async function duplicateSession(targetId: string, sessionId: string): Promise<AiSession> {
  return measure(`sessions.duplicate.${targetId}`, async () => {
    const context = await resolveClaudeTargetContext(targetId);
    const session = await findClaudeSession(targetId, sessionId, "active");
    const duplicateId = crypto.randomUUID();
    const storage = createSessionStorage(context);
    const sourceText = await storage.readText(session.filePath);
    const duplicateText = buildClaudeDuplicateText(sourceText, duplicateId);
    const duplicatePath = buildClaudeBranchPath(context, session.filePath, duplicateId);

    await storage.writeText(duplicatePath, duplicateText);

    const duplicated = parseClaudeSessionFile({ filePath: duplicatePath, content: duplicateText });
    if (!duplicated) throw new Error("复制 Claude Code 会话失败。");
    return duplicated;
  });
}

export async function deleteSession(targetId: string, sessionId: string, ref?: SessionFileRef): Promise<{ movedTo: string }> {
  return measure(`sessions.delete.${targetId}`, async () => {
    const context = await resolveClaudeTargetContext(targetId);
    const storage = createSessionStorage(context);
    const session = await getClaudeSessionForMutation(targetId, context, sessionId, "active", ref);
    const movedTo = buildClaudeTrashPath(context, session.filePath);

    assertClaudeSessionPath(context, session.filePath, "active");
    await storage.move(session.filePath, movedTo);

    return { movedTo };
  });
}

export async function deleteSessions(targetId: string, sessions: SessionMutationRef[]): Promise<SessionBatchMutationResult> {
  return mutateClaudeSessionsBatch(targetId, sessions, "active");
}

export async function purgeSessions(targetId: string, sessions: SessionMutationRef[]): Promise<SessionBatchMutationResult> {
  return mutateClaudeSessionsBatch(targetId, sessions, "trash");
}

async function mutateClaudeSessionsBatch(
  targetId: string,
  sessions: SessionMutationRef[],
  view: SessionView
): Promise<SessionBatchMutationResult> {
  return measure(`sessions.${view === "trash" ? "purge" : "delete"}.batch.${targetId}`, async () => {
    if (sessions.length === 0) return { processed: [] };
    const context = await resolveClaudeTargetContext(targetId);
    const storage = createSessionStorage(context);
    const plans = await planSessionMutationBatch(sessions, view, async (sessionRef) => {
      const session = await getClaudeSessionForMutation(targetId, context, sessionRef.id, view, sessionRef);
      const source = session.filePath;
      if (!source) throw new Error("Claude 会话缺少文件路径。");
      if (view === "trash") {
        return { session, source, result: { ...sessionRef, filePath: source, deleted: source } };
      }
      const movedTo = buildClaudeTrashPath(context, source);
      return { session, source, destination: movedTo, result: { ...sessionRef, filePath: source, movedTo } };
    });
    const processed = plans.map((plan) => plan.result);

    if (context.kind === "wsl") {
      const script = plans
        .map((plan) =>
          view === "trash"
            ? `rm -f -- ${shellQuote(plan.source)}`
            : `mkdir -p ${shellQuote(path.posix.dirname(plan.destination!))} && mv -- ${shellQuote(plan.source)} ${shellQuote(plan.destination!)}`
        )
        .join("\n");
      await wslRun(context.distro!, "bash", ["-lc", script]);
    } else {
      for (const plan of plans) {
        if (view === "trash") await storage.remove(plan.source);
        else await storage.move(plan.source, plan.destination!);
      }
    }

    return { processed };
  });
}

export async function restoreSession(targetId: string, sessionId: string): Promise<{ restoredTo: string }> {
  return measure(`sessions.restore.${targetId}`, async () => {
    const context = await resolveClaudeTargetContext(targetId);
    const storage = createSessionStorage(context);
    const session = await findClaudeSession(targetId, sessionId, "trash");
    const restoredTo = buildClaudeRestorePath(context, session.filePath);

    assertClaudeSessionPath(context, session.filePath, "trash");
    if (await storage.exists(restoredTo)) throw new Error("恢复目标已存在，已拒绝覆盖。");
    await storage.move(session.filePath, restoredTo);

    return { restoredTo };
  });
}

export async function purgeSession(targetId: string, sessionId: string, ref?: SessionFileRef): Promise<{ deleted: string }> {
  return measure(`sessions.purge.${targetId}`, async () => {
    const context = await resolveClaudeTargetContext(targetId);
    const storage = createSessionStorage(context);
    const session = await getClaudeSessionForMutation(targetId, context, sessionId, "trash", ref);

    assertClaudeSessionPath(context, session.filePath, "trash");
    await storage.remove(session.filePath);

    return { deleted: session.filePath };
  });
}

async function loadClaudeSessions(targetId: string, view: SessionView): Promise<AiSession[]> {
  const context = await resolveClaudeTargetContext(targetId);
  const files = context.kind === "wsl"
    ? await listWslSessionFiles(context, view)
    : await listLocalSessionFiles(context, view);
  const cacheKey = getClaudeCacheKey(targetId, view);
  return loadProviderSessionList(
    cacheKey,
    files,
    (file) => readClaudeSessionLines(context, file, { maxMessages: CLAUDE_LIST_PREVIEW_LIMIT }),
    async (sessions) => {
      const contextHints = view === "active" ? await loadClaudeContextHints(context) : new Map<string, ClaudeContextHint>();
      const parsed = sessions.map((session) => applyClaudeContextHint(session, contextHints.get(session.id)));
      return applySessionMetadataList(targetId, parsed);
    }
  );
}

async function resolveClaudeTargetContext(targetId: string): Promise<ClaudeTargetContext> {
  return resolveProviderTargetContext(targetId, {
    provider: "claude",
    localTargetId: "claude:local",
    localConfigDir: path.join(os.homedir(), ".claude"),
    resolveWslConfigDir: async (distro) => path.posix.join(await wslGetEnv(distro, "HOME"), ".claude"),
    displayName: "Claude Code"
  });
}

async function findClaudeSession(targetId: string, sessionId: string, view: SessionView) {
  const session = (await loadClaudeSessions(targetId, view)).find((item) => item.id === sessionId);
  if (!session) throw new Error(view === "trash" ? `未在 Claude 回收站找到会话：${sessionId}` : `未找到 Claude 会话：${sessionId}`);
  return session;
}

function getClaudeCacheKey(targetId: string, view: SessionView) {
  return `sessions:claude:${targetId}:${view}:v3`;
}

async function findCachedClaudeSession(targetId: string, sessionId: string): Promise<AiSession | null> {
  return findCachedProviderSession<AiSession>(
    [getClaudeCacheKey(targetId, "active"), getClaudeCacheKey(targetId, "trash")],
    sessionId
  );
}

async function readClaudeSessionContent(
  context: ClaudeTargetContext,
  file: ClaudeSessionFile
): Promise<ClaudeSessionContentFile> {
  const content = await createSessionStorage(context).readText(file.filePath);
  return { ...file, content };
}

async function getClaudeSessionForMutation(
  targetId: string,
  context: ClaudeTargetContext,
  sessionId: string,
  view: SessionView,
  ref?: SessionFileRef
) {
  if (!ref?.filePath) return findClaudeSession(targetId, sessionId, view);
  assertClaudeSessionPath(context, ref.filePath, view);
  const content = await createSessionStorage(context).readText(ref.filePath);
  const session = parseClaudeSessionFile({ filePath: ref.filePath, content });
  if (!session || session.id !== sessionId) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
  return session;
}

function assertClaudeSessionPath(context: ClaudeTargetContext, filePath: string, view: SessionView) {
  const root = view === "trash" ? getClaudeTrashProjectsRoot(context) : getClaudeProjectsRoot(context);
  assertSessionFileInside(filePath, root, context.kind, "拒绝操作 Claude 会话目录之外的文件");
}

async function verifyClaudeSessionId(context: ClaudeTargetContext, filePath: string, sessionId: string) {
  let found = false;
  const inspect = (line: string) => {
    const value = safeJsonParse(line.trim()) as Record<string, unknown> | null;
    const candidate = typeof value?.sessionId === "string" ? value.sessionId : "";
    if (!candidate) return true;
    found = true;
    if (candidate !== sessionId) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
    return false;
  };
  await createSessionStorage(context).readLines(filePath, inspect);
  if (!found) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
}

function getClaudeProjectsRoot(context: ClaudeTargetContext) {
  return context.kind === "wsl"
    ? path.posix.join(context.configDir, "projects")
    : path.join(context.configDir, "projects");
}

function getClaudeTrashProjectsRoot(context: ClaudeTargetContext) {
  return context.kind === "wsl"
    ? path.posix.join(context.configDir, ".visual-console-trash", "projects")
    : path.join(context.configDir, ".visual-console-trash", "projects");
}

function buildClaudeTrashPath(context: ClaudeTargetContext, source: string) {
  const projectsRoot = getClaudeProjectsRoot(context);
  const trashRoot = getClaudeTrashProjectsRoot(context);
  return relocateSessionPath(source, projectsRoot, trashRoot, context.kind, "拒绝移动 Claude projects 目录之外的文件");
}

function buildClaudeRestorePath(context: ClaudeTargetContext, source: string) {
  const trashRoot = getClaudeTrashProjectsRoot(context);
  const projectsRoot = getClaudeProjectsRoot(context);
  return relocateSessionPath(source, trashRoot, projectsRoot, context.kind, "拒绝恢复 Claude 回收站之外的文件");
}

async function listLocalSessionFiles(context: ClaudeTargetContext, view: SessionView): Promise<ClaudeSessionFile[]> {
  const projectsRoot = view === "trash" ? getClaudeTrashProjectsRoot(context) : getClaudeProjectsRoot(context);
  const projectDirs = await listLocalDirectories(projectsRoot);
  const files: ClaudeSessionFile[] = [];

  for (const projectDir of projectDirs) {
    const entries = await fs.readdir(projectDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(projectDir, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat) files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }

  return files;
}

async function listLocalDirectories(root: string) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}

async function listWslSessionFiles(context: ClaudeTargetContext, view: SessionView): Promise<ClaudeSessionFile[]> {
  const projectsRoot = view === "trash" ? getClaudeTrashProjectsRoot(context) : getClaudeProjectsRoot(context);
  const { stdout } = await wslRun(context.distro!, "find", [
    projectsRoot,
    "-mindepth",
    "2",
    "-maxdepth",
    "2",
    "-type",
    "f",
    "-name",
    "*.jsonl",
    "-printf",
    "%p\t%T@\t%s\n"
  ]).catch(() => ({ stdout: "" }));

  const files = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [filePath, mtime, size] = line.split("\t");
      return {
        filePath,
        mtimeMs: Number.parseFloat(mtime) * 1000 || 0,
        size: Number.parseInt(size, 10) || 0
      };
    });
  return files;
}

async function loadClaudeContextHints(context: ClaudeTargetContext): Promise<Map<string, ClaudeContextHint>> {
  const cacheKey = context.targetId;
  const cached = claudeTelemetryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.hints;
  const files = context.kind === "wsl"
    ? await listWslTelemetryFiles(context)
    : await listLocalTelemetryFiles(context);
  const storage = createSessionStorage(context);
  const hints = new Map<string, ClaudeContextHint>();

  for (const file of files) {
    const content = await storage.readText(file).catch(() => "");
    if (!content) continue;
    collectClaudeContextHints(content, hints);
  }

  claudeTelemetryCache.set(cacheKey, { hints, expiresAt: Date.now() + CLAUDE_TELEMETRY_CACHE_TTL_MS });
  return hints;
}

async function listLocalTelemetryFiles(context: ClaudeTargetContext) {
  const telemetryRoot = path.join(context.configDir, "telemetry");
  const entries = await fs.readdir(telemetryRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(telemetryRoot, entry.name));
}

async function listWslTelemetryFiles(context: ClaudeTargetContext) {
  const telemetryRoot = path.posix.join(context.configDir, "telemetry");
  const { stdout } = await wslRun(context.distro!, "find", [
    telemetryRoot,
    "-maxdepth",
    "1",
    "-type",
    "f",
    "-name",
    "*.json",
    "-size",
    "-5M",
    "-print"
  ]).catch(() => ({ stdout: "" }));
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function collectClaudeContextHints(content: string, hints: Map<string, ClaudeContextHint>) {
  for (const line of content.split(/\r?\n/)) {
    const record = safeJsonParse(line.trim());
    if (!record || typeof record !== "object") continue;
    const eventData = (record as Record<string, any>).event_data;
    if (!eventData || typeof eventData !== "object") continue;
    const sessionId = typeof eventData.session_id === "string" ? eventData.session_id : "";
    if (!sessionId) continue;
    const model = typeof eventData.model === "string" ? eventData.model : "";
    const betas = typeof eventData.betas === "string" ? eventData.betas : "";
    const contextWindow = inferClaudeTelemetryContextWindow(model, betas);
    if (!model && !contextWindow) continue;

    const current = hints.get(sessionId) || {};
    hints.set(sessionId, {
      model: model || current.model,
      contextWindow: contextWindow || current.contextWindow
    });
  }
}

function parseClaudeSessionFile(file: ClaudeSessionContentFile): AiSession | null {
  const parser = createClaudeSessionParser(file);
  for (const line of file.content.split(/\r?\n/)) parser.push(line);
  return parser.finish();
}

function createClaudeSessionParser(file: ClaudeSessionFile, options: { maxMessages?: number } = {}) {
  const sessionId = path.basename(file.filePath, ".jsonl");
  const messages: AiMessage[] = [];
  let resolvedSessionId = "";
  let cwd = "";
  let model = "";
  let createdAt = "";
  let updatedAt = "";
  let fallbackTitle = "";
  let userTitle = "";
  const usage = createClaudeUsageAccumulator();
  let messageCount = 0;
  let previousMessage: AiMessage | null = null;

  function push(line: string) {
    const record = safeJsonParse(line.trim());
    if (!record || typeof record !== "object") return;
    const value = record as Record<string, any>;
    resolvedSessionId ||= findString([value], "sessionId");
    const timestamp = typeof value.timestamp === "string" ? value.timestamp : "";
    if (timestamp && !createdAt) createdAt = timestamp;
    if (timestamp) updatedAt = timestamp;
    if (!cwd && typeof value.cwd === "string") cwd = value.cwd;

    if (value.type === "last-prompt" && typeof value.lastPrompt === "string") {
      fallbackTitle = value.lastPrompt;
      return;
    }

    if (value.type !== "user" && value.type !== "assistant") return;
    const message = value.message;
    if (!message || typeof message !== "object") return;
    const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
    if (!role) return;
    if (value.isMeta === true) return;

    if (role === "assistant" && !model && typeof message.model === "string") model = message.model;
    if (role === "assistant") accumulateClaudeUsage(usage, message.usage, timestamp);
    const text = extractClaudeContentText(message.content);
    if (!text) return;
    const visible: AiMessage = { role, text, timestamp };
    if (previousMessage?.role === visible.role && previousMessage.text === visible.text) return;
    previousMessage = visible;
    messageCount += 1;
    const retainMessage = options.maxMessages === undefined || messages.length < options.maxMessages;
    const needsTitle = role === "user" && !userTitle;
    if (!retainMessage && !needsTitle) return;
    if (needsTitle) userTitle = text;
    if (retainMessage) messages.push(visible);
  }

  function finish(): AiSession | null {
    if (messages.length === 0 && !resolvedSessionId) return null;
    const updatedAtFromMtime = file.mtimeMs ? new Date(file.mtimeMs).toISOString() : "";
    const effectiveUpdatedAt = latestIsoTimestamp(updatedAt, updatedAtFromMtime);
    const title = userTitle || fallbackTitle || resolvedSessionId || sessionId;
    return {
      id: resolvedSessionId || sessionId,
      title: compactTitle(title),
      cwd,
      createdAt: createdAt || updatedAtFromMtime,
      updatedAt: effectiveUpdatedAt || createdAt,
      model,
      filePath: file.filePath,
      fileMtimeMs: file.mtimeMs,
      fileSize: file.size,
      messageCount,
      preview: messages,
      usage: buildClaudeSessionUsage(usage, inferClaudeContextWindow(model))
    };
  }

  return { push, finish };
}

async function readClaudeSessionLines(
  context: ClaudeTargetContext,
  file: ClaudeSessionFile,
  options?: { maxMessages?: number }
): Promise<AiSession | null> {
  const parser = createClaudeSessionParser(file, options);
  return readSessionWithParser(createSessionStorage(context), file.filePath, parser);
}

async function readClaudeBranchText(context: ClaudeTargetContext, filePath: string, branchId: string, keepMessageCount: number) {
  const output: string[] = [];
  let keptMessages = 0;
  const push = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    const record = safeJsonParse(trimmed);
    if (!record || typeof record !== "object") return true;
    output.push(JSON.stringify(rewriteClaudeSessionId(record as Record<string, any>, branchId)));
    if (isCountableClaudeMessage(record as Record<string, any>)) {
      keptMessages += 1;
      if (keptMessages >= keepMessageCount) return false;
    }
    return true;
  };
  await createSessionStorage(context).readLines(filePath, push);
  if (keptMessages < keepMessageCount) throw new Error("创建 Claude 分支失败：原始 jsonl 中可保留消息不足。");
  return `${output.join("\n")}\n`;
}

function buildClaudeDuplicateText(sourceText: string, duplicateId: string) {
  const output: string[] = [];
  let rewritten = false;

  for (const line of sourceText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      output.push(line);
      continue;
    }
    const record = safeJsonParse(trimmed);
    if (!record || typeof record !== "object") {
      output.push(line);
      continue;
    }
    const next = rewriteClaudeSessionId(record as Record<string, any>, duplicateId);
    rewritten ||= next.sessionId === duplicateId;
    output.push(JSON.stringify(next));
  }

  if (!rewritten) throw new Error("复制 Claude Code 会话失败：缺少会话编号。");
  return `${output.join("\n")}\n`;
}

function rewriteClaudeSessionId(record: Record<string, any>, branchId: string) {
  return {
    ...record,
    sessionId: typeof record.sessionId === "string" ? branchId : record.sessionId
  };
}

function isCountableClaudeMessage(record: Record<string, any>) {
  if (record.type !== "user" && record.type !== "assistant") return false;
  if (record.isMeta === true) return false;
  const message = record.message;
  if (!message || typeof message !== "object") return false;
  const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "";
  if (!role) return false;
  return Boolean(extractClaudeContentText(message.content));
}

function buildClaudeBranchPath(context: ClaudeTargetContext, sourcePath: string, branchId: string) {
  return context.kind === "wsl"
    ? path.posix.join(path.posix.dirname(sourcePath), `${branchId}.jsonl`)
    : path.join(path.dirname(sourcePath), `${branchId}.jsonl`);
}

function extractClaudeContentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function createClaudeUsageAccumulator(): ClaudeUsageAccumulator {
  return {
    total: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
  };
}

function accumulateClaudeUsage(accumulator: ClaudeUsageAccumulator, value: unknown, timestamp: string) {
  if (!value || typeof value !== "object") return;
  const usage = value as Record<string, unknown>;
  const inputTokens = readNumber(usage.input_tokens);
  const cacheCreationInputTokens = readNumber(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = readNumber(usage.cache_read_input_tokens);
  const outputTokens = readNumber(usage.output_tokens);
  const cachedInputTokens = cacheCreationInputTokens + cacheReadInputTokens;
  const totalTokens = inputTokens + cachedInputTokens + outputTokens;
  if (totalTokens <= 0) return;

  accumulator.total.inputTokens += inputTokens;
  accumulator.total.cachedInputTokens += cachedInputTokens;
  accumulator.total.outputTokens += outputTokens;
  accumulator.total.totalTokens += totalTokens;
  accumulator.last = {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens
  };
  accumulator.updatedAt = timestamp || accumulator.updatedAt;
}

function buildClaudeSessionUsage(accumulator: ClaudeUsageAccumulator, contextWindow?: number): SessionUsage | undefined {
  if (accumulator.total.totalTokens <= 0) return undefined;
  const contextUsedTokens = (accumulator.last?.inputTokens || 0) + (accumulator.last?.cachedInputTokens || 0);
  const contextPercent = contextWindow && contextUsedTokens > 0
    ? Math.min(100, Math.round((contextUsedTokens / contextWindow) * 100))
    : undefined;
  return {
    total: accumulator.total,
    last: accumulator.last,
    contextWindow,
    contextUsedTokens: contextUsedTokens || undefined,
    contextPercent,
    contextLeftPercent: typeof contextPercent === "number" ? Math.max(0, 100 - contextPercent) : undefined,
    updatedAt: accumulator.updatedAt,
    source: "claude-message-usage"
  };
}

function applyClaudeContextHint(session: AiSession, hint?: ClaudeContextHint): AiSession {
  if (!hint) return session;
  const model = hint.model || session.model;
  if (!hint.contextWindow || !session.usage) return model === session.model ? session : { ...session, model };
  return {
    ...session,
    model,
    usage: applyContextWindow(session.usage, hint.contextWindow)
  };
}

function applyContextWindow(usage: SessionUsage, contextWindow: number): SessionUsage {
  const contextUsedTokens =
    usage.contextUsedTokens ||
    (usage.last?.inputTokens || 0) + (usage.last?.cachedInputTokens || 0);
  const contextPercent = contextUsedTokens > 0
    ? Math.min(100, Math.round((contextUsedTokens / contextWindow) * 100))
    : undefined;
  return {
    ...usage,
    contextWindow,
    contextUsedTokens: contextUsedTokens || undefined,
    contextPercent,
    contextLeftPercent: typeof contextPercent === "number" ? Math.max(0, 100 - contextPercent) : undefined
  };
}

function inferClaudeTelemetryContextWindow(model: string, betas: string) {
  const normalizedModel = model.toLowerCase();
  const normalizedBetas = betas.toLowerCase();
  if (normalizedModel.includes("[1m]") || normalizedBetas.includes("context-1m")) {
    return CLAUDE_ONE_MILLION_CONTEXT_WINDOW;
  }
  return undefined;
}

function inferClaudeContextWindow(model: string) {
  const normalized = model.toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("[1m]") || normalized.includes("opus-4-8")) return CLAUDE_ONE_MILLION_CONTEXT_WINDOW;
  if (normalized.startsWith("claude-")) return CLAUDE_DEFAULT_CONTEXT_WINDOW;
  return undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function findString(records: Record<string, any>[], key: string) {
  for (const record of records) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return "";
}

function compactTitle(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 160);
}

function latestIsoTimestamp(left: string, right: string) {
  const leftTime = Date.parse(left || "");
  const rightTime = Date.parse(right || "");
  if (!Number.isFinite(leftTime)) return right || "";
  if (!Number.isFinite(rightTime)) return left || "";
  return rightTime > leftTime ? right : left;
}

function probeLocalTarget() {
  return probeLocalCliTarget({
    provider: "claude",
    displayName: "Claude Code",
    windowsCommand: "claude.cmd",
    unixCommand: "claude",
    configDir: path.join(os.homedir(), ".claude")
  });
}

function probeWslTargets() {
  return probeWslCliTargets({
    provider: "claude",
    displayName: "Claude Code",
    command: "claude",
    resolveConfigDir: async (distro) => {
      const home = await wslGetEnv(distro, "HOME").catch(() => "");
      return home ? path.posix.join(home, ".claude") : "";
    }
  });
}
