# AI 可视化控制台开发指南

## 当前状态

项目是 Electron + React + TypeScript 桌面应用，面向 Codex、Claude Code、Gemini 与 Qoder CN 等 AI CLI，支持本机、PowerShell、Git Bash 和 WSL 目标环境。

当前主线功能已完成以下改造并通过业务回归：

- 会话摘要快速加载、详情按需读取、大型 JSONL 分页和分支上下文保留。
- 会话复制、重命名、归档、回收、恢复和永久删除。
- 本地 Gateway、供应商候选池、排序、余额、模型查询、故障转移与熔断配置。
- Provider 公共 WSL 工具、目标 ID 解析、会话文件边界校验和有限并发搜索。
- Gateway 供应商快照缓存、设置内存缓存、流式 usage 捕获和请求记录。
- IPC 按业务域拆分，终端共用 `useXtermHost`，应用浮层使用统一 `Dialog`。
- 中文与英文 README：`README_CN.md`、`README_EN.md`。

## UI 视觉基线（2026-09）

本轮优先处理界面美观和操作一致性，设计目标是“开发者工作台”，不是营销页面：

- 工作区采用中性浅色背景，终端保持深色高对比表面。
- 使用青绿色作为唯一交互强调色，避免按钮和状态颜色各自发散。
- 使用 `lucide-react` 统一高频操作图标，替换关闭、刷新、附件、发送、缩放、终端标签等字符或手绘 SVG。
- 图标按钮必须保留 `title` 和 `aria-label`，确保鼠标和键盘用户都能理解操作。
- 统一焦点环、悬停、按下和禁用状态；浮层和侧栏使用同一边框、阴影与圆角层级。
- 不改变现有 IPC、会话、Gateway、终端和供应商业务逻辑。

## 关键文件

- `src/renderer/src/styles/app.css`：全局 UI token、布局和组件样式。
- `src/renderer/src/components/icon-button.tsx`：通用图标按钮。
- `src/renderer/src/components/dialog.tsx`：统一弹窗骨架。
- `src/renderer/src/features/terminal/use-xterm-host.ts`：终端公共挂载逻辑。
- `src/renderer/src/features/terminal/composer-input.tsx`：自管输入区与附件操作。
- `src/renderer/src/features/terminal/terminal-tabs.tsx`：AI 终端标签。
- `src/renderer/src/features/terminal/system-terminal.tsx`：系统终端。
- `src/electron/gateway/vendor-registry.ts`：Gateway 供应商快照。
- `src/electron/gateway/gateway-resilience.ts`：供应商健康状态、故障转移和熔断。

## 本地验证

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Windows 侧优先验证 `pnpm test` 和 `pnpm build`。如果 pnpm 报 store location 或原生可选依赖错误，应先统一当前 `node_modules` 使用的 store，再重新执行验证，不要直接删除用户数据目录。

本轮 UI 改造验证结果（Windows，2026-09-05）：

- `pnpm typecheck`：通过。
- `pnpm lint`：通过，0 error、0 warning。
- `pnpm test`：通过，31 个测试文件、212 个测试全部通过。
- `pnpm build`：通过，Vite 和 Electron TypeScript 编译完成。

## UI 第二轮（2026-09-05）

第二轮继续收口开发者工作台的视觉层级，仍只调整渲染层展示与交互反馈，不改动会话、Gateway、终端或供应商业务逻辑：

- 应用菜单为关键动作补充统一图标；退出保留明确的危险态，二级菜单保持原有鼠标与键盘行为。
- 供应商管理弹窗将关闭、刷新、增删改和分页操作改为 Lucide 图标；刷新状态使用图标旋转反馈，保留原有禁用逻辑。
- 供应商表格、候选池开关、工具栏和弹窗边框统一到青绿色强调色与中性表面，不修改列宽拖拽、分页或数据加载逻辑。
- 会话列表使用轻量高亮、左侧强调线和键盘焦点态区分当前会话；不增加字段，避免降低列表扫描速度。
- 状态栏按会话、目录、供应商和用量分组，统一数字对齐并在窄窗口自动隐藏低优先级信息。

本轮完成后必须重新执行完整验证；除自动化检查外，应手动检查菜单展开、供应商表格横向滚动与列宽拖拽、窄窗口状态栏以及会话右键菜单。

第二轮自动化验证结果（Windows，2026-09-05）：

- `pnpm typecheck`：通过。
- `pnpm lint`：通过，0 error、0 warning。
- `pnpm test`：通过，31 个测试文件、212 个测试全部通过。
- `pnpm build`：通过，Vite 生产构建完成。

## 命令面板阶段（2026-09-05）

本轮新增全局命令面板，作为开发者工作台的统一操作入口：

- 命令面板直接递归复用 `app-menus.ts` 中的菜单 action，菜单与快捷入口不维护两套业务逻辑。
- “帮助 > 命令面板”是功能发现入口，菜单项右侧明确显示 `Ctrl + K`；支持 `Ctrl + K`（macOS 使用 `Meta + K`）打开，搜索命令、上下键选择、`Enter` 执行、`Esc` 或点击遮罩关闭。
- 只展示当前可执行的菜单项；禁用项、分隔线和没有 action 的菜单分组不会进入命令列表。
- 原生终端输入模式下不拦截 `Ctrl + K`，保留各 CLI 自身的快捷键行为。
- 命令面板使用中性工作区表面、青绿色交互态和固定结果项高度，保证长命令列表滚动时布局稳定。
- 命令条目超出可视高度时仅列表区域滚动，头部、搜索框和键盘提示始终保留在面板内。

