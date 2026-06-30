#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(process.argv[2] || path.join(os.homedir(), ".claude"));
const maxFiles = Number.parseInt(process.env.CLAUDE_SCAN_MAX_FILES || "2000", 10);
const maxDepth = Number.parseInt(process.env.CLAUDE_SCAN_MAX_DEPTH || "8", 10);
const readBytes = Number.parseInt(process.env.CLAUDE_SCAN_READ_BYTES || String(64 * 1024), 10);
const skipDirectoryNames = new Set(
  (process.env.CLAUDE_SCAN_SKIP_DIRS || "backups,cache,plugins,telemetry")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);

const result = {
  root,
  exists: false,
  scannedAt: new Date().toISOString(),
  limits: {
    maxFiles,
    maxDepth,
    readBytes,
    skipDirectoryNames: [...skipDirectoryNames]
  },
  directories: [],
  files: [],
  errors: []
};

await main();

async function main() {
  try {
    const stat = await fs.stat(root);
    result.exists = stat.isDirectory();
    if (!result.exists) {
      print();
      return;
    }
  } catch (error) {
    result.errors.push(errorMessage(root, error));
    print();
    return;
  }

  await walk(root, 0);
  result.directories.sort((left, right) => left.path.localeCompare(right.path));
  result.files.sort((left, right) => left.path.localeCompare(right.path));
  print();
}

async function walk(dir, depth) {
  if (depth > maxDepth || result.files.length >= maxFiles) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    result.errors.push(errorMessage(dir, error));
    return;
  }

  result.directories.push({
    path: dir,
    relativePath: path.relative(root, dir) || ".",
    depth,
    entryCount: entries.length
  });

  for (const entry of entries) {
    if (result.files.length >= maxFiles) return;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirectoryNames.has(entry.name)) continue;
      await walk(fullPath, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    result.files.push(await inspectFile(fullPath));
  }
}

async function inspectFile(filePath) {
  const stat = await fs.stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const info = {
    path: filePath,
    relativePath: path.relative(root, filePath),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    ext,
    kind: classifyByExtension(ext),
    json: null,
    jsonl: null,
    textPreview: null
  };

  if (!shouldRead(ext, stat.size)) return info;

  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(readBytes, stat.size));
      await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.toString("utf8").replace(/\0/g, "");
      info.textPreview = normalizePreview(text);
      if (ext === ".json") info.json = inspectJson(text);
      if (ext === ".jsonl") info.jsonl = inspectJsonl(text);
    } finally {
      await handle.close();
    }
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error);
  }

  return info;
}

function inspectJson(text) {
  try {
    const parsed = JSON.parse(text);
    return summarizeValue(parsed);
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : String(error)
    };
  }
}

function inspectJsonl(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 20);
  const records = [];
  for (const line of lines) {
    try {
      records.push(summarizeValue(JSON.parse(line)));
    } catch (error) {
      records.push({
        parseError: error instanceof Error ? error.message : String(error),
        preview: line.slice(0, 160)
      });
    }
  }
  return {
    sampledLines: lines.length,
    records
  };
}

function summarizeValue(value) {
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      first: value.length > 0 ? summarizeValue(value[0]) : null
    };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return {
      type: "object",
      keys: entries.map(([key]) => key).slice(0, 40),
      sample: Object.fromEntries(entries.slice(0, 12).map(([key, item]) => [key, summarizePrimitive(item)]))
    };
  }
  return {
    type: typeof value,
    value: summarizePrimitive(value)
  };
}

function summarizePrimitive(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 120)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return `[array:${value.length}]`;
  if (typeof value === "object") return `{object:${Object.keys(value).slice(0, 12).join(",")}}`;
  return typeof value;
}

function normalizePreview(text) {
  return text
    .split(/\r?\n/)
    .slice(0, 8)
    .join("\n")
    .slice(0, 1000);
}

function classifyByExtension(ext) {
  if (ext === ".json") return "json";
  if (ext === ".jsonl") return "jsonl";
  if (ext === ".sqlite" || ext === ".db") return "database";
  if (ext === ".log" || ext === ".txt" || ext === ".md") return "text";
  return ext ? ext.slice(1) : "unknown";
}

function shouldRead(ext, size) {
  if (size <= 0) return false;
  if (size > 10 * 1024 * 1024) return false;
  return [".json", ".jsonl", ".log", ".txt", ".md", ""].includes(ext);
}

function errorMessage(filePath, error) {
  return {
    path: filePath,
    message: error instanceof Error ? error.message : String(error)
  };
}

function print() {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
