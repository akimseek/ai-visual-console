import { useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { TerminalSearchBar } from "./TerminalSearchBar";
import type { SystemTerminalKind } from "./types";
import { useTerminalSearch } from "./useTerminalSearch";

type SystemTerminalTab = {
  key: string;
  title: string;
  kind: SystemTerminalKind;
  targetId?: string;
  cwd?: string;
};

type SystemTerminalProps = {
  targetId?: string;
  cwd?: string;
  minimized: boolean;
  createSignal: number;
  onClose: () => void;
  onToggleMinimized: () => void;
};

const STORAGE_HEIGHT_KEY = "ai-console.system-terminal.height";
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 180;
const MAX_HEIGHT_RATIO = 0.72;

export function SystemTerminal({ targetId, cwd, minimized, createSignal, onClose, onToggleMinimized }: SystemTerminalProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [tabs, setTabs] = useState<SystemTerminalTab[]>([]);
  const [activeKey, setActiveKey] = useState("");
  const [terminalIndex, setTerminalIndex] = useState(1);
  const [selectedKind, setSelectedKind] = useState<SystemTerminalKind>(() => defaultTerminalKind(targetId));
  const [kindMenuOpen, setKindMenuOpen] = useState(false);
  const [height, setHeight] = useState(() => readStoredHeight());
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tabKey: string } | null>(null);
  const resizeStateRef = useRef<{ y: number; height: number } | null>(null);

  const activeTab = tabs.find((tab) => tab.key === activeKey) || tabs[0] || null;
  const availableKinds = useMemo(() => terminalKindOptions(targetId), [targetId]);

  const lastCreateSignalRef = useRef(createSignal);

  useEffect(() => {
    if (availableKinds.some((item) => item.kind === selectedKind)) return;
    setSelectedKind(defaultTerminalKind(targetId));
  }, [availableKinds, selectedKind, targetId]);

  useEffect(() => {
    if (lastCreateSignalRef.current === createSignal && tabs.length > 0) return;
    lastCreateSignalRef.current = createSignal;
    openTab(defaultTerminalKind(targetId));
    // 信号驱动：仅在 createSignal 递增时新建标签，其余依赖会误触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSignal]);

  function openTab(kind = selectedKind) {
    const index = terminalIndex;
    const key = `system:${Date.now()}:${index}`;
    setTerminalIndex(index + 1);
    const title = `${terminalKindLabel(kind)} ${index}`;
    setTabs((current) => [...current, { key, title, kind, targetId, cwd }]);
    setActiveKey(key);
  }

  function closeTab(key: string) {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.key === key);
      const next = current.filter((tab) => tab.key !== key);
      if (activeKey === key) {
        const fallback = next[Math.max(0, index - 1)] || next[0] || null;
        setActiveKey(fallback?.key || "");
      }
      if (next.length === 0) onClose();
      return next;
    });
  }

  function closeOtherTabs(key: string) {
    setTabs((current) => {
      const kept = current.find((tab) => tab.key === key);
      if (!kept) return current;
      setActiveKey(key);
      return [kept];
    });
  }

  function closeAllTabs() {
    setTabs([]);
    setActiveKey("");
    onClose();
  }

  function openTabContextMenu(event: React.MouseEvent<HTMLElement>, tabKey: string) {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 132;
    const menuHeight = 104;
    const gap = 8;
    const x = Math.min(event.clientX, window.innerWidth - menuWidth - gap);
    const y = Math.min(event.clientY, window.innerHeight - menuHeight - gap);
    setTabContextMenu({ x: Math.max(gap, x), y: Math.max(gap, y), tabKey });
  }

  function startResize(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    resizeStateRef.current = { y: event.clientY, height };
    window.addEventListener("mousemove", onResizeMove);
    window.addEventListener("mouseup", stopResize, { once: true });
  }

  function onResizeMove(event: MouseEvent) {
    const state = resizeStateRef.current;
    if (!state) return;
    const nextHeight = clamp(state.height + state.y - event.clientY, MIN_HEIGHT, maxTerminalHeight(panelRef.current));
    setHeight(nextHeight);
  }

  function stopResize() {
    window.removeEventListener("mousemove", onResizeMove);
    resizeStateRef.current = null;
  }

  useEffect(() => {
    window.localStorage.setItem(STORAGE_HEIGHT_KEY, String(height));
  }, [height]);

  useEffect(() => {
    const clampHeight = () => setHeight((current) => clamp(current, MIN_HEIGHT, maxTerminalHeight(panelRef.current)));
    window.addEventListener("resize", clampHeight);
    return () => window.removeEventListener("resize", clampHeight);
  }, []);

  useEffect(() => {
    if (!kindMenuOpen) return;
    const close = () => setKindMenuOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKeyDown);
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [kindMenuOpen]);

  useEffect(() => {
    if (!tabContextMenu) return;
    const close = () => setTabContextMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKeyDown);
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [tabContextMenu]);

  return (
    <section ref={panelRef} className={`system-terminal ${minimized ? "minimized" : ""}`} style={{ flexBasis: minimized ? undefined : `${height}px` }}>
      <div className="system-terminal-resize" role="separator" aria-orientation="horizontal" onMouseDown={startResize} />
      <header>
        <div className="system-terminal-tabs" role="tablist" aria-label="系统终端">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={tab.key === activeKey ? "active" : ""}
              title={tab.title}
              onContextMenu={(event) => openTabContextMenu(event, tab.key)}
              onClick={() => setActiveKey(tab.key)}
            >
              <span>{tab.title}</span>
              <strong
                role="button"
                tabIndex={0}
                title="关闭"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.key);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  closeTab(tab.key);
                }}
              >
                x
              </strong>
            </button>
          ))}
        </div>
        <div className="system-terminal-actions">
          <div className="system-terminal-kind" onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" className="system-terminal-kind-trigger" onClick={() => setKindMenuOpen((current) => !current)}>
              {terminalKindOptionLabel(availableKinds, selectedKind)}
            </button>
            {kindMenuOpen && (
              <div className="system-terminal-kind-menu" role="menu">
                {availableKinds.map((item) => (
                  <button
                    key={item.kind}
                    type="button"
                    className={item.kind === selectedKind ? "active" : ""}
                    role="menuitem"
                    onClick={() => {
                      setSelectedKind(item.kind);
                      setKindMenuOpen(false);
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" onClick={() => openTab(selectedKind)}>
            新建
          </button>
          <button type="button" onClick={onToggleMinimized}>
            {minimized ? "展开" : "最小化"}
          </button>
          <button type="button" onClick={onClose}>
            关闭面板
          </button>
        </div>
      </header>
      <div className="system-terminal-stack">
        {tabs.map((tab) => (
          <SystemTerminalPane
            key={tab.key}
            tab={tab}
            active={activeTab?.key === tab.key && !minimized}
            hidden={activeTab?.key !== tab.key || minimized}
          />
        ))}
      </div>
      {tabContextMenu && (
        <div
          className="terminal-context-menu terminal-tab-menu"
          style={{ left: `${tabContextMenu.x}px`, top: `${tabContextMenu.y}px` }}
          role="menu"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => {
            closeTab(tabContextMenu.tabKey);
            setTabContextMenu(null);
          }}>
            关闭
          </button>
          <button type="button" role="menuitem" disabled={tabs.length <= 1} onClick={() => {
            closeOtherTabs(tabContextMenu.tabKey);
            setTabContextMenu(null);
          }}>
            关闭其他
          </button>
          <button type="button" role="menuitem" disabled={tabs.length === 0} onClick={() => {
            closeAllTabs();
            setTabContextMenu(null);
          }}>
            关闭所有
          </button>
        </div>
      )}
    </section>
  );
}

function SystemTerminalPane({ tab, active, hidden }: { tab: SystemTerminalTab; active: boolean; hidden: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; canCopy: boolean } | null>(null);
  const search = useTerminalSearch({ restoreFocus: () => terminalRef.current?.focus() });

  function copyCurrentSelection() {
    const selection = terminalRef.current?.getSelection();
    if (!selection) return false;
    void window.codexConsole.copyText(selection);
    setContextMenu(null);
    return true;
  }

  async function pasteClipboardText() {
    const text = await window.codexConsole.readText();
    if (!text || !terminalIdRef.current) return;
    terminalRef.current?.paste(text);
    setContextMenu(null);
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10000,
      theme: {
        background: "#111827",
        foreground: "#e5e7eb",
        cursor: "#f9fafb"
      }
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    const detachSearchAddon = search.attachAddon(searchAddon, terminal);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    terminal.open(host);
    fitAddon.fit();

    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "c" &&
        terminal.hasSelection()
      ) {
        const selection = terminal.getSelection();
        if (selection) void window.codexConsole.copyText(selection);
        return false;
      }
      if (
        event.type === "keydown" &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "v"
      ) {
        void pasteClipboardText();
        return false;
      }
      return true;
    });

    let outputBuffer = "";
    let outputFrame = 0;
    let resizeFrame = 0;

    function flushOutput() {
      outputFrame = 0;
      if (!outputBuffer) return;
      const data = outputBuffer;
      outputBuffer = "";
      terminal.write(data);
    }

    function writeTerminalOutput(data: string) {
      outputBuffer += data;
      if (!outputFrame) outputFrame = requestAnimationFrame(flushOutput);
    }

    function fitTerminal() {
      fitAddon.fit();
      if (terminalIdRef.current) {
        void window.codexConsole.resizeTerminal(terminalIdRef.current, terminal.cols, terminal.rows);
      }
    }

    function scheduleFitTerminal() {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        fitTerminal();
      });
    }

    const resizeObserver = new ResizeObserver(scheduleFitTerminal);
    resizeObserver.observe(host);

    const onContextMenu = (event: Event) => {
      event.preventDefault();
      const mouseEvent = event as MouseEvent;
      setContextMenu({
        x: mouseEvent.clientX,
        y: mouseEvent.clientY,
        canCopy: terminal.hasSelection()
      });
    };
    host.addEventListener("contextmenu", onContextMenu);

    const dataDisposable = terminal.onData((data) => {
      if (terminalIdRef.current) void window.codexConsole.writeTerminal(terminalIdRef.current, data);
    });
    const removeDataListener = window.codexConsole.onTerminalData((terminalId, data) => {
      if (terminalId !== terminalIdRef.current) return;
      writeTerminalOutput(data);
    });
    const removeExitListener = window.codexConsole.onTerminalExit((terminalId, exitCode) => {
      if (terminalId !== terminalIdRef.current) return;
      flushOutput();
      terminal.writeln("");
      terminal.writeln(`终端已退出，退出码 ${exitCode}`);
      terminalIdRef.current = "";
    });

    void window.codexConsole
      .startSystemTerminal({
        targetId: tab.targetId,
        kind: tab.kind,
        cwd: tab.cwd,
        cols: terminal.cols,
        rows: terminal.rows
      })
      .then(({ terminalId }) => {
        if (disposed) {
          void window.codexConsole.stopTerminal(terminalId);
          return;
        }
        terminalIdRef.current = terminalId;
      })
      .catch((error: any) => {
        if (disposed) return;
        terminal.writeln(error?.message || "启动终端失败。");
      });

    return () => {
      disposed = true;
      const terminalId = terminalIdRef.current;
      terminalIdRef.current = "";
      if (terminalId) void window.codexConsole.stopTerminal(terminalId);
      removeDataListener();
      removeExitListener();
      dataDisposable.dispose();
      resizeObserver.disconnect();
      if (outputFrame) cancelAnimationFrame(outputFrame);
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      host.removeEventListener("contextmenu", onContextMenu);
      detachSearchAddon();
      searchAddon.dispose();
      fitAddon.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // tab.key 是终端身份；纳入 tab.cwd/kind 会销毁并重建该标签的终端
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.key]);

  useEffect(() => {
    if (!active) return;
    setTimeout(() => {
      fitAddonRef.current?.fit();
      terminalRef.current?.focus();
    }, 0);
  }, [active]);

  return (
    <div className={`system-terminal-pane ${hidden ? "hidden" : ""}`} onKeyDownCapture={search.onPanelKeyDownCapture}>
      <div className="system-terminal-host" ref={hostRef} />
      {search.open && !hidden && (
        <TerminalSearchBar
          inputRef={search.inputRef}
          query={search.query}
          caseSensitive={search.caseSensitive}
          wholeWord={search.wholeWord}
          result={search.result}
          onQueryChange={search.setQuery}
          onCaseSensitiveChange={search.setCaseSensitive}
          onWholeWordChange={search.setWholeWord}
          onNext={search.findNext}
          onPrevious={search.findPrevious}
          onClose={search.closeSearch}
        />
      )}
      {contextMenu && !hidden && (
        <div
          className="terminal-context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          role="menu"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" disabled={!contextMenu.canCopy} onClick={copyCurrentSelection}>
            复制
          </button>
          <button type="button" role="menuitem" disabled={!terminalIdRef.current} onClick={() => void pasteClipboardText()}>
            粘贴
          </button>
        </div>
      )}
    </div>
  );
}

