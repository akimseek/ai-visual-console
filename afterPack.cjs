const fs = require("node:fs");
const path = require("node:path");

const ARCH_NAMES = {
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
  4: "universal"
};

module.exports = async function afterPack(context) {
  const nodePtyRoots = findNodePtyRoots(context);
  for (const nodePtyRoot of nodePtyRoots) {
    pruneNodePty(nodePtyRoot, context.electronPlatformName, normalizeArch(context.arch));
  }
};

function findNodePtyRoots(context) {
  const resourcesDirs = [path.join(context.appOutDir, "resources")];
  const appNames = new Set(
    [
      context.packager?.appInfo?.productFilename,
      context.packager?.appInfo?.productName
    ].filter(Boolean)
  );

  for (const appName of appNames) {
    resourcesDirs.push(path.join(context.appOutDir, `${appName}.app`, "Contents", "Resources"));
  }

  if (fs.existsSync(context.appOutDir)) {
    for (const entry of fs.readdirSync(context.appOutDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        resourcesDirs.push(path.join(context.appOutDir, entry.name, "Contents", "Resources"));
      }
    }
  }

  return resourcesDirs
    .map((resourcesDir) => path.join(resourcesDir, "node_modules", "node-pty"))
    .filter((nodePtyRoot) => fs.existsSync(nodePtyRoot));
}

function pruneNodePty(nodePtyRoot, platform, arch) {
  removeIfExists(path.join(nodePtyRoot, "src"));
  removeIfExists(path.join(nodePtyRoot, "scripts"));
  removeIfExists(path.join(nodePtyRoot, "third_party"));
  removeIfExists(path.join(nodePtyRoot, "deps"));
  removeMatching(nodePtyRoot, (filePath) => {
    const name = path.basename(filePath);
    return name.endsWith(".map") || name.endsWith(".pdb") || /\.test\.js$/.test(name);
  });
  prunePrebuilds(path.join(nodePtyRoot, "prebuilds"), platform, arch, nodePtyRoot);
}

function prunePrebuilds(prebuildsRoot, platform, arch, nodePtyRoot) {
  if (!fs.existsSync(prebuildsRoot)) return;

  const entries = fs.readdirSync(prebuildsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const keepNames = expectedPrebuildNames(platform, arch);
  const hasExpected = entries.some((entry) => keepNames.has(entry.name));
  if (!hasExpected && fs.existsSync(path.join(nodePtyRoot, "build", "Release", "pty.node"))) {
    removeIfExists(prebuildsRoot);
    return;
  }
  if (!hasExpected) return;

  for (const entry of entries) {
    if (!keepNames.has(entry.name)) {
      removeIfExists(path.join(prebuildsRoot, entry.name));
    }
  }
}

function expectedPrebuildNames(platform, arch) {
  if (platform === "darwin" && arch === "universal") {
    return new Set(["darwin-x64", "darwin-arm64"]);
  }
  return new Set([`${platform}-${arch}`]);
}

function normalizeArch(arch) {
  return ARCH_NAMES[arch] || String(arch);
}

function removeMatching(root, shouldRemove) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      removeMatching(entryPath, shouldRemove);
      continue;
    }
    if (shouldRemove(entryPath)) {
      removeIfExists(entryPath);
    }
  }
}

function removeIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}
