import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CodexMessage,
  CodexSession,
  CodexTarget,
  SessionBatchMutationResult,
  SessionFileRef,
  SessionMessagePage,
  SessionMutationRef,
  SessionUsage,
  TokenUsage
} from "../../types";
import type { SessionView } from "../ai-providers";
import { measure } from "../../core/performance";
import { hasAppDatabase, readSessionMessageIndex, saveSessionMessageIndex } from "../../core/app-database";
import { applySessionMetadataList } from "../session-metadata";
import { getCachedTargets, setCachedTargets } from "../../core/settings";
import {
  findCachedProviderSession,
  listCachedProviderSessions,
  loadProviderSessionCache
} from "../provider-session-cache";
import { getWslExe, readLocalLines, readWslLines, runWslShell, shellQuote } from "../../terminal/wsl-process";
import { decodeWslOutput, isInsidePosixDir } from "../../../shared/wsl-paths";

const execFileAsync = promisify(execFile);
const INTERNAL_WSL_DISTROS = new Set(["docker-desktop", "docker-desktop-data"]);
const QODER_CONFIG_DIR_NAME = ".qoder-cn";
const QODER_LIST_PREVIEW_LIMIT = 8;
const QODER_TRASH_DIR_NAME = ".visual-console-trash";
const QODER_MODEL_LIST_TIMEOUT_MS = 20_000;

type QoderTargetContext = {
  targetId: string;
  kind: "local" | "wsl";
  distro?: string;
  configDir: string;
};

type QoderSessionFile = {
  filePath: string;
  mtimeMs?: number;
  size?: number;
};

type QoderUsageAccumulator = {
  total?: TokenUsage;
  last?: TokenUsage;
  contextPercent?: number;
  updatedAt?: string;
};

type QoderSessionMutationEntry = SessionMutationRef & {
  filePath: string;
  movedTo?: string;
  deleted?: string;
};

export async function listCachedTargets(): Promise<CodexTarget[]> {
  return (await getCachedTargets()).filter((target) => target.provider === "qoder");
}

export async function listTargets(): Promise<CodexTarget[]> {
  return measure("targets.list.qoder", async () => {
    const local = await probeLocalTarget();
    const wslTargets = process.platform === "win32" || process.platform === "linux"
      ? await probeWslTargets()
      : [];
    const targets = [...wslTargets, ...(local ? [local] : [])];
    await setCachedTargets(targets);
    return targets;
  });
}

/** 读取 Qoder CLI 当前账号可用的真实模型，避免把其他平台的供应商模型混入 Qoder。 */
export async function listModels(targetId: string): Promise<Array<{ id: string }>> {
  const context = await resolveTargetContext(targetId);
  const output = context.kind === "wsl"
    ? await runWslShell(context.distro!, "qodercn --list-models", QODER_MODEL_LIST_TIMEOUT_MS)
    : await execFileAsync(process.platform === "win32" ? "qodercn.cmd" : "qodercn", ["--list-models"], {
      encoding: "utf8",
      timeout: QODER_MODEL_LIST_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }).then((result) => result.stdout);
  return parseQoderModelList(output);
}

// qodercn --list-models 以表头加逐行模型名输出，解析时去除 ANSI 控制序列和空行。
export function parseQoderModelList(output: string): Array<{ id: string }> {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim())
    .filter((line) => line && line.toUpperCase() !== "MODEL")
    .map((id) => ({ id }));
}

export async function listCachedSessions(targetId: string, view: SessionView): Promise<CodexSession[]> {
  return (await applySessionMetadataList(targetId, await listCachedProviderSessions<CodexSession>(getCacheKey(targetId, view)))).sort(sortSessions);
}

export async function listSessions(targetId: string): Promise<CodexSession[]> {
  return measure(`sessions.list.${targetId}`, async () => (await loadQoderSessions(targetId)).sort(sortSessions));
}

export async function listTrashSessions(targetId: string): Promise<CodexSession[]> {
  return measure(`sessions.trash.list.${targetId}`, async () => (await loadQoderSessions(targetId, "trash")).sort(sortSessions));
}

