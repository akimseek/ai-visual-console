import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApiVendorInput } from "./types";

// vendorManager 是安全敏感模块：API Key 经 safeStorage 加密落盘、配置写入受路径白名单约束。
// 这里 mock electron 的 safeStorage（用可逆前缀模拟加解密）和 node:sqlite，
// 并把 os.homedir 指向临时目录，以覆盖加解密往返、去重、过滤排序、启用模板渲染与备份等关键路径。

const electronMock = vi.hoisted(() => ({ encryptionAvailable: true }));
const sqliteMock = vi.hoisted(() => {
  type MockVendorRow = Record<string, any>;
  type MockDatabaseState = {
    vendors: MockVendorRow[];
    configs: MockVendorRow[];
  };
  const databases = new Map<string, MockDatabaseState>();
  function stateFor(location: string) {
    let state = databases.get(location);
    if (!state) {
      state = { vendors: [], configs: [] };
      databases.set(location, state);
    }
    return state;
  }
  function normalizeSql(sql: string) {
    return sql.replace(/\s+/g, " ").trim();
  }
  class MockStatement {
    constructor(private state: MockDatabaseState, private sql: string) {}
    all(...params: unknown[]) {
      const sql = normalizeSql(this.sql);
      if (sql.startsWith("SELECT * FROM api_vendors WHERE provider_id = ?")) {
        return this.state.vendors
          .filter((vendor) => vendor.provider_id === params[0])
          .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
      }
      if (sql.startsWith("SELECT * FROM api_vendors ORDER BY updated_at DESC")) {
        return [...this.state.vendors].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
      }
      if (sql.startsWith("SELECT * FROM api_vendor_configs WHERE vendor_id = ?")) {
        return this.state.configs
          .filter((config) => config.vendor_id === params[0])
          .sort((left, right) => left.sort_order - right.sort_order || String(left.id).localeCompare(String(right.id)));
      }
      throw new Error(`Unsupported all SQL: ${sql}`);
    }
    get(...params: unknown[]) {
      const sql = normalizeSql(this.sql);
      if (sql.startsWith("SELECT * FROM api_vendors WHERE id = ?")) {
        return this.state.vendors.find((vendor) => vendor.id === params[0]);
      }
      if (sql.startsWith("SELECT id FROM api_vendors WHERE name_norm = ? AND id <> ?")) {
        return this.state.vendors.find((vendor) => vendor.name_norm === params[0] && vendor.id !== params[1]);
      }
      throw new Error(`Unsupported get SQL: ${sql}`);
    }
    run(...params: unknown[]) {
      const sql = normalizeSql(this.sql);
      if (sql.startsWith("INSERT INTO api_vendors")) {
        const row = {
          id: params[0],
          provider_id: params[1],
          name: params[2],
          name_norm: params[3],
          api_key: params[4],
          api_key_encrypted: params[5],
          api_base_url: params[6],
          write_common_config: params[7],
          enabled: params[8],
          created_at: params[9],
          updated_at: params[10],
          last_enabled_at: params[11]
        };
        this.state.vendors = [row, ...this.state.vendors.filter((vendor) => vendor.id !== row.id)];
        return { changes: 1, lastInsertRowid: 0 };
      }
      if (sql.startsWith("DELETE FROM api_vendor_configs WHERE vendor_id = ?")) {
        this.state.configs = this.state.configs.filter((config) => config.vendor_id !== params[0]);
        return { changes: 1, lastInsertRowid: 0 };
      }
      if (sql.startsWith("INSERT INTO api_vendor_configs")) {
        this.state.configs.push({
          id: params[0],
          vendor_id: params[1],
          provider_id: params[2],
          label: params[3],
          enabled: params[4],
          target_path: params[5],
          content: params[6],
          sort_order: params[7]
        });
        return { changes: 1, lastInsertRowid: 0 };
      }
      if (sql.startsWith("DELETE FROM api_vendors WHERE id = ?")) {
        this.state.vendors = this.state.vendors.filter((vendor) => vendor.id !== params[0]);
        this.state.configs = this.state.configs.filter((config) => config.vendor_id !== params[0]);
        return { changes: 1, lastInsertRowid: 0 };
      }
      if (sql === "UPDATE api_vendors SET enabled = 0") {
        this.state.vendors = this.state.vendors.map((vendor) => ({ ...vendor, enabled: 0 }));
        return { changes: this.state.vendors.length, lastInsertRowid: 0 };
      }
      if (sql.startsWith("UPDATE api_vendors SET enabled = 1, last_enabled_at = ?, updated_at = ? WHERE id = ?")) {
        this.state.vendors = this.state.vendors.map((vendor) => vendor.id === params[2]
          ? { ...vendor, enabled: 1, last_enabled_at: params[0], updated_at: params[1] }
          : vendor);
        return { changes: 1, lastInsertRowid: 0 };
      }
      throw new Error(`Unsupported run SQL: ${sql}`);
    }
  }
  class MockDatabaseSync {
    private state: MockDatabaseState;
    constructor(location: string) {
      this.state = stateFor(location);
    }
    exec() {}
    prepare(sql: string) {
      return new MockStatement(this.state, sql);
    }
    close() {}
  }
  return { databases, MockDatabaseSync };
});

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

