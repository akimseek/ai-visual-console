import { listTargets } from "../providers/ai-providers";
import path from "node:path";
import type { CodexTarget } from "../types";
import { getProviderIdFromTargetId } from "../../shared/target-ids";

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
  const providerId = getProviderIdFromTargetId(targetId);
  const targets = await listTargets(providerId);
  return targets.find((item) => item.id === targetId) || null;
}
