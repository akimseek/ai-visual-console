import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AiMessage, AiSession, AiTarget, SessionBatchMutationResult, SessionFileRef, SessionMutationRef, SessionUsage, TokenUsage } from "./types";
import type { SessionView } from "./aiProviders";
import { measure } from "./performance";
import { applySessionMetadataList, setSessionBranchMetadata } from "./sessionMetadata";
import { getCachedTargets, setCachedTargets } from "./settings";
import {
  findCachedProviderSession,
  listCachedProviderSessions,
  loadProviderSessionCache
} from "./providerSessionCache";

const execFileAsync = promisify(execFile);
const INTERNAL_WSL_DISTROS = new Set(["docker-desktop", "docker-desktop-data"]);
const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000;
const CLAUDE_ONE_MILLION_CONTEXT_WINDOW = 1_000_000;

type ClaudeTargetContext = {
  targetId: string;
  kind: "local" | "wsl";
  distro?: string;
  configDir: string;
};

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

type SessionMutationEntry = SessionMutationRef & {
  filePath: string;
  movedTo?: string;
  deleted?: string;
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
  return measure("targets.list.claude", async () => {
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

export async function listCachedSessions(_targetId: string, _view: SessionView): Promise<AiSession[]> {
  return (await applySessionMetadataList(
    _targetId,
    await listCachedProviderSessions<AiSession>(getClaudeCacheKey(_targetId, _view))
  )).sort(sortSessionDesc);
}

export async function listSessions(targetId: string): Promise<AiSession[]> {
  return measure(`sessions.list.${targetId}`, async () => {
    const sessions = await loadClaudeSessions(targetId, "active");
    return sessions.sort(sortSessionDesc);
  });
}

export async function listTrashSessions(targetId: string): Promise<AiSession[]> {
  return measure(`sessions.trash.list.${targetId}`, async () => {
    const sessions = await loadClaudeSessions(targetId, "trash");
    return sessions.sort(sortSessionDesc);
  });
}

export async function searchSessions(targetId: string, view: SessionView, query: string): Promise<AiSession[]> {
  const normalized = query.trim().toLowerCase();
  const sessions = view === "trash" ? await listTrashSessions(targetId) : await listSessions(targetId);
  if (!normalized) return sessions;

  return sessions.filter((session) =>
    [session.id, session.title, session.sourceTitle || "", session.cwd || "", session.model || "", ...session.preview.map((message) => message.text)]
      .join("\n")
      .toLowerCase()
      .includes(normalized)
  );
}

export async function getSession(targetId: string, sessionId: string): Promise<AiSession> {
  const context = await resolveClaudeTargetContext(targetId);
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

export async function listSessionsByParent(targetId: string, parentSessionId: string): Promise<AiSession[]> {
  return measure(`sessions.children.${targetId}`, async () => {
    const sessions = await listSessions(targetId);
    return sessions.filter((session) => session.metadata?.branch?.parentSessionId === parentSessionId);
  });
}

export async function getSessionFolderPath(targetId: string, sessionId: string): Promise<string> {
  const session = await getSession(targetId, sessionId);
  return targetId.startsWith("claude:wsl:")
    ? path.posix.dirname(session.filePath)
    : path.dirname(session.filePath);
}

export async function branchSession(targetId: string, sessionId: string, messageIndex: number): Promise<AiSession> {
  return measure(`sessions.branch.${targetId}`, async () => {
    if (messageIndex <= 0) throw new Error("请选择至少一条前置上下文后再创建分支。");

    const context = await resolveClaudeTargetContext(targetId);
    const session = await findClaudeSession(targetId, sessionId, "active");
    const branchId = crypto.randomUUID();
    const sourceText = context.kind === "wsl"
      ? await wslReadFile(context.distro!, session.filePath)
      : await fs.readFile(session.filePath, "utf8");
    const branchText = buildClaudeBranchText(sourceText, branchId, messageIndex);
    const branchPath = buildClaudeBranchPath(context, session.filePath, branchId);

    if (context.kind === "wsl") {
      await wslWriteFile(context.distro!, branchPath, branchText);
    } else {
      await fs.mkdir(path.dirname(branchPath), { recursive: true });
      await fs.writeFile(branchPath, branchText, "utf8");
    }

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
    const sourceText = context.kind === "wsl"
      ? await wslReadFile(context.distro!, session.filePath)
      : await fs.readFile(session.filePath, "utf8");
    const duplicateText = buildClaudeDuplicateText(sourceText, duplicateId);
    const duplicatePath = buildClaudeBranchPath(context, session.filePath, duplicateId);

    if (context.kind === "wsl") {
      await wslWriteFile(context.distro!, duplicatePath, duplicateText);
    } else {
      await fs.mkdir(path.dirname(duplicatePath), { recursive: true });
      await fs.writeFile(duplicatePath, duplicateText, "utf8");
    }

    const duplicated = parseClaudeSessionFile({ filePath: duplicatePath, content: duplicateText });
    if (!duplicated) throw new Error("复制 Claude Code 会话失败。");
    return duplicated;
  });
}

export async function deleteSession(targetId: string, sessionId: string, ref?: SessionFileRef): Promise<{ movedTo: string }> {
  return measure(`sessions.delete.${targetId}`, async () => {
    const context = await resolveClaudeTargetContext(targetId);
    const session = await getClaudeSessionForMutation(targetId, context, sessionId, "active", ref);
    const movedTo = buildClaudeTrashPath(context, session.filePath);

    if (context.kind === "wsl") {
      assertInsidePosix(session.filePath, getClaudeProjectsRoot(context), "拒绝移动 Claude projects 目录之外的文件");
      await moveWslSession(context, session.filePath, movedTo);
    } else {
      assertInsideLocal(session.filePath, getClaudeProjectsRoot(context), "拒绝移动 Claude projects 目录之外的文件");
      await moveLocalSession(session.filePath, movedTo);
    }

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
    const processed = await Promise.all(sessions.map(async (sessionRef): Promise<SessionMutationEntry> => {
      const session = await getClaudeSessionForMutation(targetId, context, sessionRef.id, view, sessionRef);
      if (view === "trash") {
        return { ...sessionRef, filePath: session.filePath, deleted: session.filePath };
      }
      return { ...sessionRef, filePath: session.filePath, movedTo: buildClaudeTrashPath(context, session.filePath) };
    }));

    if (context.kind === "wsl") {
      const script = processed
        .map((entry) =>
          view === "trash"
            ? `rm -f -- ${shellQuote(entry.filePath)}`
            : `mkdir -p ${shellQuote(path.posix.dirname(entry.movedTo!))} && mv -- ${shellQuote(entry.filePath)} ${shellQuote(entry.movedTo!)}`
        )
        .join("\n");
      await wslRun(context.distro!, "bash", ["-lc", script]);
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
    const context = await resolveClaudeTargetContext(targetId);
    const session = await findClaudeSession(targetId, sessionId, "trash");
    const restoredTo = buildClaudeRestorePath(context, session.filePath);

    if (context.kind === "wsl") {
      assertInsidePosix(session.filePath, getClaudeTrashProjectsRoot(context), "拒绝恢复 Claude 回收站之外的文件");
      if (await wslPathExists(context.distro!, restoredTo).catch(() => false)) throw new Error("恢复目标已存在，已拒绝覆盖。");
      await moveWslSession(context, session.filePath, restoredTo);
    } else {
      assertInsideLocal(session.filePath, getClaudeTrashProjectsRoot(context), "拒绝恢复 Claude 回收站之外的文件");
      if (await pathExists(restoredTo)) throw new Error("恢复目标已存在，已拒绝覆盖。");
      await moveLocalSession(session.filePath, restoredTo);
    }

    return { restoredTo };
  });
}

export async function purgeSession(targetId: string, sessionId: string, ref?: SessionFileRef): Promise<{ deleted: string }> {
  return measure(`sessions.purge.${targetId}`, async () => {
    const context = await resolveClaudeTargetContext(targetId);
    const session = await getClaudeSessionForMutation(targetId, context, sessionId, "trash", ref);

    if (context.kind === "wsl") {
      assertInsidePosix(session.filePath, getClaudeTrashProjectsRoot(context), "拒绝删除 Claude 回收站之外的文件");
      await wslRun(context.distro!, "rm", ["-f", session.filePath]);
    } else {
      assertInsideLocal(session.filePath, getClaudeTrashProjectsRoot(context), "拒绝删除 Claude 回收站之外的文件");
      await fs.unlink(session.filePath);
    }

    return { deleted: session.filePath };
  });
}

async function loadClaudeSessions(targetId: string, view: SessionView): Promise<AiSession[]> {
  const context = await resolveClaudeTargetContext(targetId);
  const files = context.kind === "wsl"
    ? await listWslSessionFiles(context, view)
    : await listLocalSessionFiles(context, view);
  const cacheKey = getClaudeCacheKey(targetId, view);
  const sessions = await loadProviderSessionCache(cacheKey, files, async (file) =>
    parseClaudeSessionFile(await readClaudeSessionContent(context, file))
  );
  const contextHints = view === "active" ? await loadClaudeContextHints(context) : new Map<string, ClaudeContextHint>();
  const parsed = sessions.map((session) => applyClaudeContextHint(session, contextHints.get(session.id)));
  return applySessionMetadataList(targetId, parsed);
}

async function resolveClaudeTargetContext(targetId: string): Promise<ClaudeTargetContext> {
  if (targetId === "claude:local") {
    return {
      targetId,
      kind: "local",
      configDir: path.join(os.homedir(), ".claude")
    };
  }

  if (targetId.startsWith("claude:wsl:")) {
    const distro = targetId.slice("claude:wsl:".length);
    const home = await wslGetEnv(distro, "HOME");
    return {
      targetId,
      kind: "wsl",
      distro,
      configDir: path.posix.join(home, ".claude")
    };
  }

  throw new Error(`未知 Claude Code 目标：${targetId}`);
}

async function findClaudeSession(targetId: string, sessionId: string, view: SessionView) {
  const session = (await loadClaudeSessions(targetId, view)).find((item) => item.id === sessionId);
  if (!session) throw new Error(view === "trash" ? `未在 Claude 回收站找到会话：${sessionId}` : `未找到 Claude 会话：${sessionId}`);
  return session;
}

function getClaudeCacheKey(targetId: string, view: SessionView) {
  return `sessions:claude:${targetId}:${view}`;
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
  const content = context.kind === "wsl"
    ? await wslReadFile(context.distro!, file.filePath)
    : await fs.readFile(file.filePath, "utf8");
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
  const root = view === "trash" ? getClaudeTrashProjectsRoot(context) : getClaudeProjectsRoot(context);
  if (context.kind === "wsl") {
    assertInsidePosix(ref.filePath, root, "拒绝操作 Claude 会话目录之外的文件");
    const content = await wslReadFile(context.distro!, ref.filePath);
    const session = parseClaudeSessionFile({ filePath: ref.filePath, content });
    if (!session || session.id !== sessionId) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
    return session;
  }
  assertInsideLocal(ref.filePath, root, "拒绝操作 Claude 会话目录之外的文件");
  const content = await fs.readFile(ref.filePath, "utf8");
  const session = parseClaudeSessionFile({ filePath: ref.filePath, content });
  if (!session || session.id !== sessionId) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
  return session;
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
  const relative = context.kind === "wsl"
    ? path.posix.relative(projectsRoot, source)
    : path.relative(projectsRoot, source);
  if (relative.startsWith("..")) throw new Error("拒绝移动 Claude projects 目录之外的文件");
  return context.kind === "wsl" ? path.posix.join(trashRoot, relative) : path.join(trashRoot, relative);
}

function buildClaudeRestorePath(context: ClaudeTargetContext, source: string) {
  const trashRoot = getClaudeTrashProjectsRoot(context);
  const projectsRoot = getClaudeProjectsRoot(context);
  const relative = context.kind === "wsl"
    ? path.posix.relative(trashRoot, source)
    : path.relative(trashRoot, source);
  if (relative.startsWith("..")) throw new Error("拒绝恢复 Claude 回收站之外的文件");
  return context.kind === "wsl" ? path.posix.join(projectsRoot, relative) : path.join(projectsRoot, relative);
}

async function moveLocalSession(source: string, destination: string) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
}

async function moveWslSession(context: ClaudeTargetContext, source: string, destination: string) {
  await wslRun(
    context.distro!,
    "bash",
    ["-lc", `mkdir -p ${shellQuote(path.posix.dirname(destination))} && mv -- ${shellQuote(source)} ${shellQuote(destination)}`]
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

      const message = Buffer.concat(stderr).toString("utf8").trim() || `写入 Claude 分支文件失败：${code}`;
      reject(new Error(message));
    });

    child.stdin.end(content, "utf8");
  });
}

function assertInsideLocal(filePath: string, root: string, message: string) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(message);
}