export async function searchSessions(targetId: string, view: SessionView, query: string): Promise<CodexSession[]> {
  const normalized = query.trim().toLowerCase();
  const sessions = view === "trash" ? await listTrashSessions(targetId) : await listSessions(targetId);
  if (!normalized) return sessions;
  const context = await resolveTargetContext(targetId);
  const matches: CodexSession[] = [];
  for (const session of sessions) {
    if (matchesSummary(session, normalized) || await sessionContains(context, session.filePath, normalized)) matches.push(session);
  }
  return matches;
}

export async function getSession(targetId: string, sessionId: string, ref?: SessionFileRef): Promise<CodexSession> {
  const context = await resolveTargetContext(targetId);
  if (ref?.filePath) {
    assertSessionPath(context, ref.filePath, getSessionViewForPath(context, ref.filePath));
    await verifySessionId(context, ref.filePath, sessionId);
    const session = await readSession(context, await sessionFileFromPath(context, ref.filePath));
    if (!session || session.id !== sessionId) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
    return (await applySessionMetadataList(targetId, [session]))[0];
  }

  const cached = await findCachedProviderSession<CodexSession>([getCacheKey(targetId, "active"), getCacheKey(targetId, "trash")], sessionId);
  if (cached) {
    try {
      const session = await readSession(context, await sessionFileFromPath(context, cached.filePath));
      if (session?.id === sessionId) return (await applySessionMetadataList(targetId, [session]))[0];
    } catch {
      // 缓存命中但会话刚被 CLI 清理或移动时，回退到重新发现。
    }
  }

  const session = [...(await loadQoderSessions(targetId, "active")), ...(await loadQoderSessions(targetId, "trash"))]
    .find((item) => item.id === sessionId);
  if (!session) throw new Error(`未找到 Qoder 会话：${sessionId}`);
  return session;
}

export async function getSessionSummary(targetId: string, sessionId: string): Promise<CodexSession> {
  const context = await resolveTargetContext(targetId);
  const cached = await findCachedProviderSession<CodexSession>([getCacheKey(targetId, "active"), getCacheKey(targetId, "trash")], sessionId);
  if (cached) {
    try {
      const file = await sessionFileFromPath(context, cached.filePath);
      return (await applySessionMetadataList(targetId, [{ ...cached, ...file }]))[0];
    } catch {
      // 文件已被移入回收站或被 CLI 清理，重新发现后会覆盖旧缓存。
    }
  }
  const session = [...(await loadQoderSessions(targetId, "active")), ...(await loadQoderSessions(targetId, "trash"))]
    .find((item) => item.id === sessionId);
  if (!session) throw new Error(`未找到 Qoder 会话：${sessionId}`);
  return session;
}

export async function getSessionMessagesPage(
  targetId: string,
  sessionId: string,
  offset: number,
  limit: number
): Promise<SessionMessagePage> {
  return measure(`sessions.page.${targetId}`, async () => {
    const context = await resolveTargetContext(targetId);
    const session = await getSessionSummary(targetId, sessionId);
    assertSessionPath(context, session.filePath, getSessionViewForPath(context, session.filePath));
    await verifySessionId(context, session.filePath, sessionId);

    const latest = offset === -1;
    const pageOffset = latest ? 0 : Math.max(0, Math.floor(offset));
    const pageLimit = Math.max(1, Math.floor(limit));
    const messages: CodexMessage[] = [];
    let visibleCount = 0;
    let hasMore = false;
    let previous: CodexMessage | null = null;
    const fileMtimeMs = session.fileMtimeMs || Date.parse(session.updatedAt || "") || 0;
    const fileSize = session.fileSize || 0;
    const anchor = !latest && hasAppDatabase()
      ? await readSessionMessageIndex({ targetId, sessionId, filePath: session.filePath, mtimeMs: fileMtimeMs, size: fileSize }, pageOffset)
      : null;
    const anchors: Array<{ messageOffset: number; lineNumber: number }> = [];
    visibleCount = anchor?.messageOffset || 0;

    const push = (line: string, lineNumber: number) => {
      const message = toQoderMessage(safeJsonParse(line));
      if (!message || isDuplicate(previous, message)) return true;
      previous = message;
      if (!latest && visibleCount >= pageOffset + pageLimit) {
        hasMore = true;
        return false;
      }
      if (visibleCount % 100 === 0) anchors.push({ messageOffset: visibleCount, lineNumber });
      if (latest) {
        messages.push(message);
        if (messages.length > pageLimit) messages.shift();
      } else if (visibleCount >= pageOffset) {
        messages.push(message);
      }
      visibleCount += 1;
      return true;
    };

    const startLine = latest ? 1 : anchor?.lineNumber || 1;
    if (context.kind === "wsl") await readWslLines(context.distro!, session.filePath, push, startLine);
    else await readLocalLines(session.filePath, push, startLine);

    if (hasAppDatabase()) {
      await saveSessionMessageIndex({
        targetId,
        sessionId,
        filePath: session.filePath,
        mtimeMs: fileMtimeMs,
        size: fileSize,
        anchors,
        messageCount: Math.max(session.messageCount, anchor?.messageCount || 0, hasMore ? 0 : visibleCount)
      });
    }

    const actualOffset = latest ? Math.max(0, visibleCount - messages.length) : pageOffset;
    return { offset: actualOffset, messages, hasMore: latest ? actualOffset > 0 : hasMore };
  });
}

