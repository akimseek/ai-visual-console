import type { CodexConsoleApi } from "./types";

declare global {
  interface Window {
    codexConsole: CodexConsoleApi;
  }
}

export {};