function assertInsidePosix(filePath: string, root: string, message: string) {
  const relative = path.posix.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.posix.isAbsolute(relative)) throw new Error(message);
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
  const hints = new Map<string, ClaudeContextHint>();

  for (const file of files) {
    const content = context.kind === "wsl"
      ? await wslReadFile(context.distro!, file).catch(() => "")
      : await fs.readFile(file, "utf8").catch(() => "");
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
  const records = file.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(safeJsonParse)
    .filter((record): record is Record<string, any> => Boolean(record && typeof record === "object"));
  if (records.length === 0) return null;

  const sessionId = findString(records, "sessionId") || path.basename(file.filePath, ".jsonl");
  const messages: AiMessage[] = [];
  let cwd = "";
  let model = "";
  let createdAt = "";
  let updatedAt = "";
  let fallbackTitle = "";
  const usage = createClaudeUsageAccumulator();

  for (const record of records) {
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
    if (timestamp && !createdAt) createdAt = timestamp;
    if (timestamp) updatedAt = timestamp;
    if (!cwd && typeof record.cwd === "string") cwd = record.cwd;

    if (record.type === "last-prompt" && typeof record.lastPrompt === "string") {
      fallbackTitle = record.lastPrompt;
      continue;
    }

    if (record.type !== "user" && record.type !== "assistant") continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
    if (!role) continue;
    if (record.isMeta === true) continue;

    if (role === "assistant" && !model && typeof message.model === "string") model = message.model;
    if (role === "assistant") accumulateClaudeUsage(usage, message.usage, timestamp);
    const text = extractClaudeContentText(message.content);
    if (!text) continue;
    messages.push({ role, text, timestamp });
  }

  const updatedAtFromMtime = file.mtimeMs ? new Date(file.mtimeMs).toISOString() : "";
  const effectiveUpdatedAt = latestIsoTimestamp(updatedAt, updatedAtFromMtime);
  const title = messages.find((message) => message.role === "user")?.text || fallbackTitle || sessionId;

  return {
    id: sessionId,
    title: compactTitle(title),
    cwd,
    createdAt: createdAt || updatedAtFromMtime,
    updatedAt: effectiveUpdatedAt || createdAt,
    model,
    filePath: file.filePath,
    messageCount: messages.length,
    preview: messages,
    usage: buildClaudeSessionUsage(usage, inferClaudeContextWindow(model))
  };
}

