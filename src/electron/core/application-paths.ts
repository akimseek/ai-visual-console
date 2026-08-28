import path from "node:path";

type RuntimeStorageRootOptions = {
  isPackaged: boolean;
  executablePath: string;
  cwd: string;
  platform: NodeJS.Platform;
};

export function resolveRuntimeStorageRoot({
  isPackaged,
  executablePath,
  cwd,
  platform
}: RuntimeStorageRootOptions) {
  if (!isPackaged) return cwd;
  const pathApi = platform === "win32" ? path.win32 : path;
  const executableDir = pathApi.dirname(executablePath);
  if (isUnpackedBuildDirectory(executableDir, platform)) return pathApi.dirname(executableDir);
  return executableDir;
}

function isUnpackedBuildDirectory(directory: string, platform: NodeJS.Platform) {
  const pathApi = platform === "win32" ? path.win32 : path;
  const name = pathApi.basename(directory).toLowerCase();
  if (platform === "win32") return name === "win-unpacked";
  if (platform === "linux") return name === "linux-unpacked";
  return false;
}
