import { execFile, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { decodeWslOutput, shellQuote } from "../../shared/wsl-paths";
import { pathExists } from "./fs-utils";

// wsl.exe 执行层的唯一入口：此前 codex/claude/gemini/qoder/skills 各自维护一份
// 探测、执行、读写实现，行为随副本漂移（超时缺失、缓冲上限不一），统一收敛于此。

const execFileAsync = promisify(execFile);

// 所有 WSL 子进程调用的兜底超时：WSL 内核或挂载点挂起时，避免主进程被无限期阻塞。
export const WSL_COMMAND_TIMEOUT_MS = 60_000;
// shell 命令主要返回 find/stat 等探测文本；设置上限防止异常脚本把主进程内存无限撑大。
export const WSL_SHELL_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// 仅用于必须一次性读取的小型配置/复制源文件；会话详情应优先使用 readWslLines。
export const WSL_READ_FILE_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const WSL_ERROR_MAX_OUTPUT_BYTES = 1024 * 1024;

// Docker Desktop 注册到 WSL 的内部发行版，不是用户可用的 CLI 目标。
export const INTERNAL_WSL_DISTROS = new Set(["docker-desktop", "docker-desktop-data"]);

// 给 spawn 出的子进程挂看门狗：超时则 SIGKILL 并 reject；返回的清理函数在正常结束时取消计时器。
// execFile 自带 timeout 选项，无需此辅助；spawn 不带，故统一在此处理。
export function attachSpawnTimeout(
  child: ChildProcess,
  reject: (error: Error) => void,
  label: string,
  timeoutMs: number = WSL_COMMAND_TIMEOUT_MS
) {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error(`WSL 操作超时（${timeoutMs} ms）：${label}`));
  }, timeoutMs);
  return () => clearTimeout(timer);
}

export async function getWslExe() {
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

// 宿主机命令查找：带路径分隔符时按文件存在性判断，裸命令走 where/which。
export async function commandExists(command: string) {
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

export async function listWslDistros() {
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

// 在指定发行版内执行单条命令（find/stat/rm 等简单命令行）。
export async function wslRun(distro: string, command: string, args: string[] = [], maxBuffer = 1024 * 1024 * 16) {
  const wslExe = await getWslExe();
  if (!wslExe) throw new Error("未找到 wsl.exe。");

  return execFileAsync(wslExe, ["-d", distro, "--", command, ...args], {
    encoding: "utf8",
    maxBuffer,
    timeout: WSL_COMMAND_TIMEOUT_MS
  });
}

// 在指定 WSL 发行版内执行 bash 脚本，返回 stdout。
// 脚本经 base64 透传：绕开 wsl.exe 转发参数时对引号/反斜杠的再解析，
// 含双引号与 $(...) 的脚本（如供应商配置写入）必须走这条路。
export async function runWslShell(
  distro: string,
  script: string,
  timeoutMs: number = WSL_COMMAND_TIMEOUT_MS,
  maxOutputBytes: number = WSL_SHELL_MAX_OUTPUT_BYTES
) {
  const wslExe = await getWslExe();
  if (!wslExe) throw new Error("未找到 wsl.exe。");
  const encodedScript = Buffer.from(script, "utf8").toString("base64");
  const shellScript = `printf %s ${shellQuote(encodedScript)} | base64 -d | bash`;
  return new Promise<string>((resolve, reject) => {
    const child = spawn(wslExe, ["-d", distro, "--", "bash", "-lc", shellScript], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        fail(new Error(`WSL 命令输出超过限制（${maxOutputBytes} bytes）：${distro}`));
        return;
      }
      target.push(chunk);
    };
    const clearTimer = attachSpawnTimeout(child, fail, `WSL 执行（${distro}）`, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => { clearTimer(); fail(error); });
    child.on("close", (code) => {
      clearTimer();
      if (settled) return;
      if (code === 0) {
        settled = true;
        resolve(Buffer.concat(stdout).toString("utf8"));
      } else {
        settled = true;
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `WSL 执行失败，退出码 ${code}`));
      }
    });
    child.stdin.end();
  });
}

