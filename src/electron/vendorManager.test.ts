import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApiVendorInput } from "./types";

// vendorManager 是安全敏感模块：API Key 经 safeStorage 加密落盘、配置写入受路径白名单约束、
// 存储用 临时文件 + rename 原子落盘。这里 mock electron 的 safeStorage（用可逆前缀模拟加解密），
// 并把 os.homedir 指向临时目录，以覆盖加解密往返、去重、过滤排序、启用模板渲染与备份等关键路径。

const electronMock = vi.hoisted(() => ({ encryptionAvailable: true }));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => electronMock.encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("解密失败");
      return text.slice(4);
    }
  }
}));

import {
  deleteApiVendor,
  enableApiVendor,
  isApiKeyEncryptionAvailable,
  listApiVendors,
  saveApiVendor,
  setVendorStorePath
} from "./vendorManager";

let workDir = "";
let homeDir = "";
let storePath = "";

function vendorInput(overrides: Partial<ApiVendorInput> = {}): ApiVendorInput {
  return {
    providerId: "codex",
    name: "My Vendor",
    apiKey: "sk-secret-123",
    apiBaseUrl: "https://api.example.com",
    writeCommonConfig: false,
    configs: [
      {
        providerId: "codex",
        enabled: true,
        targetPath: "~/.codex/auth.json",
        content: '{"OPENAI_API_KEY":"{{API_KEY}}","base":"{{BASE_URL}}"}'
      }
    ],
    ...overrides
  };
}

async function readStore() {
  return JSON.parse(await fs.readFile(storePath, "utf8")) as { vendors?: any[] };
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "vendor-test-"));
  homeDir = path.join(workDir, "home");
  storePath = path.join(workDir, "vendors.json");
  await fs.mkdir(homeDir, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  setVendorStorePath(storePath, path.join(workDir, "backups"));
  electronMock.encryptionAvailable = true;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(workDir, { recursive: true, force: true });
});