export async function listSessionsByParent(): Promise<CodexSession[]> {
  return [];
}

export async function getSessionFolderPath(targetId: string, sessionId: string): Promise<string> {
  const session = await getSessionSummary(targetId, sessionId);
  const context = await resolveTargetContext(targetId);
  return context.kind === "wsl" ? path.posix.dirname(session.filePath) : path.dirname(session.filePath);
}

export async function branchSession(): Promise<CodexSession> {
  return unsupported("从此处分支");
}

export async function duplicateSession(): Promise<CodexSession> {
  return unsupported("复制会话");
}

export async function deleteSession(targetId: string, sessionId: string, ref?: SessionFileRef): Promise<{ movedTo: string }> {
  return measure(`sessions.delete.${targetId}`, async () => {
    const context = await resolveTargetContext(targetId);
    const session = await getQoderSessionForMutation(targetId, context, sessionId, "active", ref);
    const movedTo = await moveQoderSession(context, session.filePath, session.id, "active", "trash");
    return { movedTo };
  });
}

export async function deleteSessions(targetId: string, sessions: SessionMutationRef[]): Promise<SessionBatchMutationResult> {
  return mutateQoderSessionsBatch(targetId, sessions, "active");
}

export async function restoreSession(targetId: string, sessionId: string): Promise<{ restoredTo: string }> {
  return measure(`sessions.restore.${targetId}`, async () => {
    const context = await resolveTargetContext(targetId);
    const session = await getQoderSessionForMutation(targetId, context, sessionId, "trash");
    const restoredTo = await moveQoderSession(context, session.filePath, session.id, "trash", "active");
    return { restoredTo };
  });
}

export async function purgeSession(targetId: string, sessionId: string, ref?: SessionFileRef): Promise<{ deleted: string }> {
  return measure(`sessions.purge.${targetId}`, async () => {
    const context = await resolveTargetContext(targetId);
    const session = await getQoderSessionForMutation(targetId, context, sessionId, "trash", ref);
    await purgeQoderSession(context, session.filePath, session.id);
    return { deleted: session.filePath };
  });
}

export async function purgeSessions(targetId: string, sessions: SessionMutationRef[]): Promise<SessionBatchMutationResult> {
  return mutateQoderSessionsBatch(targetId, sessions, "trash");
}

async function mutateQoderSessionsBatch(
  targetId: string,
  sessions: SessionMutationRef[],
  view: SessionView
): Promise<SessionBatchMutationResult> {
  return measure(`sessions.${view === "trash" ? "purge" : "delete"}.batch.${targetId}`, async () => {
    if (sessions.length === 0) return { processed: [] };
    const context = await resolveTargetContext(targetId);
    const processed: QoderSessionMutationEntry[] = [];
    for (const ref of sessions) {
      const session = await getQoderSessionForMutation(targetId, context, ref.id, view, ref);
      if (view === "trash") {
        await purgeQoderSession(context, session.filePath, session.id);
        processed.push({ ...ref, filePath: session.filePath, deleted: session.filePath });
      } else {
        const movedTo = await moveQoderSession(context, session.filePath, session.id, "active", "trash");
        processed.push({ ...ref, filePath: session.filePath, movedTo });
      }
    }
    return { processed };
  });
}

