import { describe, expect, it } from "vitest";
import {
  buildVendorConfigTemplateFromExisting,
  buildVendorDraft,
  calculateVendorColumnWidths,
  renderVendorConfigPreview,
  toVendorConfigTemplate,
  validateVendorDraft
} from "./vendor-config";
import type { ApiVendorConfigTemplate } from "../../types";

const DRAFT = buildVendorDraft({
  providerId: "codex",
  name: "MyVendor",
  apiKey: "sk-secret",
  apiBaseUrl: "https://api.example.com",
  sort: 1,
  configs: []
});

describe("buildVendorDraft", () => {
  it("按 providerId 仅生成对应平台的默认配置", () => {
    expect(DRAFT.configs.every((config) => config.providerId === "codex")).toBe(true);
    expect(DRAFT.configs.map((config) => config.id)).toEqual(["codex-auth", "codex-config"]);
  });

  it("切换到 gemini 生成 gemini 配置", () => {
    const gemini = buildVendorDraft({ ...DRAFT, providerId: "gemini", configs: [] });
    expect(gemini.configs.map((config) => config.id)).toEqual(["gemini-env", "gemini-settings"]);
  });
});

describe("calculateVendorColumnWidths", () => {
  it("按内容宽度计算并限制最小/最大值", () => {
    const widths = calculateVendorColumnWidths([20, 500, 80, 40, 100, 80, 80], 0);
    expect(widths[0]).toBe(180);
    expect(widths[1]).toBe(180);
    expect(widths[6]).toBe(164);
  });

  it("容器有剩余空间时优先扩展名称列", () => {
    const widths = calculateVendorColumnWidths([], 1200);
    expect(widths.reduce((total, width) => total + width, 0)).toBe(1200);
    expect(widths[0]).toBeGreaterThan(widths[1]);
  });

  it("宽容器下仍让列宽总和精确匹配容器，剩余空间交给名称列", () => {
    const widths = calculateVendorColumnWidths([], 1570);
    expect(widths.reduce((total, width) => total + width, 0)).toBe(1570);
    expect(widths[0]).toBe(480);
  });

  it("容器过窄时仍保留所有列的最小宽度", () => {
    const widths = calculateVendorColumnWidths([], 400);
    expect(widths.reduce((total, width) => total + width, 0)).toBeGreaterThan(400);
    expect(widths.every((width) => width > 0)).toBe(true);
  });
});

describe("validateVendorDraft", () => {
  it("缺字段时报错", () => {
    const errors = validateVendorDraft({ ...DRAFT, name: "", apiKey: "", apiBaseUrl: "" });
    expect(errors.name).toBeTruthy();
    expect(errors.apiKey).toBeTruthy();
    expect(errors.apiBaseUrl).toBeTruthy();
  });

  it("排序为空时报错", () => {
    expect(validateVendorDraft({ ...DRAFT, sort: undefined }).sort).toContain("排序值");
  });

  it("重名（忽略大小写）报错", () => {
    const errors = validateVendorDraft(DRAFT, [
      { id: "other", providerId: "codex", name: "myvendor", apiKey: "x", apiBaseUrl: "y", configs: [] } as never
    ]);
    expect(errors.name).toBe("供应商名称已存在。");
  });

  it("合法草稿无错误", () => {
    expect(validateVendorDraft(DRAFT)).toEqual({});
  });

  it("费率最多保留两位小数且不能为负数", () => {
    expect(validateVendorDraft({ ...DRAFT, pricing: { inputPerMillionUsd: 1.234 } }).inputPrice).toContain("2 位");
    expect(validateVendorDraft({ ...DRAFT, pricing: { outputPerMillionUsd: -1 } }).outputPrice).toContain("非负数");
  });
});

describe("renderVendorConfigPreview / toVendorConfigTemplate", () => {
  const config: ApiVendorConfigTemplate = {
    id: "x",
    providerId: "codex",
    label: "x",
    enabled: true,
    targetPath: "~/.codex/auth.json",
    content: 'key={{API_KEY}} url={{BASE_URL}} name={{VENDOR_NAME}}'
  };

  it("预览把占位符替换成真实值", () => {
    expect(renderVendorConfigPreview(config, DRAFT)).toBe(
      "key=sk-secret url=https://api.example.com name=MyVendor"
    );
  });

  it("反向把真实值替换回占位符（避免明文入库）", () => {
    const rendered = "key=sk-secret url=https://api.example.com name=MyVendor";
    expect(toVendorConfigTemplate(rendered, DRAFT)).toBe(config.content);
  });
});

describe("buildVendorConfigTemplateFromExisting", () => {
  const authConfig: ApiVendorConfigTemplate = {
    id: "codex-auth",
    providerId: "codex",
    label: "auth",
    enabled: true,
    targetPath: "~/.codex/auth.json",
    content: ""
  };

  it("codex-auth 保留已有键，仅把 API Key 替换为占位符", () => {
    const existing = JSON.stringify({ OPENAI_API_KEY: "old", KEEP_ME: "yes" });
    const result = buildVendorConfigTemplateFromExisting(authConfig, existing, DRAFT);
    const parsed = JSON.parse(result) as Record<string, string>;
    expect(parsed.OPENAI_API_KEY).toBe("{{API_KEY}}");
    expect(parsed.KEEP_ME).toBe("yes");
  });

  it("gemini-env 在已有内容中 upsert 关键字段", () => {
    const envConfig: ApiVendorConfigTemplate = {
      id: "gemini-env",
      providerId: "gemini",
      label: "env",
      enabled: true,
      targetPath: "~/.gemini/.env",
      content: ""
    };
    const result = buildVendorConfigTemplateFromExisting(envConfig, "FOO=bar\nGEMINI_API_KEY=old", DRAFT);
    expect(result).toContain("FOO=bar");
    expect(result).toContain("GEMINI_API_KEY={{API_KEY}}");
    expect(result).toContain("GOOGLE_GEMINI_BASE_URL={{BASE_URL}}");
  });

  it("codex-config 注入 model_provider 与 provider 块", () => {
    const cfg: ApiVendorConfigTemplate = {
      id: "codex-config",
      providerId: "codex",
      label: "config",
      enabled: true,
      targetPath: "~/.codex/config.toml",
      content: ""
    };
    const result = buildVendorConfigTemplateFromExisting(cfg, "", DRAFT);
    expect(result).toContain('model_provider = "akim"');
    expect(result).toContain("[model_providers.akim]");
    expect(result).toContain('base_url = "{{BASE_URL}}"');
  });

  it("已有多个 akim provider 时只保留一个并保留其他 provider", () => {
    const cfg: ApiVendorConfigTemplate = {
      id: "stored-config-id",
      providerId: "codex",
      label: "config",
      enabled: true,
      targetPath: "~/.codex/config.toml",
      content: ""
    };
    const existing = [
      'model_provider = "vef_ai_relay"',
      "",
      "[model_providers.vef_ai_relay]",
      'name = "vef_ai_relay"',
      'base_url = "https://relay.example/v1"',
      "",
      "[model_providers.akim]",
      'name = "akim"',
      'base_url = "https://old.example/v1"',
      "",
      "[model_providers.akim]",
      'name = "akim"',
      'base_url = "https://duplicate.example/v1"'
    ].join("\n");
    const result = buildVendorConfigTemplateFromExisting(cfg, existing, DRAFT);
    expect(result.match(/\[model_providers\.akim\]/g)).toHaveLength(1);
    expect(result).toContain("[model_providers.vef_ai_relay]");
    expect(result).toContain('model_provider = "akim"');
  });
});