describe("saveApiVendor + listApiVendors（加密往返）", () => {
  it("加密可用时：落盘为密文且标记 encrypted，读取后解密还原明文", async () => {
    const saved = await saveApiVendor(vendorInput());
    expect(saved.apiKey).toBe("sk-secret-123");

    const store = await readStore();
    expect(store.vendors).toHaveLength(1);
    expect(store.vendors![0].apiKeyEncrypted).toBe(true);
    // 落盘的是 base64(enc:明文)，绝不能是明文
    expect(store.vendors![0].apiKey).not.toContain("sk-secret-123");
    expect(Buffer.from(store.vendors![0].apiKey, "base64").toString("utf8")).toBe("enc:sk-secret-123");

    const listed = await listApiVendors();
    expect(listed[0].apiKey).toBe("sk-secret-123");
  });

  it("加密不可用时：明文落盘并标记 encrypted=false", async () => {
    electronMock.encryptionAvailable = false;
    await saveApiVendor(vendorInput());
    const store = await readStore();
    expect(store.vendors![0].apiKeyEncrypted).toBe(false);
    expect(store.vendors![0].apiKey).toBe("sk-secret-123");
  });

  it("密文损坏（非法 base64/前缀）时解密失败回退为空串，不抛出", async () => {
    await fs.writeFile(
      storePath,
      JSON.stringify({ vendors: [{ id: "x", providerId: "codex", name: "坏", apiKey: "@@@", apiKeyEncrypted: true, configs: [], createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" }] }),
      "utf8"
    );
    const listed = await listApiVendors();
    expect(listed[0].apiKey).toBe("");
  });
});

describe("saveApiVendor 校验与规范化", () => {
  it("同名（忽略大小写/首尾空格）视为重复并拒绝", async () => {
    await saveApiVendor(vendorInput({ name: "Vendor A" }));
    await expect(saveApiVendor(vendorInput({ name: "  vendor a  " }))).rejects.toThrow("已存在");
  });

  it("名称/Key/地址为空时抛错", async () => {
    await expect(saveApiVendor(vendorInput({ name: "   " }))).rejects.toThrow("名称不能为空");
    await expect(saveApiVendor(vendorInput({ apiKey: "" }))).rejects.toThrow("API Key 不能为空");
    await expect(saveApiVendor(vendorInput({ apiBaseUrl: "" }))).rejects.toThrow("地址不能为空");
  });

  it("配置路径不在 ~/.codex|.gemini|.claude 白名单内时拒绝保存", async () => {
    await expect(
      saveApiVendor(vendorInput({ configs: [{ providerId: "codex", enabled: true, targetPath: "~/.evil/x.json", content: "x" }] }))
    ).rejects.toThrow("不在允许范围");
  });

  it("配置路径企图 ../ 穿越时拒绝", async () => {
    await expect(
      saveApiVendor(vendorInput({ configs: [{ providerId: "codex", enabled: true, targetPath: "~/.codex/../../etc/passwd", content: "x" }] }))
    ).rejects.toThrow("不在允许范围");
  });
});

describe("listApiVendors 过滤与排序", () => {
  it("按 target.provider 过滤，并按 updatedAt 倒序", async () => {
    await saveApiVendor(vendorInput({ name: "Codex 老", providerId: "codex" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveApiVendor(vendorInput({ name: "Codex 新", providerId: "codex" }));
    await saveApiVendor(vendorInput({ name: "Gemini", providerId: "gemini", configs: [{ providerId: "gemini", enabled: true, targetPath: "~/.gemini/.env", content: "K={{API_KEY}}" }] }));

    const codexOnly = await listApiVendors({ provider: "codex" } as any);
    expect(codexOnly.map((vendor) => vendor.name)).toEqual(["Codex 新", "Codex 老"]);

    const all = await listApiVendors();
    expect(all).toHaveLength(3);
  });
});

describe("deleteApiVendor", () => {
  it("按 id 删除", async () => {
    const saved = await saveApiVendor(vendorInput());
    await deleteApiVendor(saved.id);
    expect(await listApiVendors()).toHaveLength(0);
  });
});

describe("enableApiVendor", () => {
  it("把模板占位符替换为真实 Key/地址并写入本地配置，标记 enabled", async () => {
    const saved = await saveApiVendor(vendorInput());
    const result = await enableApiVendor({ vendorId: saved.id });

    expect(result.written).toContain("~/.codex/auth.json");
    const written = await fs.readFile(path.join(homeDir, ".codex", "auth.json"), "utf8");
    expect(written).toContain("sk-secret-123");
    expect(written).toContain("https://api.example.com");
    expect(written).not.toContain("{{API_KEY}}");

    const store = await readStore();
    expect(store.vendors![0].enabled).toBe(true);
    expect(store.vendors![0].lastEnabledAt).toBeTruthy();
  });

  it("覆盖已有配置前会把原内容备份到 backupRoot", async () => {
    const authPath = path.join(homeDir, ".codex", "auth.json");
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await fs.writeFile(authPath, "PREVIOUS-CONTENT", "utf8");

    const saved = await saveApiVendor(vendorInput());
    await enableApiVendor({ vendorId: saved.id });

    const backups = await collectFiles(path.join(workDir, "backups"));
    const backupContents = await Promise.all(backups.map((file) => fs.readFile(file, "utf8")));
    expect(backupContents).toContain("PREVIOUS-CONTENT");
  });

  it("供应商不存在时抛错", async () => {
    await expect(enableApiVendor({ vendorId: "nope" })).rejects.toThrow("供应商不存在");
  });
});

describe("isApiKeyEncryptionAvailable", () => {
  it("反映 safeStorage 的可用状态", () => {
    electronMock.encryptionAvailable = true;
    expect(isApiKeyEncryptionAvailable()).toBe(true);
    electronMock.encryptionAvailable = false;
    expect(isApiKeyEncryptionAvailable()).toBe(false);
  });
});

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await collectFiles(full)));
    else out.push(full);
  }
  return out;
}