async function getQoderSessionForMutation(
  targetId: string,
  context: QoderTargetContext,
  sessionId: string,
  view: SessionView,
  ref?: SessionFileRef
): Promise<CodexSession> {
  if (ref?.filePath) {
    assertSessionPath(context, ref.filePath, view);
    await verifySessionId(context, ref.filePath, sessionId);
    const session = await readSession(context, await sessionFileFromPath(context, ref.filePath));
    if (!session || session.id !== sessionId) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
    return session;
  }

  const session = (await loadQoderSessions(targetId, view)).find((item) => item.id === sessionId);
  if (!session) throw new Error(view === "trash" ? `未在 Qoder 回收站找到会话：${sessionId}` : `未找到 Qoder 会话：${sessionId}`);
  return session;
}

async function moveQoderSession(
  context: QoderTargetContext,
  transcriptPath: string,
  sessionId: string,
  fromView: SessionView,
  toView: SessionView
): Promise<string> {
  const paths = buildQoderSessionStoragePaths(context, transcriptPath, sessionId, fromView, toView);
  await assertQoderMoveTargetsAvailable(context, paths);
  if (context.kind === "wsl") await moveQoderSessionInWsl(context, paths);
  else await moveQoderSessionLocally(paths);
  return paths.find((item) => item.primary)!.destination;
}

async function purgeQoderSession(context: QoderTargetContext, transcriptPath: string, sessionId: string) {
  const paths = buildQoderSessionStoragePaths(context, transcriptPath, sessionId, "trash");
  if (context.kind === "wsl") {
    const script = paths
      .map((item) => `if [ -e ${shellQuote(item.source)} ]; then rm -rf -- ${shellQuote(item.source)}; fi`)
      .join("\n");
    await runWslShell(context.distro!, script);
    return;
  }
  await Promise.all(paths.map((item) => fs.rm(item.source, { recursive: true, force: true })));
}

export type QoderStoragePath = {
  source: string;
  destination: string;
  primary?: boolean;
};

export function buildQoderSessionStoragePaths(
  context: { kind: "local" | "wsl"; configDir: string },
  transcriptPath: string,
  sessionId: string,
  fromView: SessionView,
  toView?: SessionView
): QoderStoragePath[] {
  const sourceProjectsRoot = getQoderProjectsRoot(context, fromView);
  const pathApi = context.kind === "wsl" ? path.posix : path;
  const relative = pathApi.relative(sourceProjectsRoot, transcriptPath);
  const parts = relative.split(pathApi.sep);
  if (
    !relative || relative.startsWith("..") || pathApi.isAbsolute(relative) || parts.length !== 2 ||
    !parts[0] || !parts[1]?.endsWith(".jsonl") || !isSinglePathSegment(sessionId, pathApi)
  ) {
    throw new Error("拒绝操作 Qoder projects 目录之外的会话文件。");
  }

  const targetView = toView || fromView;
  const sourceBase = getQoderStorageRoot(context, fromView);
  const destinationBase = getQoderStorageRoot(context, targetView);
  const projectKey = parts[0];
  const transcriptRelative = pathApi.join("projects", projectKey, parts[1]);
  const related = [
    pathApi.join("projects", projectKey, sessionId),
    pathApi.join("tasks", sessionId),
    pathApi.join("file-history", sessionId),
    pathApi.join("logs", "sessions", projectKey, sessionId)
  ];
  return [
    ...related.map((relativePath) => ({
      source: pathApi.join(sourceBase, relativePath),
      destination: pathApi.join(destinationBase, relativePath)
    })),
    {
      source: pathApi.join(sourceBase, transcriptRelative),
      destination: pathApi.join(destinationBase, transcriptRelative),
      primary: true
    }
  ];
}

