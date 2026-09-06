import { defineConfig } from "vite";

// 沙箱 preload 只能可靠执行单文件脚本；分域源码仍保留在 src/electron/preload 目录中，构建时统一合并。
export default defineConfig({
  build: {
    lib: {
      entry: "src/electron/preload.ts",
      formats: ["cjs"],
      fileName: () => "preload.js"
    },
    outDir: "dist/electron",
    emptyOutDir: false,
    rollupOptions: {
      // Electron 运行时提供该模块，不能被 Vite 打进 bundle。
      external: ["electron"]
    }
  }
});
