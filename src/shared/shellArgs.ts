import path from "node:path";

// 纯函数集合：shell/cmd 参数转义、CLI 参数解析、配置路径白名单校验。
// 不依赖 electron / node-pty，便于单元测试，并避免在多个主进程模块里重复实现。

/** POSIX 单引号转义：把值安全地包进一对单引号，内部单引号用 '\'' 收尾再续。 */
export function posixShellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Windows cmd.exe 转义：双引号包裹并转义元字符。 */
export function cmdQuote(value: string) {
  return `"${value.replace(/(["^&|<>%])/g, "^$1")}"`;
}

/** 把命令与参数拼成一条 POSIX shell 命令行，每个参数单独转义。 */
export function buildPosixShellCommand(command: string, args: string[]) {
  return [command, ...args.map(posixShellQuote)].join(" ");
}

/** 把命令与参数拼成一条 cmd.exe 命令行，每个参数单独转义。 */
export function buildCmdCommand(command: string, args: string[]) {
  return [command, ...args.map(cmdQuote)].join(" ");
}

/**
 * 解析用户填写的 CLI 参数模板字符串为参数数组。
 * 支持单/双引号与反斜杠转义；遇到未闭合引号抛错。
 */
export function parseCliArgs(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const args: string[] = [];
  let current = "";
  let quote: "\"" | "'" | "" = "";
  let escaping = false;

  for (const char of trimmed) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((char === "\"" || char === "'") && (!quote || quote === char)) {
      quote = quote ? "" : char;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error("CLI 参数模板存在未闭合引号。");
  if (current) args.push(current);
  return args;
}

const ALLOWED_CONFIG_PREFIXES = ["~/", "$HOME/"] as const;
const ALLOWED_CONFIG_DIRS = [".codex/", ".gemini/", ".claude/"] as const;

/**
 * 校验供应商配置文件路径是否落在 `~/.codex`、`~/.gemini`、`~/.claude` 之内。
 * 先规范化 home 之后的相对部分，挫败 `~/.codex/../../etc/passwd` 这类 `..` 穿越；
 * 反斜杠统一为正斜杠，避免 WSL 端 bash 展开时绕过 posix 规范化。
 */
export function assertAllowedConfigPath(filePath: string) {
  const normalized = filePath.trim();
  const prefix = ALLOWED_CONFIG_PREFIXES.find((item) => normalized.startsWith(item));
  if (!prefix) throw new Error(`配置文件路径不在允许范围：${filePath}`);

  const rest = path.posix.normalize(normalized.slice(prefix.length).replace(/\\/g, "/"));
  const escapes = rest === ".." || rest.startsWith("../") || path.posix.isAbsolute(rest);
  if (escapes || !ALLOWED_CONFIG_DIRS.some((dir) => rest.startsWith(dir))) {
    throw new Error(`配置文件路径不在允许范围：${filePath}`);
  }
}