async function assertQoderMoveTargetsAvailable(context: QoderTargetContext, paths: QoderStoragePath[]) {
  for (const item of paths) {
    const sourceExists = context.kind === "wsl"
      ? await wslPathExists(context.distro!, item.source).catch(() => false)
      : await pathExists(item.source);
    if (!sourceExists) continue;
    const destinationExists = context.kind === "wsl"
      ? await wslPathExists(context.distro!, item.destination).catch(() => false)
      : await pathExists(item.destination);
    if (destinationExists) throw new Error("目标会话已存在，已拒绝覆盖。");
  }
}

async function moveQoderSessionLocally(paths: QoderStoragePath[]) {
  const moved: QoderStoragePath[] = [];
  try {
    for (const item of paths) {
      if (!await pathExists(item.source)) continue;
      await fs.mkdir(path.dirname(item.destination), { recursive: true });
      await fs.rename(item.source, item.destination);
      moved.push(item);
    }
  } catch (error) {
    for (const item of moved.reverse()) {
      if (await pathExists(item.destination)) await fs.rename(item.destination, item.source).catch(() => undefined);
    }
    throw error;
  }
}

async function moveQoderSessionInWsl(context: QoderTargetContext, paths: QoderStoragePath[]) {
  const script = [
    "set -e",
    "moved_sources=()",
    "moved_destinations=()",
    "rollback() {",
    "  for ((i=${#moved_sources[@]}-1; i>=0; i--)); do",
    "    if [ -e \"${moved_destinations[i]}\" ]; then mv -- \"${moved_destinations[i]}\" \"${moved_sources[i]}\" || true; fi",
    "  done",
    "}",
    "trap rollback ERR",
    "move_if_present() {",
    "  local source=$1 destination=$2",
    "  if [ -e \"$source\" ]; then",
    "    mkdir -p \"$(dirname \"$destination\")\"",
    "    mv -- \"$source\" \"$destination\"",
    "    moved_sources+=(\"$source\")",
    "    moved_destinations+=(\"$destination\")",
    "  fi",
    "}",
    ...paths.map((item) => `move_if_present ${shellQuote(item.source)} ${shellQuote(item.destination)}`),
    "trap - ERR"
  ].join("\n");
  await runWslShell(context.distro!, script);
}

async function loadQoderSessions(targetId: string, view: SessionView = "active"): Promise<CodexSession[]> {
  const context = await resolveTargetContext(targetId);
  const files = context.kind === "wsl" ? await listWslSessionFiles(context, view) : await listLocalSessionFiles(context, view);
  const sessions = await loadProviderSessionCache(getCacheKey(targetId, view), files, (file) =>
    readSession(context, file, { maxMessages: QODER_LIST_PREVIEW_LIMIT })
  );
  return applySessionMetadataList(targetId, sessions);
}

function getCacheKey(targetId: string, view: SessionView) {
  return `sessions:qoder:${targetId}:${view}:v1`;
}

async function resolveTargetContext(targetId: string): Promise<QoderTargetContext> {
  if (targetId === "qoder:local") {
    return {
      targetId,
      kind: "local",
      configDir: localConfigDir()
    };
  }
  if (targetId.startsWith("qoder:wsl:")) {
    const distro = targetId.slice("qoder:wsl:".length);
    if (!distro) throw new Error("缺少 Qoder WSL 发行版。" );
    return {
      targetId,
      kind: "wsl",
      distro,
      configDir: await wslConfigDir(distro)
    };
  }
  throw new Error(`未知 Qoder 目标：${targetId}`);
}

function localConfigDir() {
  return process.env.QODERCN_CONFIG_DIR?.trim() || path.join(os.homedir(), QODER_CONFIG_DIR_NAME);
}