function defaultTerminalKind(targetId?: string): SystemTerminalKind {
  if (isWslTarget(targetId)) return "wsl";
  return "auto";
}

function terminalKindOptions(targetId?: string): Array<{ kind: SystemTerminalKind; label: string }> {
  const options: Array<{ kind: SystemTerminalKind; label: string }> = [{ kind: "auto", label: "默认" }];
  if (navigator.platform.toLowerCase().includes("win")) {
    options.push(
      { kind: "powershell", label: "PowerShell" },
      { kind: "cmd", label: "CMD" },
      { kind: "git-bash", label: "Git Bash" },
      { kind: "wsl-default", label: "默认 WSL" }
    );
  } else {
    options.push({ kind: "bash", label: "bash" }, { kind: "zsh", label: "zsh" }, { kind: "fish", label: "fish" });
  }
  if (isWslTarget(targetId)) options.push({ kind: "wsl", label: "当前 WSL" });
  return options;
}

function terminalKindLabel(kind: SystemTerminalKind) {
  if (kind === "powershell") return "PowerShell";
  if (kind === "cmd") return "CMD";
  if (kind === "git-bash") return "Git Bash";
  if (kind === "wsl") return "WSL";
  if (kind === "wsl-default") return "WSL";
  if (kind === "bash") return "bash";
  if (kind === "zsh") return "zsh";
  if (kind === "fish") return "fish";
  return "终端";
}

function terminalKindOptionLabel(options: Array<{ kind: SystemTerminalKind; label: string }>, kind: SystemTerminalKind) {
  return options.find((item) => item.kind === kind)?.label || terminalKindLabel(kind);
}

function isWslTarget(targetId?: string) {
  return Boolean(targetId?.startsWith("wsl:") || targetId?.startsWith("gemini:wsl:") || targetId?.startsWith("claude:wsl:"));
}

function readStoredHeight() {
  const value = Number(window.localStorage.getItem(STORAGE_HEIGHT_KEY));
  return Number.isFinite(value) ? clamp(value, MIN_HEIGHT, maxTerminalHeight(null)) : DEFAULT_HEIGHT;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function maxTerminalHeight(panel: HTMLElement | null) {
  const parentHeight = panel?.parentElement?.clientHeight || window.innerHeight;
  return Math.max(260, Math.floor(parentHeight * MAX_HEIGHT_RATIO));
}
