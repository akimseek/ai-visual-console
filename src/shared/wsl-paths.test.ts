import { describe, expect, it } from "vitest";
import {
  decodeWslOutput,
  getWslDistroFromTargetId,
  isInsidePath,
  isInsidePosixDir,
  parseWslSessionFileList,
  sanitizeWslDistro,
  wslMountPathToWindowsPath
} from "./wsl-paths";

describe("getWslDistroFromTargetId", () => {
  it("解析裸 wsl: 前缀", () => {
    expect(getWslDistroFromTargetId("wsl:Ubuntu-22.04")).toBe("Ubuntu-22.04");
  });

  it("解析 gemini:/claude: 复合前缀", () => {
    expect(getWslDistroFromTargetId("gemini:wsl:Debian")).toBe("Debian");
    expect(getWslDistroFromTargetId("claude:wsl:Arch")).toBe("Arch");
    expect(getWslDistroFromTargetId("qoder:wsl:Fedora")).toBe("Fedora");
  });

  it("非 WSL 目标返回空串", () => {
    expect(getWslDistroFromTargetId("local")).toBe("");
    expect(getWslDistroFromTargetId("gemini:local")).toBe("");
    expect(getWslDistroFromTargetId("")).toBe("");
  });

  it("发行版名内含冒号时只剥离已知前缀", () => {
    expect(getWslDistroFromTargetId("wsl:a:b")).toBe("a:b");
  });
});

describe("wslMountPathToWindowsPath", () => {
  it("转换 /mnt/<盘符>/... 为 Windows 路径并大写盘符", () => {
    expect(wslMountPathToWindowsPath("/mnt/c/Users/me/file.txt")).toBe("C:\\Users\\me\\file.txt");
    expect(wslMountPathToWindowsPath("/mnt/d")).toBe("D:\\");
    expect(wslMountPathToWindowsPath("/mnt/e/")).toBe("E:\\");
  });

  it("非挂载路径原样返回", () => {
    expect(wslMountPathToWindowsPath("/home/me/.codex")).toBe("/home/me/.codex");
    expect(wslMountPathToWindowsPath("C:\\already\\win")).toBe("C:\\already\\win");
  });

  it("多字符盘符不被误判为挂载", () => {
    expect(wslMountPathToWindowsPath("/mnt/cc/x")).toBe("/mnt/cc/x");
  });
});

describe("isInsidePosixDir", () => {
  const root = "/home/me/.codex/sessions";

  it("接受目录内的文件与目录本身", () => {
    expect(isInsidePosixDir(`${root}/2024/rollout.jsonl`, root)).toBe(true);
    expect(isInsidePosixDir(root, root)).toBe(true);
  });

  it("挫败 ../ 逃逸", () => {
    expect(isInsidePosixDir(`${root}/../history.jsonl`, root)).toBe(false);
    expect(isInsidePosixDir(`${root}/../../etc/passwd`, root)).toBe(false);
  });

  it("挫败前缀混淆（sessions-evil 不属于 sessions）", () => {
    expect(isInsidePosixDir("/home/me/.codex/sessions-evil/x.jsonl", root)).toBe(false);
  });

  it("容忍目录参数的尾部斜杠", () => {
    expect(isInsidePosixDir(`${root}/x.jsonl`, `${root}/`)).toBe(true);
  });

  it("嵌入式 ../ 归一化后仍可正确判定逃逸", () => {
    expect(isInsidePosixDir(`${root}/sub/../../outside.jsonl`, root)).toBe(false);
    expect(isInsidePosixDir(`${root}/sub/../inside.jsonl`, root)).toBe(true);
  });
});

describe("isInsidePath", () => {
  it("接受目录内的文件（按当前平台分隔符）", () => {
    const dir = process.platform === "win32" ? "C:\\codex\\sessions" : "/codex/sessions";
    const file = process.platform === "win32" ? "C:\\codex\\sessions\\a.jsonl" : "/codex/sessions/a.jsonl";
    expect(isInsidePath(file, dir)).toBe(true);
    expect(isInsidePath(dir, dir)).toBe(true);
  });

  it("拒绝目录外的文件", () => {
    const dir = process.platform === "win32" ? "C:\\codex\\sessions" : "/codex/sessions";
    const outside = process.platform === "win32" ? "C:\\codex\\other\\a.jsonl" : "/codex/other/a.jsonl";
    expect(isInsidePath(outside, dir)).toBe(false);
  });
});

describe("sanitizeWslDistro", () => {
  it("保留安全字符", () => {
    expect(sanitizeWslDistro("Ubuntu-22.04_x")).toBe("Ubuntu-22.04_x");
  });

  it("把路径分隔符与注入字符替换为下划线（点号/连字符在白名单内保留）", () => {
    expect(sanitizeWslDistro("../../etc")).toBe(".._.._etc");
    expect(sanitizeWslDistro("a/b\\c")).toBe("a_b_c");
    expect(sanitizeWslDistro("a b;rm -rf")).toBe("a_b_rm_-rf");
  });
});

describe("parseWslSessionFileList", () => {
  it("解析 find -printf 的制表符分隔输出，mtime 转为毫秒", () => {
    const stdout = "/home/me/.codex/sessions/rollout-a.jsonl\t1700000000\t1234\n";
    expect(parseWslSessionFileList(stdout)).toEqual([
      { filePath: "/home/me/.codex/sessions/rollout-a.jsonl", mtimeMs: 1700000000000, size: 1234 }
    ]);
  });

  it("忽略空行与残缺/非数值行", () => {
    const stdout = [
      "/a/rollout-1.jsonl\t1700000000\t10",
      "",
      "   ",
      "/a/rollout-2.jsonl\tnot-a-number\t20",
      "/a/rollout-3.jsonl\t1700000001\t30"
    ].join("\n");
    const result = parseWslSessionFileList(stdout);
    expect(result.map((file) => file.filePath)).toEqual(["/a/rollout-1.jsonl", "/a/rollout-3.jsonl"]);
  });

  it("空输入返回空数组", () => {
    expect(parseWslSessionFileList("")).toEqual([]);
  });
});

describe("decodeWslOutput", () => {
  it("正确解码 UTF-16LE（wsl.exe 默认）输出", () => {
    const buffer = Buffer.from("Ubuntu\n", "utf16le");
    expect(decodeWslOutput(buffer).replace(/\0/g, "").trim()).toBe("Ubuntu");
  });

  it("正确解码 UTF-8 输出", () => {
    const buffer = Buffer.from("Debian\n", "utf8");
    expect(decodeWslOutput(buffer).trim()).toBe("Debian");
  });
});