async function listLocalSessionFiles(context: QoderTargetContext, view: SessionView): Promise<QoderSessionFile[]> {
  const projectsRoot = getQoderProjectsRoot(context, view);
  const projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  const files: QoderSessionFile[] = [];
  for (const project of projectDirs) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(projectsRoot, project.name);
    const entries = await fs.readdir(projectPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(projectPath, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat) files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  return files;
}

async function listWslSessionFiles(context: QoderTargetContext, view: SessionView): Promise<QoderSessionFile[]> {
  const root = getQoderProjectsRoot(context, view);
  const output = await runWslShell(
    context.distro!,
    `find ${shellQuote(root)} -type f -name '*.jsonl' -printf '%p\\t%T@\\t%s\\n' 2>/dev/null || true`
  );
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const [filePath, mtime, size] = line.split("\t");
    if (!filePath) return [];
    return [{
      filePath,
      mtimeMs: Number.parseFloat(mtime) * 1000 || 0,
      size: Number.parseInt(size, 10) || 0
    }];
  });
}

async function sessionFileFromPath(context: QoderTargetContext, filePath: string): Promise<QoderSessionFile> {
  if (context.kind === "wsl") {
    const output = await runWslShell(context.distro!, `stat -c '%Y\\t%s' -- ${shellQuote(filePath)}`);
    const [mtime, size] = output.trim().split("\t");
    return {
      filePath,
      mtimeMs: Number.parseInt(mtime, 10) * 1000 || 0,
      size: Number.parseInt(size, 10) || 0
    };
  }
  const stat = await fs.stat(filePath);
  return { filePath, mtimeMs: stat.mtimeMs, size: stat.size };
}

async function readSession(
  context: QoderTargetContext,
  file: QoderSessionFile,
  options: { maxMessages?: number } = {}
): Promise<CodexSession | null> {
  const parser = createQoderSessionParser(file, options);
  if (context.kind === "wsl") await readWslLines(context.distro!, file.filePath, parser.push);
  else await readLocalLines(file.filePath, parser.push);
  return parser.finish();
}

export function createQoderSessionParser(file: QoderSessionFile, options: { maxMessages?: number } = {}) {
  let id = "";
  let title = "";
  let cwd = "";
  let model = "";
  let createdAt = "";
  let updatedAt = "";
  let messageCount = 0;
  let firstUserText = "";
  let previous: CodexMessage | null = null;
  const messages: CodexMessage[] = [];
  const usage: QoderUsageAccumulator = {};

  function push(line: string) {
    const record = safeJsonParse(line);
    if (!record) return;
    id ||= stringField(record.sessionId);
    if (record.type === "ai-title") title = stringField(record.aiTitle) || title;
    if (record.type === "runtime-config") model = stringField(record.model) || model;
    cwd ||= stringField(record.cwd) || firstString(record.directories);

    const message = toQoderMessage(record);
    if (!message || isDuplicate(previous, message)) return;
    previous = message;
    createdAt ||= message.timestamp || "";
    updatedAt = message.timestamp || updatedAt;
    if (message.role === "user") firstUserText ||= message.text;
    messageCount += 1;
    if (options.maxMessages === undefined || messages.length < options.maxMessages) messages.push(message);
    collectUsage(usage, record);
  }

  function finish(): CodexSession | null {
    if (!id || messageCount === 0) return null;
    const timestamp = file.mtimeMs ? new Date(file.mtimeMs).toISOString() : undefined;
    return {
      id,
      title: clampText(title || firstUserText || id, 88),
      cwd: cwd || undefined,
      createdAt: createdAt || timestamp,
      updatedAt: updatedAt || timestamp,
      model: model || undefined,
      modelStatus: { model: model || undefined, modelProvider: "Qoder" },
      filePath: file.filePath,
      fileMtimeMs: file.mtimeMs,
      fileSize: file.size,
      messageCount,
      preview: messages,
      usage: buildUsage(usage)
    };
  }

  return { push, finish };
}

function toQoderMessage(value: Record<string, unknown> | null): CodexMessage | null {
  if (!value) return null;
  if (value.isMeta === true || value.isSidechain === true) return null;
  const type = stringField(value.type);
  const message = objectField(value.message);
  const timestamp = stringField(value.timestamp) || undefined;
  if (type === "user") {
    const text = stringField(message.content).trim();
    return text ? { role: "user", text, timestamp } : null;
  }
  if (type === "assistant") {
    const text = extractAssistantText(message.content);
    return text ? { role: "assistant", text, timestamp } : null;
  }
  return null;
}