vi.mock("node:sqlite", () => ({
  DatabaseSync: sqliteMock.MockDatabaseSync
}));

import {
  deleteApiVendor,
  enableApiVendor,
  isApiKeyEncryptionAvailable,
  listApiVendors,
  saveApiVendor,
  setVendorDatabasePath
} from "./vendorManager";

let workDir = "";
let homeDir = "";
let dbPath = "";

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

function readDbStore() {
  return sqliteMock.databases.get(dbPath) || { vendors: [], configs: [] };
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "vendor-test-"));
  homeDir = path.join(workDir, "home");
  dbPath = path.join(workDir, "app.db");
  await fs.mkdir(homeDir, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  setVendorDatabasePath(dbPath, path.join(workDir, "backups"));
  electronMock.encryptionAvailable = true;
});

afterEach(async () => {
  vi.restoreAllMocks();
  sqliteMock.databases.delete(dbPath);
  await fs.rm(workDir, { recursive: true, force: true });
});

describe("saveApiVendor + listApiVendors（加密往返）", () => {
  it("加密可用时：落盘为密文且标记 encrypted，读取后解密还原明文", async () => {
    const saved = await saveApiVendor(vendorInput());
    expect(saved.apiKey).toBe("sk-secret-123");

    const store = readDbStore();
    expect(store.vendors).toHaveLength(1);
    expect(store.vendors[0].api_key_encrypted).toBe(1);
    // 落盘的是 base64(enc:明文)，绝不能是明文
    expect(store.vendors[0].api_key).not.toContain("sk-secret-123");
    expect(Buffer.from(store.vendors[0].api_key, "base64").toString("utf8")).toBe("enc:sk-secret-123");

    const listed = await listApiVendors();
    expect(listed[0].apiKey).toBe("sk-secret-123");
  });

  it("加密不可用时：明文落盘并标记 encrypted=false", async () => {
    electronMock.encryptionAvailable = false;
    await saveApiVendor(vendorInput());
    const store = readDbStore();
    expect(store.vendors[0].api_key_encrypted).toBe(0);
    expect(store.vendors[0].api_key).toBe("sk-secret-123");
  });

  it("密文损坏（非法 base64/前缀）时解密失败回退为空串，不抛出", async () => {
    sqliteMock.databases.set(dbPath, {
      vendors: [{
        id: "x",
        provider_id: "codex",
        name: "坏",
        name_norm: "坏",
        api_key: "@@@",
        api_key_encrypted: 1,
        api_base_url: "https://api.example.com",
        write_common_config: 0,
        enabled: 0,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        last_enabled_at: null
      }],
      configs: []
    });
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

    const store = readDbStore();
    expect(store.vendors[0].enabled).toBe(1);
    expect(store.vendors[0].last_enabled_at).toBeTruthy();
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
