# AI 可视化控制台

AI 可视化控制台是一款跨平台 Electron 桌面应用，用于集中管理和操作 Codex、Gemini、Claude Code、Qoder CN 等 CLI 会话。

它把会话列表、历史恢复、分支、搜索、终端和供应商配置整合在一个工作台中，同时支持本机与 WSL 环境。

## 截图

### 会话工作台

浏览历史会话、查看摘要，并在右侧终端中继续当前会话。

![会话工作台](docs/1.png)

### 本机与 WSL 目标

在本机和多个 WSL 发行版之间切换，分别管理对应环境中的 CLI 会话。

![本机与 WSL 目标](docs/2.png)

### Skill 管理

查看、导入、启用、禁用和删除 Codex Skill。

![Skill 管理](docs/3.png)

### 系统终端

在工作区中打开独立系统终端，支持本机 Shell、PowerShell、CMD、Git Bash 和 WSL。

![系统终端](docs/4.png)

### 会话中的代码变更

在 CLI 会话中直接查看代码修改、执行状态和终端输出。

![会话中的代码变更](docs/5.png)

### 供应商管理

保存多个 API 供应商，写入对应 CLI 配置，并在同一协议的已打开终端中切换请求路由。

![供应商管理](docs/6.png)

## 功能特性

- 支持 Codex、Gemini、Claude Code 和 Qoder CN 会话
- 支持本机与 WSL 目标自动探测和切换
- 历史会话列表使用轻量摘要加载，详情按需读取
- 支持继续会话；Codex、Gemini 和 Claude Code 支持创建分支、复制会话、删除和恢复
- 详情页支持分页加载、全文搜索、Token/上下文信息和会话导出
- 支持多个 API 供应商的新增、编辑、启用和删除
- 通过本地 Gateway 在同一终端会话中切换供应商
- 支持 Codex Skill 的导入、启用、禁用、删除和恢复
- 内置 AI 会话终端和系统终端
- 支持终端内容搜索：`Ctrl + F`
- Claude Code、Gemini 和 Qoder CN 使用流式 JSONL 读取，降低大文件加载开销
- SQLite 保存摘要、元数据和可重建索引，不缓存完整会话正文

## 支持环境

- Windows、Linux、macOS
- Node.js 20 或更高版本
- pnpm 10.x
- Windows 下使用 WSL 功能时，需要安装可用的 WSL 发行版

## 快速开始

### 安装依赖

```bash
pnpm install --frozen-lockfile
```

请使用 `pnpm` 管理依赖，不要将 `npm install` 与本项目混用。Windows、WSL、macOS 和 Linux 应在各自环境中分别安装依赖，以获得正确的平台原生依赖。

### 启动开发环境

```bash
pnpm dev
```

### 运行检查

```bash
pnpm typecheck
pnpm lint
pnpm test
```

### 构建与打包

```bash
# 仅构建应用
pnpm build

# 生成当前平台的 unpacked 应用
pnpm pack

# 生成安装包
pnpm dist
```

也可以按目标平台打包：

```bash
pnpm dist:win
pnpm dist:mac
pnpm dist:linux
```

## 使用说明

### 会话管理

1. 选择平台和目标环境。
2. 在会话列表中打开历史会话，或点击“新会话”。
3. 使用“详情”查看完整消息、分支关系和会话信息。
4. 在详情页创建分支或继续当前会话。

历史会话进入工作区时只加载列表摘要；完整 JSONL 会在打开详情或恢复会话时按需读取。

Qoder CN 使用其官方 `qodercn` CLI 和 `~/.qoder-cn` 会话目录。Qoder 的模型、认证和 BYOK 配置由 CLI 内的 `/model` 管理，不经过本地 Gateway；分支、复制和回收站操作也保留在 Qoder CLI 内执行。

### 供应商切换

在“供应商管理”中保存多个同协议供应商，启用其中一个后：

- 新终端使用当前启用的供应商。
- 已接入本地 Gateway 的终端会在后续请求中切换路由。
- 已经发出的请求继续使用请求开始时的供应商。
- 由旧版本创建的终端需要关闭并重新打开一次，才能接入本地 Gateway。

### WSL

应用会自动发现 WSL 发行版。若 Codex 目录未自动识别，可在“文件 → 设置会话”中手动设置 WSL 内的 Codex 目录，例如 `~/.codex`。

## 数据与隐私

- 应用数据保存在项目或应用数据目录下的 `data/` 中。
- SQLite 数据库保存供应商信息、会话摘要、元数据和索引，不保存完整会话正文缓存。
- API Key 在系统支持时使用 Electron `safeStorage` 加密后保存。
- 原始会话仍由各 CLI 保存在自己的 JSONL 文件中。
- CLI 配置仍写入对应运行环境的 `~/.codex`、`~/.gemini`、`~/.claude` 和 `~/.qoder-cn`。
- 本地 Gateway 只监听 `127.0.0.1`，用于在终端进程与供应商接口之间转发请求。

## 项目结构

```text
src/electron     Electron 主进程、Provider、终端、配置和会话处理
src/renderer     React 渲染进程与界面组件
src/shared       共享类型、解析器和通用工具
docs             项目截图与 Provider 开发文档
scripts          构建和辅助脚本
resources        应用图标与打包资源
```

## 开发 Provider

Provider 相关实现位于 `src/electron/`，可以从以下文件开始了解：

- [`src/electron/aiProviders.ts`](src/electron/aiProviders.ts)：Provider 注册与统一入口
- [`src/electron/claudeProvider.ts`](src/electron/claudeProvider.ts)：Claude Code 会话实现
- [`src/electron/geminiProvider.ts`](src/electron/geminiProvider.ts)：Gemini 会话实现
- [`src/electron/qoderProvider.ts`](src/electron/qoderProvider.ts)：Qoder CN 会话实现
- [`src/electron/codexTargets.ts`](src/electron/codexTargets.ts)：Codex 本机与 WSL 目标实现

共享类型、解析器和路径工具位于 `src/shared/`。新增 Provider 时，请同时补充对应的类型、目标探测、会话读取和测试。

## 许可证

本项目使用 [MIT License](LICENSE) 授权。