function extractAssistantText(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const record = objectField(part);
      return stringField(record.text);
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function collectUsage(accumulator: QoderUsageAccumulator, record: Record<string, unknown>) {
  if (record.type !== "assistant") return;
  const raw = objectField(objectField(record.message).usage);
  const next: TokenUsage = {
    inputTokens: numberField(raw.input_tokens),
    cachedInputTokens: numberField(raw.cache_read_input_tokens),
    outputTokens: numberField(raw.output_tokens)
  };
  const total = [next.inputTokens, next.cachedInputTokens, next.outputTokens]
    .reduce<number>((sum, value) => sum + (value || 0), 0);
  if (total) next.totalTokens = total;
  if (Object.values(next).some((value) => typeof value === "number")) {
    accumulator.last = next;
    accumulator.total = addUsage(accumulator.total, next);
  }
  const contextRatio = numberField(raw.context_usage_ratio);
  if (typeof contextRatio === "number") accumulator.contextPercent = Math.min(100, Math.max(0, contextRatio <= 1 ? contextRatio * 100 : contextRatio));
  accumulator.updatedAt = stringField(record.timestamp) || accumulator.updatedAt;
}

function buildUsage(accumulator: QoderUsageAccumulator): SessionUsage | undefined {
  if (!accumulator.total && !accumulator.last && typeof accumulator.contextPercent !== "number") return undefined;
  const contextPercent = typeof accumulator.contextPercent === "number"
    ? Math.round(accumulator.contextPercent * 10) / 10
    : undefined;
  return {
    total: accumulator.total,
    last: accumulator.last,
    contextPercent,
    contextLeftPercent: typeof contextPercent === "number" ? Math.max(0, Math.round((100 - contextPercent) * 10) / 10) : undefined,
    updatedAt: accumulator.updatedAt,
    source: "qoder-message-usage"
  };
}

function addUsage(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  return {
    inputTokens: addOptional(current?.inputTokens, next.inputTokens),
    cachedInputTokens: addOptional(current?.cachedInputTokens, next.cachedInputTokens),
    outputTokens: addOptional(current?.outputTokens, next.outputTokens),
    totalTokens: addOptional(current?.totalTokens, next.totalTokens)
  };
}

function addOptional(current?: number, next?: number) {
  return typeof current === "number" || typeof next === "number" ? (current || 0) + (next || 0) : undefined;
}

function matchesSummary(session: CodexSession, query: string) {
  return [session.id, session.title, session.cwd || "", session.model || "", ...session.preview.map((message) => message.text)]
    .join("\n")
    .toLowerCase()
    .includes(query);
}

async function sessionContains(context: QoderTargetContext, filePath: string, query: string) {
  let found = false;
  const inspect = (line: string) => {
    const message = toQoderMessage(safeJsonParse(line));
    found = Boolean(message?.text.toLowerCase().includes(query));
    return !found;
  };
  if (context.kind === "wsl") await readWslLines(context.distro!, filePath, inspect);
  else await readLocalLines(filePath, inspect);
  return found;
}

function assertSessionPath(context: QoderTargetContext, filePath: string, view: SessionView) {
  const root = getQoderProjectsRoot(context, view);
  if (context.kind === "wsl" ? isInsidePosixDir(filePath, root) : isInsideLocal(filePath, root)) return;
  throw new Error("拒绝操作 Qoder 会话目录之外的文件。");
}

function getSessionViewForPath(context: QoderTargetContext, filePath: string): SessionView {
  if (context.kind === "wsl") {
    if (isInsidePosixDir(filePath, getQoderProjectsRoot(context, "active"))) return "active";
    if (isInsidePosixDir(filePath, getQoderProjectsRoot(context, "trash"))) return "trash";
  } else {
    if (isInsideLocal(filePath, getQoderProjectsRoot(context, "active"))) return "active";
    if (isInsideLocal(filePath, getQoderProjectsRoot(context, "trash"))) return "trash";
  }
  throw new Error("拒绝操作 Qoder 会话目录之外的文件。");
}

function getQoderStorageRoot(context: Pick<QoderTargetContext, "kind" | "configDir">, view: SessionView) {
  if (view === "active") return context.configDir;
  return context.kind === "wsl"
    ? path.posix.join(context.configDir, QODER_TRASH_DIR_NAME)
    : path.join(context.configDir, QODER_TRASH_DIR_NAME);
}

function getQoderProjectsRoot(context: Pick<QoderTargetContext, "kind" | "configDir">, view: SessionView) {
  const base = getQoderStorageRoot(context, view);
  return context.kind === "wsl" ? path.posix.join(base, "projects") : path.join(base, "projects");
}

function isSinglePathSegment(value: string, pathApi: typeof path | typeof path.posix) {
  return Boolean(value) && value !== "." && value !== ".." && pathApi.basename(value) === value;
}

async function verifySessionId(context: QoderTargetContext, filePath: string, sessionId: string) {
  let found = false;
  const inspect = (line: string) => {
    const candidate = stringField(safeJsonParse(line)?.sessionId);
    if (!candidate) return true;
    found = true;
    if (candidate !== sessionId) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
    return false;
  };
  if (context.kind === "wsl") await readWslLines(context.distro!, filePath, inspect);
  else await readLocalLines(filePath, inspect);
  if (!found) throw new Error(`会话文件与会话编号不匹配：${sessionId}`);
}

async function probeLocalTarget(): Promise<CodexTarget | null> {
  const command = process.platform === "win32" ? "qodercn.cmd" : "qodercn";
  const configDir = localConfigDir();
  const [found, hasConfigDir] = await Promise.all([commandExists(command), pathExists(configDir)]);
  if (!found && !hasConfigDir) return null;
  return {
    id: "qoder:local",
    provider: "qoder",
    label: `Qoder：本机（${os.platform()}）`,
    kind: "local",
    codexHome: hasConfigDir ? configDir : undefined,
    available: found,
    detail: found
      ? hasConfigDir ? "找到 Qoder 命令和配置目录" : "找到 Qoder 命令"
      : "找到 Qoder 配置目录，未找到 qodercn 命令"
  };
}

async function probeWslTargets(): Promise<CodexTarget[]> {
  const distros = await listWslDistros();
  return (await Promise.all(distros.map(async (distro): Promise<CodexTarget | null> => {
    const configDir = await wslConfigDir(distro).catch(() => "");
    const [found, hasConfigDir] = await Promise.all([
      wslCommandExists(distro, "qodercn").catch(() => false),
      configDir ? wslPathExists(distro, configDir).catch(() => false) : false
    ]);
    if (!found && !hasConfigDir) return null;
    return {
      id: `qoder:wsl:${distro}`,
      provider: "qoder",
      label: `Qoder：WSL：${distro}`,
      kind: "wsl",
      distro,
      codexHome: hasConfigDir ? configDir : undefined,
      available: found,
      detail: found
        ? hasConfigDir ? "找到 Qoder 命令和配置目录" : "找到 Qoder 命令"
        : "找到 Qoder 配置目录，未找到 qodercn 命令"
    };
  }))).filter((target): target is CodexTarget => Boolean(target));
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

async function wslConfigDir(distro: string) {
  return (await runWslShell(distro, 'printf %s "${QODERCN_CONFIG_DIR:-$HOME/.qoder-cn}"')).trim();
}

async function wslCommandExists(distro: string, command: string) {
  await runWslShell(distro, `command -v ${shellQuote(command)} >/dev/null 2>&1`);
  return true;
}

async function wslPathExists(distro: string, filePath: string) {
  await runWslShell(distro, `test -e ${shellQuote(filePath)}`);
  return true;
}

async function commandExists(command: string) {
  try {
    await execFileAsync(command, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
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

function safeJsonParse(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(value: unknown) {
  return Array.isArray(value) ? value.find((item): item is string => typeof item === "string") || "" : "";
}

function isDuplicate(previous: CodexMessage | null, message: CodexMessage) {
  return previous?.role === message.role && previous.text === message.text;
}

function clampText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function sortSessions(a: CodexSession, b: CodexSession) {
  return new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime();
}

function isInsideLocal(filePath: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function unsupported(action: string): never {
  throw new Error(`Qoder CLI 当前不支持在本应用中${action}，请在 Qoder CLI 内执行。`);
}
