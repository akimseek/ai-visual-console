import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApiVendorInput } from "./types";

// 供应商 API Key 按要求以明文保存在 SQLite；这里仅 mock node:sqlite，覆盖保存、排序、模板渲染和备份路径。
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
          .sort((left, right) => (left.sort ?? 0) - (right.sort ?? 0) || Date.parse(left.created_at) - Date.parse(right.created_at));
      }
      if (sql.startsWith("SELECT * FROM api_vendors ORDER BY sort ASC")) {
        return [...this.state.vendors].sort((left, right) => (left.sort ?? 0) - (right.sort ?? 0) || Date.parse(left.created_at) - Date.parse(right.created_at));
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
      if (sql.startsWith("SELECT id FROM api_vendors WHERE sort = ? AND id <> ?")) {
        return this.state.vendors.find((vendor) => vendor.sort === params[0] && vendor.id !== params[1]);
      }
      if (sql.startsWith("SELECT MAX(sort) AS max_sort FROM api_vendors")) {
        return { max_sort: this.state.vendors.reduce((max, vendor) => Math.max(max, Number(vendor.sort) || 0), 0) || null };
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
          api_base_url: params[5],
          input_price_usd: params[6],
          output_price_usd: params[7],
          sort: params[8],
          enabled: params[9],
          created_at: params[10],
          updated_at: params[11],
          last_enabled_at: params[12]
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
      if (sql.startsWith("UPDATE api_vendors SET enabled = 0")) {
        const providerId = params[0];
        this.state.vendors = this.state.vendors.map((vendor) =>
          !providerId || vendor.provider_id === providerId ? { ...vendor, enabled: 0 } : vendor
        );
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

vi.mock("node:sqlite", () => ({
  DatabaseSync: sqliteMock.MockDatabaseSync
}));

import {
  deleteApiVendor,
  enableApiVendor,
  listApiVendorSummaries,
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
});

afterEach(async () => {
  vi.restoreAllMocks();
  sqliteMock.databases.delete(dbPath);
  await fs.rm(workDir, { recursive: true, force: true });
});

describe("saveApiVendor + listApiVendors（明文 API Key）", () => {
  it("落盘并读取明文 API Key", async () => {
    const saved = await saveApiVendor(vendorInput());
    expect(saved.apiKey).toBe("sk-secret-123");

    const store = readDbStore();
    expect(store.vendors).toHaveLength(1);
    expect(store.vendors[0].api_key).toBe("sk-secret-123");

    const listed = await listApiVendors();
    expect(listed[0].apiKey).toBe("sk-secret-123");
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

  it("新供应商未指定排序时取当前最大值加一，重复排序值会拒绝", async () => {
    const first = await saveApiVendor(vendorInput({ name: "排序一", sort: 4 }));
    const second = await saveApiVendor(vendorInput({ name: "排序二" }));
    expect(first.sort).toBe(4);
    expect(second.sort).toBe(5);
    await expect(saveApiVendor(vendorInput({ name: "重复排序", sort: 4 }))).rejects.toThrow("排序值 4 已被占用");
  });
});

describe("listApiVendors 过滤与排序", () => {
  it("保存并读取供应商费率", async () => {
    await saveApiVendor(vendorInput({
      pricing: { inputPerMillionUsd: 1.25, outputPerMillionUsd: 4.5 }
    }));
    const listed = await listApiVendors();
    expect(listed[0].pricing).toEqual({ inputPerMillionUsd: 1.25, outputPerMillionUsd: 4.5 });
  });

  it("按 target.provider 过滤，并按 sort 升序", async () => {
    await saveApiVendor(vendorInput({ name: "Codex 老", providerId: "codex", sort: 10 }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveApiVendor(vendorInput({ name: "Codex 新", providerId: "codex", sort: 1 }));
    await saveApiVendor(vendorInput({ name: "Gemini", providerId: "gemini", configs: [{ providerId: "gemini", enabled: true, targetPath: "~/.gemini/.env", content: "K={{API_KEY}}" }] }));

    const codexOnly = await listApiVendors({ provider: "codex" } as any);
    expect(codexOnly.map((vendor) => vendor.name)).toEqual(["Codex 新", "Codex 老"]);

    const all = await listApiVendors();
    expect(all).toHaveLength(3);
    const configIds = all.flatMap((vendor) => vendor.configs.map((config) => config.id));
    expect(new Set(configIds).size).toBe(configIds.length);
  });

  it("摘要列表不返回 API Key", async () => {
    await saveApiVendor(vendorInput());
    const summaries = await listApiVendorSummaries();
    expect(summaries[0].apiKey).toBe("");
  });

  it("新增供应商自动记录创建时间，编辑时保留原创建时间", async () => {
    const saved = await saveApiVendor(vendorInput());
    expect(saved.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const edited = await saveApiVendor({
      ...vendorInput({ id: saved.id, apiKey: "" }),
      name: "Renamed Vendor"
    });
    expect(edited.createdAt).toBe(saved.createdAt);
    expect((await listApiVendors())[0].createdAt).toBe(saved.createdAt);
  });
});

describe("deleteApiVendor", () => {
  it("按 id 删除", async () => {
    const saved = await saveApiVendor(vendorInput());
    await deleteApiVendor(saved.id);
    expect(await listApiVendors()).toHaveLength(0);
  });
});

describe("编辑供应商密钥", () => {
  it("编辑摘要供应商时留空 API Key 会保留原密钥", async () => {
    const saved = await saveApiVendor(vendorInput());
    const edited = await saveApiVendor({
      ...vendorInput({ id: saved.id, apiKey: "" }),
      name: "Renamed Vendor"
    });
    expect(edited.apiKey).toBe("sk-secret-123");
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