// 向 WSL 内写入文件：cat > file 以 stdin 承载内容，避免内容经过任何一层 shell。
export async function wslWriteFile(distro: string, filePath: string, content: string) {
  const wslExe = await getWslExe();
  if (!wslExe) throw new Error("未找到 wsl.exe。");

  const script = `mkdir -p ${shellQuote(path.posix.dirname(filePath))} && cat > ${shellQuote(filePath)}`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(wslExe, ["-d", distro, "--", "bash", "-lc", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    const clearTimer = attachSpawnTimeout(child, reject, `写入 ${filePath}`);

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= WSL_ERROR_MAX_OUTPUT_BYTES) stderr.push(chunk);
    });
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

      const message = Buffer.concat(stderr).toString("utf8").trim() || `写入 WSL 文件失败：${code}`;
      reject(new Error(message));
    });

    child.stdin.end(content, "utf8");
  });
}

// 读取 WSL 内的整个文件。spawn 流式收集，不受 execFile 的 maxBuffer 约束。
export async function wslReadFile(distro: string, filePath: string) {
  const wslExe = await getWslExe();
  if (!wslExe) throw new Error("未找到 wsl.exe。");

  return new Promise<string>((resolve, reject) => {
    const child = spawn(wslExe, ["-d", distro, "--", "cat", filePath], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };
    const clearTimer = attachSpawnTimeout(child, fail, `读取 ${filePath}`);

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > WSL_READ_FILE_MAX_OUTPUT_BYTES) {
        fail(new Error(`WSL 文件超过读取限制（${WSL_READ_FILE_MAX_OUTPUT_BYTES} bytes）：${filePath}`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= WSL_ERROR_MAX_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimer();
      fail(error);
    });
    child.on("close", (code) => {
      clearTimer();
      if (settled) return;
      if (code === 0) {
        settled = true;
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }

      const message = Buffer.concat(stderr).toString("utf8").trim() || `cat 退出码：${code}`;
      settled = true;
      reject(new Error(message));
    });
  });
}

export async function wslPathExists(distro: string, filePath: string) {
  if (!filePath) return false;
  try {
    await wslRun(distro, "test", ["-e", filePath]);
    return true;
  } catch {
    return false;
  }
}

// 用登录 shell 判断命令存在性：nvm/fnm 等按 profile 注入 PATH 的安装只能被 bash -lc 看到。
export async function wslCommandExists(distro: string, command: string) {
  try {
    await wslRun(distro, "bash", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`]);
    return true;
  } catch {
    return false;
  }
}

// 读取 WSL 内的环境变量；读取失败视为目标环境异常，向上抛错而非静默返回空串。
export async function wslGetEnv(distro: string, name: string) {
  const { stdout } = await wslRun(distro, "printenv", [name]);
  return stdout.trim();
}

// 执行命令并取修剪后的 stdout；失败返回空串（探测性调用，如 whoami）。
export async function wslGetText(distro: string, command: string, args: string[] = []) {
  try {
    const { stdout } = await wslRun(distro, command, args);
    return stdout.trim();
  } catch {
    return "";
  }
}

// 在 WSL 内探测可达宿主网关的网络地址。
// 顺序：mirrored/localhost 转发直连 127.0.0.1 → 默认路由网关 → resolv.conf nameserver → 退回 127.0.0.1。
// 用于 WSL2 NAT 模式下让 CLI 进程访问宿主上的本地 Gateway。
const WSL_GATEWAY_DETECT_TIMEOUT_MS = 5_000;

export async function detectWslGatewayHost(distro: string, port: number): Promise<string> {
  const script = [
    "set -e",
    `port=${port}`,
    // 1. mirrored 模式或 localhost 转发：127.0.0.1 直连
    "if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then exec 3>&- 3<&-; echo 127.0.0.1; exit 0; fi",
    // 2. NAT 模式：默认路由网关通常即宿主
    "host=$(ip route show default 2>/dev/null | awk '{print $3; exit}')",
    'if [ -n "$host" ]; then echo "$host"; exit 0; fi',
    // 3. 退路：resolv.conf nameserver
    "awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null || echo 127.0.0.1"
  ].join("\n");
  const result = await runWslShell(distro, script, WSL_GATEWAY_DETECT_TIMEOUT_MS);
  const host = result.trim().split("\n").pop()?.trim() || "127.0.0.1";
  return host || "127.0.0.1";
}
