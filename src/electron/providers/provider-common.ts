import os from "node:os";
import { commandExists, listWslDistros, wslCommandExists, wslPathExists } from "../core/wsl";
import { readLocalLines, readWslLines } from "../core/line-reader";
import { pathExists } from "../core/fs-utils";
import { measure } from "../core/performance";
import { setCachedTargets } from "../core/settings";
import { buildWslProviderTargetId } from "../../shared/target-ids";
import type { AiProviderId, AiTarget, CodexSession } from "../types";

// gemini/claude/qoder provider 的 1:1 公共骨架：目标探测、会话搜索与排序。
// 各 provider 仅保留差异点（命令名、配置目录解析、会话文件格式），公共控制流收敛于此。

export type CliTargetContextLike = { kind: "local" | "wsl"; distro?: string };

export type LocalCliTargetProbe = {
  provider: AiProviderId;
  displayName: string;
  windowsCommand: string;
  unixCommand: string;
  configDir: string;
};

// 探测本机 CLI 目标：命令与配置目录任一存在即认为目标可用，两者皆无则不展示。
export async function probeLocalCliTarget(probe: LocalCliTargetProbe): Promise<AiTarget | null> {
  const command = process.platform === "win32" ? probe.windowsCommand : probe.unixCommand;
  const found = await commandExists(command);
  const hasConfigDir = await pathExists(probe.configDir);
  if (!found && !hasConfigDir) return null;

  return {
    id: `${probe.provider}:local`,
    provider: probe.provider,
    label: `${probe.displayName}：本机（${os.platform()}）`,
    kind: "local",
    codexHome: hasConfigDir ? probe.configDir : undefined,
    available: found,
    detail: found
      ? hasConfigDir ? `找到 ${probe.displayName} 命令和配置目录` : `找到 ${probe.displayName} 命令`
      : `找到 ${probe.displayName} 配置目录，未找到 ${probe.unixCommand} 命令`
  };
}

export type WslCliTargetProbe = {
  provider: AiProviderId;
  displayName: string;
  command: string;
  resolveConfigDir: (distro: string) => Promise<string>;
};

// 探测各 WSL 发行版内的 CLI 目标；配置目录解析由 provider 提供（HOME 拼接或环境变量覆盖）。
export async function probeWslCliTargets(probe: WslCliTargetProbe): Promise<AiTarget[]> {
  const distros = await listWslDistros();
  const targets = await Promise.all(
    distros.map(async (distro): Promise<AiTarget | null> => {
      const [commandFound, configDir] = await Promise.all([
        wslCommandExists(distro, probe.command).catch(() => false),
        probe.resolveConfigDir(distro).catch(() => "")
      ]);
      const hasConfigDir = configDir ? await wslPathExists(distro, configDir).catch(() => false) : false;
      if (!commandFound && !hasConfigDir) return null;

      return {
        id: buildWslProviderTargetId(probe.provider, distro),
        provider: probe.provider,
        label: `${probe.displayName}：WSL：${distro}`,
        kind: "wsl",
        distro,
        codexHome: hasConfigDir ? configDir : undefined,
        available: commandFound,
        detail: commandFound
          ? hasConfigDir ? `找到 ${probe.displayName} 命令和配置目录` : `找到 ${probe.displayName} 命令`
          : `找到 ${probe.displayName} 配置目录，未找到 ${probe.command} 命令`
      };
    })
  );
  return targets.filter((target): target is AiTarget => target !== null);
}

// listTargets 公共骨架：本机 + WSL 探测合并、写入目标缓存，带性能打点。
export async function listCliTargets(
  provider: AiProviderId,
  probeLocal: () => Promise<AiTarget | null>,
  probeWsl: () => Promise<AiTarget[]>
): Promise<AiTarget[]> {
  return measure(`targets.list.${provider}`, async () => {
    const local = await probeLocal();
    const wslTargets = process.platform === "win32" || process.platform === "linux" ? await probeWsl() : [];
    const targets = [...wslTargets, ...(local ? [local] : [])];
    await setCachedTargets(targets);
    return targets;
  });
}

// 会话列表通用排序：updatedAt 优先，缺失时回退 createdAt。
export function sortSessionsByRecency(left: Pick<CodexSession, "updatedAt" | "createdAt">, right: Pick<CodexSession, "updatedAt" | "createdAt">) {
  return new Date(right.updatedAt || right.createdAt || 0).getTime() - new Date(left.updatedAt || left.createdAt || 0).getTime();
}

// 摘要级搜索匹配：编号、标题、来源标题、cwd、模型与预览消息全文。
export function matchesSessionSummary(
  session: Pick<CodexSession, "id" | "title" | "sourceTitle" | "cwd" | "model" | "preview">,
  normalizedQuery: string
) {
  return [session.id, session.title, session.sourceTitle || "", session.cwd || "", session.model || "", ...session.preview.map((message) => message.text)]
    .join("\n")
    .toLowerCase()
    .includes(normalizedQuery);
}

// 逐行扫描会话文件内容；extractLineText 为空时匹配原始行（gemini/claude），
// 提供时只匹配解析出的消息文本（qoder，避免命中 JSON 结构键名）。
export async function sessionFileContains(
  context: CliTargetContextLike,
  filePath: string,
  normalizedQuery: string,
  extractLineText?: (line: string) => string | null
) {
  let found = false;
  const inspect = (line: string) => {
    const text = extractLineText ? extractLineText(line) : line;
    if (text !== null) found ||= text.toLowerCase().includes(normalizedQuery);
    return !found;
  };
  if (context.kind === "wsl") await readWslLines(context.distro!, filePath, inspect);
  else await readLocalLines(filePath, inspect);
  return found;
}

// searchSessions 公共骨架：空查询原样返回；否则摘要匹配 + 文件内容扫描。
// 文件扫描按有限并发执行（WSL 目标每次扫描都拉起一个 wsl.exe 子进程，需要限制瞬时并发）。
const SESSION_SEARCH_CONCURRENCY = 8;

export async function searchSessionsByContent<TSession extends Pick<CodexSession, "id" | "title" | "sourceTitle" | "cwd" | "model" | "preview"> & { filePath: string }>(options: {
  sessions: TSession[];
  query: string;
  resolveContext: () => Promise<CliTargetContextLike>;
  extractLineText?: (line: string) => string | null;
}): Promise<TSession[]> {
  const normalized = options.query.trim().toLowerCase();
  if (!normalized) return options.sessions;

  const context = await options.resolveContext();
  const matched = await mapWithConcurrency(options.sessions, SESSION_SEARCH_CONCURRENCY, async (session) =>
    matchesSessionSummary(session, normalized) || await sessionFileContains(context, session.filePath, normalized, options.extractLineText)
  );
  return options.sessions.filter((_, index) => matched[index]);
}

// 有限并发 map：固定数量的 worker 依次领取任务，结果按下标写入，保持输入顺序。
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runWorker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return results;
}
