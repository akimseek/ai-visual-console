# AI 可视化控制台

一款用于浏览、恢复、删除、分支和继续 AI/Codex 会话的跨平台 Electron 桌面工具。

## 功能

- 浏览本机与 WSL 下的 Codex / Gemini / Claude 会话
- 打开历史会话、继续会话、创建分支会话
- 删除、恢复、彻底删除与批量操作
- 会话详情、分支关系、全文搜索、会话导出
- Token / 上下文信息展示与压缩提示词复制
- 供应商管理：写入各 AI CLI 配置文件并切换启用状态
- CLI 安装：检测 Node / nvm / CLI 状态并引导安装
- 右侧终端区支持 AI 会话终端与系统终端
- WSL 会话目录手动设置与自动探测切换

## 环境要求

- Node.js 20+，推荐使用项目内 CLI 安装流程检测后的版本
- pnpm 10.x
- Windows / Linux / macOS
- Windows 下如需 WSL 功能，请确保已安装并可用的 WSL 发行版

## 安装

```bash
pnpm install
```

## 开发

```bash
pnpm dev
```

## 测试

```bash
pnpm test
pnpm lint
pnpm typecheck
```

## 打包

### Windows

```bash
pnpm dist:win
```

### macOS

```bash
pnpm dist:mac
```

### Linux

```bash
pnpm dist:linux
```

## 脚本

见 `package.json` 中的 `scripts`。

## 项目结构

- `src/electron` - Electron 主进程、Provider、终端、配置和会话处理
- `src/renderer` - React 视图层与 UI 组件
- `src/shared` - 主进程与渲染进程共享类型、解析器和工具函数
- `docs` - Provider 接入、调研与说明文档
- `scripts` - 辅助脚本
- `resources` - 应用图标与打包资源

## 本地数据

- 供应商管理数据、会话索引缓存、分支元数据、工作目录预设和压缩提示词保存在 Electron `userData/app.db`
- API Key 会在系统支持时通过 Electron `safeStorage` 加密后写入 SQLite
- 原始 AI 会话仍保存在各 CLI 自己的 JSONL 文件中，SQLite 只保存可重建的索引缓存
- CLI 原生配置文件仍写入对应运行环境的 `~/.codex`、`~/.gemini`、`~/.claude`

## 新增 AI Provider

新增 Provider 前请先阅读：

- `docs/provider-development.md`
- `docs/exampleProvider.template.ts`

## WSL 说明

- 应用会自动识别可用 WSL 发行版
- 需要手动设置 WSL 内 Codex 目录时，可通过菜单：

```text
文件 -> 设置会话
```

- 默认工作目录为 `~/.akim`
- 若目录不存在，应用会提示重新选择工作目录

## 许可证

MIT
