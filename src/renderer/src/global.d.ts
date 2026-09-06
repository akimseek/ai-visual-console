import type { CodexConsoleApi } from "../../shared/codex-console-api";

declare global {
  interface Window {
    codexConsole: CodexConsoleApi;
  }
}

export {};
