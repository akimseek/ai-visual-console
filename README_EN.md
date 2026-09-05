<div align="center">
  <img src="resources/icon.png" width="96" alt="AI Visual Console logo" />
  <h1>AI Visual Console</h1>
  <p>A continuous desktop workspace for AI CLIs, session assets, terminal environments, and local routing.</p>
  <p><strong>Codex · Claude Code · Gemini · Qoder CN</strong></p>
  <p><a href="README.md">Home</a> · <a href="README_CN.md">简体中文</a></p>
</div>

<p align="center">
  <img src="docs/1.png" width="100%" alt="AI Visual Console workspace" />
</p>

## Why AI Visual Console

AI Visual Console is a cross-platform Electron desktop application for day-to-day AI-assisted development. It does not replace official CLIs. Instead, it builds a unified workspace around them: organize sessions, switch execution environments, manage terminals, and configure providers while retaining the native behavior of each CLI.

Complex work should not be scattered across terminal windows, session files, WSL distributions, and provider configurations. AI Visual Console turns those elements into recoverable, searchable, manageable engineering assets.

## Core Capabilities

### One Workspace for Multiple AI CLIs

- Supports Codex, Claude Code, Gemini, and Qoder CN in one application.
- Works with local environments, PowerShell, Git Bash, and multiple WSL distributions.
- Switch platforms and targets independently without interrupting other active terminal tabs.
- Includes both AI-session terminals and system terminals.

### Sessions as Engineering Assets

- Loads the history list from lightweight summaries instead of parsing every JSONL file at startup.
- Reads the latest session file only when details are requested, with paged loading for large sessions.
- Supports resuming, search, duplicate, branch, rename, archive, restore, and permanent deletion.
- Branches created from a selected message retain the correct historical context.

### Local Gateway and Provider Routing

- Stores provider endpoints, API keys, ordering, rates, and candidate-pool state in local SQLite.
- Selects a provider at the request boundary; an in-flight request is never rerouted midway.
- Fails over according to candidate order and excludes disabled, unhealthy, or circuit-broken providers.
- Applies candidate-pool changes to subsequent requests without closing the current terminal.
- Configures the Gateway listener port, failure threshold, and circuit-break duration locally.

### Terminal Interaction Built for Flow

- Managed composer with model selection, file or folder attachments, and `Alt + Enter` multiline input.
- Terminal search, copy, paste, context menus, responsive sizing, and multi-tab workflows.
- Model discovery from provider APIs and provider-specific balance refresh.
- Codex Skill import, enable, disable, archive, delete, and restore.

## Product Tour

| Multiple Targets | Provider Management |
| --- | --- |
| <img src="docs/2.png" alt="Local and WSL target switching" /> | <img src="docs/6.png" alt="Provider management and local routing" /> |
| Skill Management | System Terminal |
| <img src="docs/3.png" alt="Skill management" /> | <img src="docs/4.png" alt="System terminal" /> |
| Code Changes in a Session | AI Workspace |
| <img src="docs/5.png" alt="Code changes in a session" /> | <img src="docs/1.png" alt="AI session workspace" /> |

## Quick Start

### Prerequisites

- Windows, macOS, or Linux
- Node.js 20 or later
- pnpm 10.x
- At least one usable WSL distribution when working with WSL
- The official CLI for each platform you intend to use; the app also provides CLI installation entry points

### Run Locally

```bash
pnpm install --frozen-lockfile
pnpm dev
```

After the first launch, select a platform and target on the left to start a session. The application discovers local and WSL targets; paths and related settings can be supplied in Session Settings when automatic discovery is unavailable.

### Validate and Build

```bash
# Type checks, lint, and tests
pnpm typecheck
pnpm lint
pnpm test

# Build the application
pnpm build

# Package for a platform
pnpm dist:win
pnpm dist:mac
pnpm dist:linux
```

## How It Works

### Start or Resume a Session

1. Choose a platform and target in the left sidebar.
2. Create a new session or open an item from history.
3. Continue in the terminal; open Details only when you need the full context.
4. Search messages, inspect token information, or create a branch from a selected point in Details.

The history list uses only summary and index data. Full content is loaded only for Details or session resume. Qoder CN uses the official `qodercn` CLI and its `~/.qoder-cn` session directory; model and authentication management remain owned by Qoder CLI.

### Configure Providers and Local Routing

1. Open **Toolbox → Provider Management**.
2. Add a provider with its name, endpoint, API key, order, and optional rates.
3. Enable **Join candidate pool** to allow it to participate in failover.
4. Open **File → Settings** to configure the Gateway port, failure threshold, and circuit-break duration.

The Gateway decides routing only when a request starts. It does not rewrite an active request. Provider or candidate-pool changes are applied to the next request.

### Work with WSL

The application discovers WSL distributions and invokes each CLI with the matching WSL session directory. If automatic discovery cannot find a path, specify the Linux-side path in Session Settings, such as `~/.codex` for Codex.

## Data and Security

- Application data is stored under the runtime `data/` directory; providers, indexes, and settings use local SQLite.
- API keys are used only by the main-process local Gateway for upstream authentication. Session bodies stay in the JSONL files managed by their respective official CLIs.
- History caching keeps summaries, metadata, and rebuildable indexes, not full session-detail bodies.
- The Gateway listens on `127.0.0.1` by default, and terminals access it with an isolated token.

## Technology

- Electron, React, and TypeScript
- SQLite with WAL mode
- xterm.js terminal rendering
- Streaming JSONL reads and paged detail loading
- Local Gateway, health state, and failover

## License

Released under the [MIT License](LICENSE).
