import fs from "node:fs/promises";

// 清理上一次构建产物，避免已经移除的 preload 分域文件继续被打包。
await fs.rm("dist", { recursive: true, force: true });