function buildClaudeBranchText(sourceText: string, branchId: string, keepMessageCount: number) {
  const output: string[] = [];
  let keptMessages = 0;

  for (const line of sourceText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = safeJsonParse(trimmed);
    if (!record || typeof record !== "object") continue;
    const rewritten = rewriteClaudeSessionId(record as Record<string, any>, branchId);
    output.push(JSON.stringify(rewritten));

    if (isCountableClaudeMessage(record as Record<string, any>)) {
      keptMessages += 1;
      if (keptMessages >= keepMessageCount) break;
    }
  }

  if (keptMessages < keepMessageCount) {
    throw new Error("创建 Claude 分支失败：原始 jsonl 中可保留消息不足。");
  }

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

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sortSessionDesc(left: AiSession, right: AiSession) {
  return Date.parse(right.updatedAt || right.createdAt || "") - Date.parse(left.updatedAt || left.createdAt || "");
}

function latestIsoTimestamp(left: string, right: string) {
  const leftTime = Date.parse(left || "");
  const rightTime = Date.parse(right || "");
  if (!Number.isFinite(leftTime)) return right || "";
  if (!Number.isFinite(rightTime)) return left || "";
  return rightTime > leftTime ? right : left;
}

async function probeLocalTarget(): Promise<AiTarget | null> {
  const command = process.platform === "win32" ? "claude.cmd" : "claude";
  const found = await commandExists(command);
  const configDir = path.join(os.homedir(), ".claude");
  const hasConfigDir = await pathExists(configDir);
  if (!found && !hasConfigDir) return null;

  return {
    id: "claude:local",
    provider: "claude",
    label: `Claude Code：本机（${os.platform()}）`,
    kind: "local",
    codexHome: hasConfigDir ? configDir : undefined,
    available: found,
    detail: found
      ? hasConfigDir ? "找到 Claude 命令和配置目录" : "找到 Claude 命令"
      : "找到 Claude 配置目录，未找到 claude 命令"
  };
}

async function probeWslTargets(): Promise<AiTarget[]> {
  const distros = await listWslDistros();
  return (
    await Promise.all(
      distros.map(async (distro): Promise<AiTarget | null> => {
        const commandFound = await wslCommandExists(distro, "claude").catch(() => false);
        const home = await wslGetEnv(distro, "HOME").catch(() => "");
        const configDir = home ? path.posix.join(home, ".claude") : "";
        const hasConfigDir = configDir ? await wslPathExists(distro, configDir).catch(() => false) : false;
        if (!commandFound && !hasConfigDir) return null;

        return {
          id: `claude:wsl:${distro}`,
          provider: "claude",
          label: `Claude Code：WSL：${distro}`,
          kind: "wsl",
          distro,
          codexHome: hasConfigDir ? configDir : undefined,
          available: commandFound,
          detail: commandFound
            ? hasConfigDir ? "找到 Claude 命令和配置目录" : "找到 Claude 命令"
            : "找到 Claude 配置目录，未找到 claude 命令"
        };
      })
    )
  ).filter((target): target is AiTarget => Boolean(target));
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
    return pathExists(command);
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
