import type {
  ApiVendor,
  ApiVendorConfigTemplate,
  ApiVendorInput
} from "./types";

// 供应商草稿与配置文件模板的纯逻辑（无 React 状态），从 App.tsx 抽出以降低单文件体积。

export type ApiVendorDraft = ApiVendorInput;
export type VendorFieldName = "name" | "apiBaseUrl" | "apiKey";
export type VendorFieldErrors = Partial<Record<VendorFieldName, string>>;

const CODEX_DEFAULT_MODEL_PROVIDER = "akim";

export function createEmptyVendorDraft(): ApiVendorDraft {
  return buildVendorDraft({
    providerId: "codex",
    name: "",
    apiKey: "",
    apiBaseUrl: "",
    writeCommonConfig: false,
    configs: []
  });
}

export function buildVendorDraft(input: ApiVendorDraft): ApiVendorDraft {
  const name = input.name;
  const apiKey = input.apiKey;
  const apiBaseUrl = input.apiBaseUrl;
  const providerId = input.providerId || "codex";
  const existing = new Map(input.configs.map((config) => [config.id, config]));
  const configs = defaultVendorConfigs()
    .filter((config) => config.providerId === providerId)
    .map((fallback) => ({
      ...fallback,
      enabled: existing.get(fallback.id)?.enabled ?? fallback.enabled,
      targetPath: existing.get(fallback.id)?.targetPath || fallback.targetPath,
      content: existing.get(fallback.id)?.content ?? fallback.content
    }));
  return {
    id: input.id,
    providerId,
    name,
    apiKey,
    apiBaseUrl,
    writeCommonConfig: input.writeCommonConfig === true,
    configs
  };
}

export function vendorToDraft(vendor: ApiVendor): ApiVendorDraft {
  return buildVendorDraft({
    id: vendor.id,
    providerId: vendor.providerId,
    name: vendor.name,
    apiKey: vendor.apiKey,
    apiBaseUrl: vendor.apiBaseUrl,
    writeCommonConfig: vendor.writeCommonConfig === true,
    configs: vendor.configs
  });
}

export function visibleVendorConfigs(draft: ApiVendorDraft) {
  return draft.configs;
}

export function prepareVendorDraftForSave(draft: ApiVendorDraft): ApiVendorDraft {
  return {
    ...draft,
    configs: draft.configs.map((config) => ({
      ...config,
      enabled: true
    }))
  };
}

export function shouldApplyVendorConfigAfterSave(draft: ApiVendorDraft, existingVendors: ApiVendor[]) {
  return draft.writeCommonConfig === true
    || Boolean(draft.id && existingVendors.some((vendor) => vendor.id === draft.id && vendor.enabled));
}

export function validateVendorDraft(draft: ApiVendorDraft, existingVendors: ApiVendor[] = []): VendorFieldErrors {
  const errors: VendorFieldErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = "请输入供应商名称。";
  else if (existingVendors.some((vendor) => vendor.id !== draft.id && sameVendorName(vendor.name, name))) {
    errors.name = "供应商名称已存在。";
  }
  if (!draft.apiBaseUrl.trim()) errors.apiBaseUrl = "请输入 API 请求地址。";
  if (!draft.apiKey.trim()) errors.apiKey = "请输入 API Key。";
  return errors;
}

function sameVendorName(left: string, right: string) {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function defaultVendorConfigs(): ApiVendorConfigTemplate[] {
  return [
    {
      id: "codex-auth",
      providerId: "codex",
      label: "Codex auth.json",
      enabled: true,
      targetPath: "~/.codex/auth.json",
      content: JSON.stringify({ OPENAI_API_KEY: "{{API_KEY}}" }, null, 2)
    },
    {
      id: "codex-config",
      providerId: "codex",
      label: "Codex config.toml",
      enabled: true,
      targetPath: "~/.codex/config.toml",
      content: [
        `model_provider = "${CODEX_DEFAULT_MODEL_PROVIDER}"`,
        "",
        `[model_providers.${CODEX_DEFAULT_MODEL_PROVIDER}]`,
        `name = "${CODEX_DEFAULT_MODEL_PROVIDER}"`,
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'base_url = "{{BASE_URL}}"'
      ].join("\n")
    },
    {
      id: "gemini-env",
      providerId: "gemini",
      label: "Gemini .env",
      enabled: false,
      targetPath: "~/.gemini/.env",
      content: [
        "GEMINI_API_KEY={{API_KEY}}",
        "GOOGLE_GEMINI_BASE_URL={{BASE_URL}}"
      ].join("\n")
    },
    {
      id: "gemini-settings",
      providerId: "gemini",
      label: "Gemini settings.json",
      enabled: false,
      targetPath: "~/.gemini/settings.json",
      content: JSON.stringify({
        security: {
          auth: {
            selectedType: "gemini-api-key"
          }
        }
      }, null, 2)
    },
    {
      id: "claude-settings",
      providerId: "claude",
      label: "Claude settings.json",
      enabled: false,
      targetPath: "~/.claude/settings.json",
      content: JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "{{BASE_URL}}",
          ANTHROPIC_AUTH_TOKEN: "{{API_KEY}}"
        },
        theme: "dark"
      }, null, 2)
    }
  ];
}