命令面板阶段自动化验证结果（Windows，2026-09-05）：

- `pnpm typecheck`：通过。
- `pnpm lint`：通过，0 error、0 warning。
- `pnpm test`：通过，36 个测试文件、231 个测试全部通过，包含命令面板、工作台 Gateway 统计与异常诊断测试。
- `pnpm build`：通过，Vite 和 Electron TypeScript 编译完成。

## 后续计划

命令面板已稳定后，再推进工作台视图。工作台应复用现有供应商余额、Gateway 状态和会话数据，不引入新的业务状态源。

## 工作台视图（2026-09-05）

工作台作为主工作区的运行概览入口，服务于供应商候选池、Gateway 健康状态和当前会话信息的快速核对：

- 侧栏新增“工作台 / 会话”导航；进入工作台不会修改当前会话列表视图，也不会关闭已打开的终端标签。
- 工作台占用侧栏中原会话列表区域，右侧 `TerminalWorkspace` 始终保持原样显示和挂载，避免 xterm 重建、历史会话恢复或 Gateway 路由丢失。
- 工作台不展示供应商候选池和余额列表，仅展示当前路由供应商、运行目标、当前会话、Token/上下文和当前 Gateway 健康状态。
- 侧栏信息使用 2×2 指标卡布局：图标、字段名、主值与摘要固定分层；长内容截断显示并保留 `title`，避免挤压终端区域。
- 当会话摘要包含 `usage.rateLimits` 时，工作台在指标卡下方展示主/次速率限制窗口；该展示严格复用 JSONL 已解析数据，未提供该字段的 Provider 不显示空卡。
- 工作台不提供新建会话、查看会话或终端状态快捷卡，避免与侧栏会话操作和右侧终端重复。
- 工作台的“今日 Gateway 用量”使用已有 `getGatewayUsageSummary` 读取本地 SQLite 聚合数据，本地零点至当前时刻为统计边界；展示请求数、成功率、故障切换、Token 和费用，挂载、手动刷新及 Gateway 请求落库事件触发时读取，禁止轮询。
- 工作台会在当前终端标签收到 Gateway 路由变更事件后展示最近一次变更的时间、目标供应商与类型（手动切换、故障切换或路由调整）；该状态仅保留在渲染进程内存，关闭标签即释放，不写入候选池或会话数据。
- 工作台的“最近 Gateway 异常”固定查询本地请求日志中最近 3 条 `error`/`timeout` 记录，展示时间、供应商和安全的异常分类。
- “最近 Gateway 异常”可按需打开诊断弹窗：按页查询异常记录，展示时间、供应商、结果、错误代码/错误信息、重试次数与耗时。错误信息来自本地 Gateway 已记录的受控字段，不渲染完整上游响应正文或请求内容。
- 异常结果判断以本地记录的 `outcome` 为准：`error` 始终显示“请求失败”，不能因为上游 HTTP 状态为 200 就覆盖为成功；`timeout` 显示“请求超时”。
- Gateway 即使收到无响应体的 4xx/5xx，也必须按 HTTP 状态记录为 `error`；不能仅因没有响应体而记录为成功。
- “最近 Gateway 异常”详情弹窗使用 SQLite 总数查询加 `LIMIT/OFFSET` 分页，默认每页 10 条；筛选条件变化时保留旧表格并显示加载状态，避免闪屏；弹窗关闭按钮必须在标题栏右上角。
- 异常诊断弹窗支持按供应商和异常类型（失败/超时）筛选；筛选条件在 SQLite 查询层生效，变更筛选后回到第 1 页，不能在渲染层加载全部日志再过滤。
- 异常诊断弹窗支持全部时间、今天、近 7 天、近 30 天和自定义日期范围；日期按本地自然日转换为 ISO 边界后在 SQLite 层过滤，筛选变化回到第 1 页，无效自定义范围不发起查询。
- 工作台不承担会话创建、会话跳转或终端状态展示，保留给运行目标、当前供应商、会话用量与 Gateway 可观测性。当前供应商处于熔断时仅按本次渲染计算并显示剩余时长，其他非健康状态显示最近失败时间；禁止为倒计时新增网络轮询。
- 终端运行态映射仅用于旧工作台状态卡，已移除；终端退出时仍必须通过 `markTerminalExited` 释放标签对应的 terminal ID，随后将原始退出码交给既有 `sessionTabs.handleTerminalExit`，不得改变终端输出、错误提示或关闭标签行为。
- 工作台标题栏显示“上次完整刷新”：健康快照与用量/异常摘要均至少成功读取一次后才显示，取两者较早的成功时间作为完整数据新鲜度下界。刷新图标只在这些既有请求进行时旋转并禁用，禁止为此引入后台轮询。
- Gateway 健康状态通过 `getGatewayVendorHealth()` 在工作台挂载、手动刷新及 Gateway 请求落库事件触发时读取，禁止在渲染端增加轮询。
- Gateway 请求完成并写入 SQLite 后，由主进程向当前窗口发送 `gateway:request-recorded` 事件；工作台以 250ms 窗口合并并发事件后刷新健康、用量和异常摘要，事件只携带供应商、Provider、结果和是否切换等元数据，不携带请求/响应正文。
- 当前供应商必须使用 `useTabVendors` 的标签路由映射，不能以候选池首项推断，避免动态切换后状态误报。
- 新增代码需要保留简洁中文注释，并执行 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 与 `git diff --check`。

继续重构 Provider 基类、Context 或 preload 分域前，必须先证明能够减少实际缺陷或改善可测性；不得仅为了减少文件行数改变已稳定的会话和 Gateway 链路。
