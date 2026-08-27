import type { AiProviderId } from "./types";

export type CliInstallerDefinition = {
  providerId: AiProviderId;
  label: string;
  description: string;
  installArgs: string[];
  docsUrl: string;
  iconLabel: string;
};

export const CLI_INSTALLERS: CliInstallerDefinition[] = [
  {
    providerId: "codex",
    label: "Codex",
    description: "OpenAI Codex CLI",
    installArgs: ["install", "-g", "@openai/codex"],
    docsUrl: "https://github.com/openai/codex",
    iconLabel: "C"
  },
  {
    providerId: "gemini",
    label: "Gemini",
    description: "Google Gemini CLI",
    installArgs: ["install", "-g", "@google/gemini-cli"],
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    iconLabel: "G"
  },
  {
    providerId: "claude",
    label: "Claude Code",
    description: "Anthropic Claude Code CLI",
    installArgs: ["install", "-g", "@anthropic-ai/claude-code"],
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
    iconLabel: "A"
  },
  {
    providerId: "qoder",
    label: "Qoder CN",
    description: "Qoder CN CLI",
    installArgs: ["install", "-g", "@qodercn-ai/qoderclicn"],
    docsUrl: "https://docs.qoder.cn/cli/installation",
    iconLabel: "Q"
  }
];

export function getCliInstaller(providerId: AiProviderId) {
  return CLI_INSTALLERS.find((installer) => installer.providerId === providerId);
}