export function renderVendorConfigPreview(config: ApiVendorConfigTemplate, draft: ApiVendorDraft) {
  return config.content
    .replace(/\{\{API_KEY\}\}/g, draft.apiKey)
    .replace(/\{\{BASE_URL\}\}/g, draft.apiBaseUrl)
    .replace(/\{\{VENDOR_NAME\}\}/g, draft.name);
}

export function toVendorConfigTemplate(content: string, draft: ApiVendorDraft) {
  return [
    [draft.apiKey, "{{API_KEY}}"],
    [draft.apiBaseUrl, "{{BASE_URL}}"],
    [draft.name, "{{VENDOR_NAME}}"]
  ].reduce((current, [value, placeholder]) => {
    if (!value) return current;
    return current.split(value).join(placeholder);
  }, content);
}

export function buildVendorConfigTemplateFromExisting(
  config: ApiVendorConfigTemplate,
  existingContent: string,
  draft: ApiVendorDraft
) {
  const hasExistingContent = existingContent.trim().length > 0;
  const content = hasExistingContent ? existingContent : config.content;
  if (config.id === "codex-auth") return buildCodexAuthTemplate(content);
  if (config.id === "codex-config") return buildCodexConfigTemplate(content, hasExistingContent);
  if (config.id === "gemini-env") return buildGeminiEnvTemplate(content);
  if (config.id === "gemini-settings") return buildGeminiSettingsTemplate(content, config.content);
  if (config.providerId === "claude") return buildClaudeSettingsTemplate(content, config.content);
  return toVendorConfigTemplate(content, draft);
}

function buildCodexAuthTemplate(content: string) {
  try {
    const auth = JSON.parse(content || "{}") as Record<string, unknown>;
    auth.OPENAI_API_KEY = "{{API_KEY}}";
    return JSON.stringify(auth, null, 2);
  } catch {
    return JSON.stringify({ OPENAI_API_KEY: "{{API_KEY}}" }, null, 2);
  }
}

function buildGeminiEnvTemplate(content: string) {
  const lines = content.split(/\r?\n/);
  return upsertEnvLine(upsertEnvLine(lines, "GEMINI_API_KEY", "{{API_KEY}}"), "GOOGLE_GEMINI_BASE_URL", "{{BASE_URL}}").join("\n");
}

function upsertEnvLine(lines: string[], key: string, value: string) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const existingIndex = lines.findIndex((line) => pattern.test(line));
  if (existingIndex >= 0) {
    return lines.map((line, index) => index === existingIndex ? `${key}=${value}` : line);
  }
  return [...lines.filter((line, index) => index !== lines.length - 1 || line.trim()), `${key}=${value}`];
}

