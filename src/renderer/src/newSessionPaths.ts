import type { AiTarget } from "./types";

export function normalizeChosenDirectory(filePath: string, target?: AiTarget) {
  if (target?.kind === "wsl") return windowsPathToWslPath(filePath);
  return filePath;
}

export function windowsPathToWslPath(filePath: string) {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(filePath);
  if (!match) return filePath.replace(/\\/g, "/");
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}
