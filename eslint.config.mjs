import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// 扁平配置：基础 JS + typescript-eslint 推荐规则 + React Hooks 规则。
// 目标是自动化捕获“未使用导入/变量”“Hook 误用/依赖缺失”等问题，而非强制代码风格。
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "release/**",
      "node_modules/**",
      "docs/**", // Provider 骨架模板，故意保留未使用形参
      "scripts/**",
      "**/*.d.ts",
      "afterPack.cjs"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 通用规则调整（应用于所有被检查文件）
    rules: {
      // 终端 ANSI 处理需要 \x1b 等控制字符，属正常用法
      "no-control-regex": "off",
      // 代码库在 catch 中大量使用 `error: any`；隐式 any 仍由 tsc 把关
      "@typescript-eslint/no-explicit-any": "off",
      // 重点诉求：暴露未使用的导入与变量（警告级，不阻断）；下划线前缀与 catch 形参豁免
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }
      ]
    }
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  }
);
