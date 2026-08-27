import { listTargets } from "./aiProviders";
import path from "node:path";
import type { CodexTarget } from "./types";

// These variables are set during app initialization in main.ts
let applicationRuntimeRoot: string;

export function setApplicationRuntimeRoot(root: string) {
  applicationRuntimeRoot = root;
}

export function getApplicationRuntimeRoot() {
  return applicationRuntimeRoot;
}

export function getLogDir() {
  return path.join(applicationRuntimeRoot, "logs");
}

export function getApplicationDataDir() {
  return path.join(applicationRuntimeRoot, "data");
}

export async function findTargetForVendor(targetId: string): Promise<CodexTarget | null> {
  const providerId = targetId.startsWith("gemini:")
    ? "gemini"
    : targetId.startsWith("claude:")
      ? "claude"
      : targetId.startsWith("qoder:")
        ? "qoder"
        : "codex";
  const targets = await listTargets(providerId);
  return targets.find((item) => item.id === targetId) || null;
}
