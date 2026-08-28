<div align="center">
  <img src="resources/icon.png" width="88" alt="AI 可视化控制台图标" />
  <h1>AI 可视化控制台</h1>
  <p>把分散在终端里的 AI 工程能力，收束到一个可观测、可切换、可持续的桌面工作台。</p>
  <p>
    <strong>Codex · Claude Code · Gemini · Qoder CN</strong>
  </p>
  <p>
    <a href="#核心能力">核心能力</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="#使用指南">使用指南</a> ·
    <a href="#数据与安全">数据与安全</a>
  </p>
</div>

<p align="center">
  <img src="docs/1.png" width="100%" alt="AI 可视化控制台会话工作台" />
</p>

## 产品定位

AI 可视化控制台是一款面向日常研发工作的跨平台 Electron 桌面应用。它将多个 AI CLI 的会话、终端、历史记录、供应商路由和本地工作环境统一到一个界面中，让你可以在熟悉的桌面工作流里持续推进复杂任务。

它不替代官方 CLI，而是为官方 CLI 提供更高效的工作台：保留原生会话能力，同时补齐会话资产管理、跨环境操作、供应商切换和可观测基础设施。

## 核心能力

### 一个工作台，管理多个 AI CLI

- 统一接入 Codex、Claude Code、Gemini 和 Qoder CN。
- 支持本机、PowerShell、Git Bash 以及多个 WSL 发行版。
- 在平台与目标环境之间快速切换，终端窗口彼此独立。
- 内置 AI 会话终端与系统终端，减少频繁切换窗口的成本。

### 会话是可检索、可恢复的工程资产

- 历史会话以轻量摘要快速呈现，进入工作区无需等待完整 JSONL 解析。
- 详情按需读取，支持分页、全文搜索、Token/上下文信息和导出。
- 支持继续会话、复制、分支、重命名、归档、删除和恢复。
- 大型会话采用流式读取，避免一次性加载全部内容造成界面阻塞。

### 本地 Gateway，供应商切换不打断工作

- 在本地 SQLite 中集中管理 API 地址、API Key、费率和候选池状态。
- 当前请求保持供应商粘性，只有请求异常、供应商关闭或熔断时才切换。
- 支持按排序顺序进行故障转移，并在候选池变更后让下一次请求使用最新快照。
- 支持失败阈值、熔断持续时间和本地监听端口配置。
- 记录请求元数据、响应状态、Token 用量和费用信息，为后续统计与审计提供基础。

### 供应商管理清晰可控

- 表格化展示供应商名称、厂商、余额、排序、创建时间和候选池状态。
- 支持按内容自适应列宽、手动调整、分页和余额刷新。
- 支持新增、编辑、删除和即时启停候选池参与资格。
- 启用或关闭供应商不会关闭当前终端窗口。

### 面向效率的终端体验

- 自管输入框支持模型选择、文件/文件夹附件和多行输入。
- 终端内容搜索快捷键：`Ctrl + F`。
- 右键菜单、复制粘贴、窗口尺寸适配和多标签终端保持一致体验。
- Codex Skill 支持导入、启用、禁用、归档、删除和恢复。

## 界面一览

<table>
  <tr>
    <td width="50%"><img src="docs/2.png" width="100%" alt="本机与 WSL 目标切换" /></td>
    <td width="50%"><img src="docs/6.png" width="100%" alt="供应商管理" /></td>
  </tr>
  <tr>
    <td align="center">本机与 WSL 目标切换</td>
    <td align="center">供应商管理与本地路由</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/3.png" width="100%" alt="Skill 管理" /></td>
    <td width="50%"><img src="docs/4.png" width="100%" alt="系统终端" /></td>
  </tr>
  <tr>
    <td align="center">Skill 管理</td>
    <td align="center">系统终端</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/5.png" width="100%" alt="会话中的代码变更" /></td>
    <td width="50%"></td>
  </tr>
  <tr>
    <td align="center">会话中的代码变更</td>
    <td></td>
  </tr>
</table>

## 快速开始

### 环境要求

- Windows、macOS 或 Linux
- Node.js 20 或更高版本
- pnpm 10.x
- 使用 WSL 时，需要安装至少一个可用的 WSL 发行版
- 使用某个平台前，请先安装对应的官方 CLI；应用也提供 CLI 安装入口

### 安装与启动

```bash
pnpm install --frozen-lockfile
pnpm dev
```

首次启动后，在左侧选择平台和目标环境即可创建会话。应用会自动发现本机与 WSL 目标；目标不可用时，可在“文件 → 设置会话”中补充配置。

### 检查与构建

```bash
# 类型检查、Lint、测试
pnpm typecheck
pnpm lint
pnpm test

# 构建应用
pnpm build

# 生成当前平台安装包
pnpm dist
```

按平台构建安装包：

```bash
pnpm dist:win
pnpm dist:mac
pnpm dist:linux
```

## 使用指南

### 开始或恢复会话

1. 在左侧选择平台和目标环境。
2. 点击“新会话”，或从历史列表打开已有会话。
3. 在终端中继续工作；需要查看完整上下文时打开“详情”。
4. 在详情中搜索消息、查看 Token 信息，或从指定位置创建分支。

历史列表只使用摘要数据启动，完整会话内容在详情或恢复操作触发时按需读取。Qoder CN 使用官方 `qodercn` CLI 和 `~/.qoder-cn` 会话目录，其模型与认证仍由 Qoder CLI 自身管理。

### 管理供应商与路由

1. 打开“工具箱 → 供应商管理”。
2. 新增供应商，填写名称、API 地址、API Key、排序和可选费率。
3. 打开“参与候选池”开关，决定该供应商是否参与 Gateway 故障转移。
4. 在“设置”中配置 Gateway 端口、失败阈值和熔断持续时间。

Gateway 只在请求边界选择供应商。已经发出的请求不会被中途改写；供应商状态或候选池发生变化后，后续请求会读取最新配置。

### 使用 WSL

应用会自动发现 WSL 发行版，并为目标环境使用对应的 CLI 会话目录。若自动探测不到 Codex 目录，可在会话设置中指定 WSL 内的路径，例如 `~/.codex`。

## 数据与安全

- 应用数据保存在应用运行目录的 `data/` 中，供应商和索引信息由 SQLite 管理。
- API Key 保存在本地 SQLite 中，仅由主进程用于 Gateway 上游认证；原始会话正文仍由各官方 CLI 保存在自己的 JSONL 文件中。
- 历史列表缓存只保存摘要、元数据和可重建索引，不保存完整详情正文。
- Gateway 默认只监听 `127.0.0.1`，终端通过独立令牌访问本地路由，避免被其他本地进程直接调用。

## 技术底座

- Electron + React + TypeScript
- SQLite（WAL 模式）
- xterm.js 终端渲染
- 流式 JSONL 读取与分页详情加载
- 本地 Gateway 请求转发、健康状态和故障转移

## 友情链接
[Linux DO](https://linux.do)

## 许可证

本项目使用 [MIT License](LICENSE) 授权。
