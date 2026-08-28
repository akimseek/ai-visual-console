import { describe, expect, it } from "vitest";
import { resolveRuntimeStorageRoot } from "./application-paths";

describe("application runtime paths", () => {
  it("keeps development data in the project directory", () => {
    expect(resolveRuntimeStorageRoot({
      isPackaged: false,
      executablePath: "D:\\code\\ai\\release\\win-unpacked\\app.exe",
      cwd: "/mnt/d/code/ai",
      platform: "linux"
    })).toBe("/mnt/d/code/ai");
  });

  it("keeps Windows unpacked data outside the rebuilt output directory", () => {
    const options = {
      isPackaged: true,
      executablePath: "D:\\code\\ai\\release\\win-unpacked\\AI Console.exe",
      cwd: "D:\\code\\ai",
      platform: "win32" as const
    };

    expect(resolveRuntimeStorageRoot(options)).toBe("D:\\code\\ai\\release");
  });

  it("keeps installed Windows data beside the executable", () => {
    expect(resolveRuntimeStorageRoot({
      isPackaged: true,
      executablePath: "D:\\Apps\\AI Console\\AI Console.exe",
      cwd: "D:\\code\\ai",
      platform: "win32"
    })).toBe("D:\\Apps\\AI Console");
  });
});