function buildGeminiSettingsTemplate(content: string, fallback: string) {
  try {
    const value = JSON.parse(content || "{}") as Record<string, unknown>;
    const security = value.security && typeof value.security === "object" && !Array.isArray(value.security)
      ? value.security as Record<string, unknown>
      : {};
    const auth = security.auth && typeof security.auth === "object" && !Array.isArray(security.auth)
      ? security.auth as Record<string, unknown>
      : {};
    auth.selectedType = "gemini-api-key";
    security.auth = auth;
    value.security = security;
    delete value.apiKey;
    delete value.baseUrl;
    delete value.provider;
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

function buildClaudeSettingsTemplate(content: string, fallback: string) {
  try {
    const value = JSON.parse(content || "{}") as Record<string, unknown>;
    const env = value.env && typeof value.env === "object" && !Array.isArray(value.env)
      ? value.env as Record<string, unknown>
      : {};
    env.ANTHROPIC_BASE_URL = "{{BASE_URL}}";
    env.ANTHROPIC_AUTH_TOKEN = "{{API_KEY}}";
    value.env = env;
    if (typeof value.theme !== "string") value.theme = "dark";
    delete value.apiKey;
    delete value.baseUrl;
    delete value.provider;
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

function buildCodexConfigTemplate(content: string, hasExistingContent: boolean) {
  const base = content.trim()
    ? content
    : [
      `model_provider = "${CODEX_DEFAULT_MODEL_PROVIDER}"`,
      "",
      `[model_providers.${CODEX_DEFAULT_MODEL_PROVIDER}]`
    ].join("\n");
  const activeProvider = readTomlScalar(base, "model_provider");
  const withProvider = upsertTomlScalar(base, "model_provider", `"${CODEX_DEFAULT_MODEL_PROVIDER}"`);
  return upsertTomlProviderBlock(withProvider, activeProvider, CODEX_DEFAULT_MODEL_PROVIDER, hasExistingContent);
}

function readTomlScalar(content: string, key: string) {
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*["']?([^"'#]+)["']?`);
  const firstSectionIndex = content.split(/\r?\n/).findIndex((line) => /^\s*\[/.test(line));
  const lines = content.split(/\r?\n/);
  const searchEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  for (let index = 0; index < searchEnd; index += 1) {
    const match = keyPattern.exec(lines[index]);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return "";
}

function upsertTomlScalar(content: string, key: string, value: string) {
  const lines = content.split(/\r?\n/);
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const searchEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  const existingIndex = lines.findIndex((line, index) => index < searchEnd && keyPattern.test(line));
  if (existingIndex >= 0) {
    lines[existingIndex] = `${key} = ${value}`;
    return lines.join("\n");
  }
  lines.splice(searchEnd, 0, `${key} = ${value}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function upsertTomlProviderBlock(
  content: string,
  currentProviderName: string,
  nextProviderName: string,
  _hasExistingContent: boolean
) {
  const nextHeader = `[model_providers.${nextProviderName}]`;
  const lines = content.split(/\r?\n/);
  let headerIndex = currentProviderName
    ? lines.findIndex((line) => parseTomlProviderHeader(line) === currentProviderName)
    : -1;
  if (headerIndex === -1) headerIndex = lines.findIndex((line) => parseTomlProviderHeader(line) === nextProviderName);
  if (headerIndex === -1) headerIndex = lines.findIndex((line) => Boolean(parseTomlProviderHeader(line)));
  if (headerIndex === -1) {
    const separator = lines.length && lines[lines.length - 1].trim() ? [""] : [];
    return [
      ...lines,
      ...separator,
      nextHeader,
      `name = "${CODEX_DEFAULT_MODEL_PROVIDER}"`,
      'base_url = "{{BASE_URL}}"'
    ].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  const nextSectionIndex = lines.findIndex((line, index) => index > headerIndex && /^\s*\[/.test(line));
  const before = [...lines.slice(0, headerIndex), nextHeader];
  const body = lines.slice(headerIndex + 1, nextSectionIndex === -1 ? lines.length : nextSectionIndex);
  const after = nextSectionIndex === -1 ? [] : lines.slice(nextSectionIndex);
  return [
    ...before,
    ...upsertTomlBlockScalar(
      upsertTomlBlockScalar(body, "name", `"${CODEX_DEFAULT_MODEL_PROVIDER}"`),
      "base_url",
      '"{{BASE_URL}}"'
    ),
    ...after
  ].join("\n").replace(/\n{3,}/g, "\n\n");
}

function upsertTomlBlockScalar(lines: string[], key: string, value: string) {
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const existingIndex = lines.findIndex((line) => keyPattern.test(line));
  if (existingIndex >= 0) {
    return lines.map((line, index) => index === existingIndex ? `${key} = ${value}` : line);
  }
  return [...lines, `${key} = ${value}`];
}

function parseTomlProviderHeader(line: string) {
  const match = /^\s*\[model_providers\.(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\]\s*$/.exec(line);
  return match?.[1] || match?.[2] || match?.[3] || "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
