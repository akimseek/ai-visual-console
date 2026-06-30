import { useEffect, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type EmbeddedTerminalProps = {
  targetId: string;
  sessionId?: string;
  cwd?: string;
  codexHome?: string;
  useCodexCwdFlag?: boolean;
  prompt?: string;
  cliArgs?: string;
  title: string;
  active: boolean;
  requestedInputMode?: "composer" | "terminal";
  onReady?: (terminalId?: string) => void;
  onExit?: (exitCode: number) => void;
  onInputModeChange?: (state: { mode: "composer" | "terminal"; composerVisible: boolean }) => void;
};

type PastedContentBlock = {
  marker: string;
  text: string;
};

const COMPACT_PASTE_MIN_CHARS = 1000;
const COMPACT_PASTE_MIN_LINES = 20;
const COMPOSER_MIN_HEIGHT = 54;
const COMPOSER_MAX_HEIGHT = 240;
const COMPOSER_DEFAULT_HEIGHT = 64;

export function EmbeddedTerminal({
  targetId,
  sessionId,
  cwd,
  codexHome,
  useCodexCwdFlag,
  prompt,
  cliArgs,
  active,
  requestedInputMode,
  onReady,
  onExit,
  onInputModeChange
}: EmbeddedTerminalProps) {
  const initialInputMode = sessionId ? "terminal" : "composer";
  const hostRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef("");
  const inputModeRef = useRef<"composer" | "terminal">(initialInputMode);
  const composerVisibleRef = useRef(!sessionId);
  const composerSubmittedRef = useRef(false);
  const lastSubmittedTextRef = useRef("");
  const pastedContentBlocksRef = useRef<PastedContentBlock[]>([]);
  const composerResizeRef = useRef<{ y: number; height: number } | null>(null);
  const onReadyRef = useRef(onReady);
  const onExitRef = useRef(onExit);
  const onInputModeChangeRef = useRef(onInputModeChange);
  const [, setStatus] = useState("正在启动 Codex...");
  const [inputMode, setInputMode] = useState<"composer" | "terminal">(initialInputMode);
  const [composerVisible, setComposerVisible] = useState(!sessionId);
  const [composerText, setComposerText] = useState("");
  const [composerHeight, setComposerHeight] = useState(COMPOSER_DEFAULT_HEIGHT);
  const [lastSubmittedText, setLastSubmittedText] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; canCopy: boolean } | null>(null);
  const [pasteDialog, setPasteDialog] = useState<{ text: string } | null>(null);

  function copyCurrentSelection() {
    const selection = terminalRef.current?.getSelection();
    if (!selection) return false;
    void window.codexConsole.copyText(selection);
    setContextMenu(null);
    return true;
  }

  async function pasteClipboardText() {
    const text = await window.codexConsole.readText();
    return showPasteDialog(text);
  }

  function showPasteDialog(text: string) {
    if (!terminalIdRef.current) return false;
    if (!text) return false;
    setContextMenu(null);
    setPasteDialog({ text });
    return true;
  }

  function confirmPasteText() {
    const terminal = terminalRef.current;
    if (!terminalIdRef.current || !pasteDialog) return;
    const text = pasteDialog.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "");
    setPasteDialog(null);
    if (!text) return;
    if (inputMode === "composer") {
      insertComposerText(text, { compact: true });
      setTimeout(() => composerRef.current?.focus(), 0);
      return;
    }
    if (!terminal) return;
    terminal.focus();
    terminal.paste(text);
  }

  function submitComposerText() {
    const terminalId = terminalIdRef.current;
    const displayText = normalizeComposerText(composerText);
    const expandedText = expandPastedContent(displayText);
    if (!terminalId || !expandedText.trim()) return;
    writeBracketedPaste(terminalId, expandedText);
    setComposerText("");
    lastSubmittedTextRef.current = displayText;
    composerSubmittedRef.current = true;
    setLastSubmittedText(displayText);
    window.setTimeout(() => {
      if (terminalIdRef.current === terminalId) void window.codexConsole.writeTerminal(terminalId, "\r");
    }, 0);
  }

  function writeBracketedPaste(terminalId: string, text: string) {
    const safeText = text.replace(/\x1b/g, "");
    void window.codexConsole.writeTerminal(terminalId, `\x1b[200~${safeText}\x1b[201~`);
  }

  function sendRawInterrupt() {
    const terminalId = terminalIdRef.current;
    if (!terminalId) return;
    void window.codexConsole.writeTerminal(terminalId, "\x03");
  }

  function sendComposerInterrupt() {
    const terminalId = terminalIdRef.current;
    if (!terminalId) return;
    const shouldRestoreComposer = composerSubmittedRef.current && !composerRef.current?.value.trim() && lastSubmittedTextRef.current;
    const clearNativeEcho = () => {
      if (terminalIdRef.current !== terminalId) return;
      void window.codexConsole.writeTerminal(terminalId, "\x03");
    };
    void window.codexConsole.writeTerminal(terminalId, "\x03");
    window.setTimeout(clearNativeEcho, 220);
    resetComposerSubmitted();
    if (shouldRestoreComposer) {
      setComposerText(lastSubmittedTextRef.current);
      switchInputMode("composer");
    }
  }

  function switchInputMode(nextMode: "composer" | "terminal") {
    if (nextMode === "composer" && !composerVisibleRef.current) return;
    inputModeRef.current = nextMode;
    setInputMode(nextMode);
    window.setTimeout(() => {
      if (nextMode === "composer") composerRef.current?.focus();
      else terminalRef.current?.focus();
    }, 0);
  }

  function revealComposer() {
    if (composerVisibleRef.current) return;
    composerVisibleRef.current = true;
    setComposerVisible(true);
    inputModeRef.current = "composer";
    setInputMode("composer");
    window.setTimeout(() => {
      if (active) composerRef.current?.focus();
    }, 0);
  }

  function insertComposerNewline(element: HTMLTextAreaElement) {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    setComposerText((current) => `${current.slice(0, start)}\n${current.slice(end)}`);
    window.setTimeout(() => {
      element.selectionStart = start + 1;
      element.selectionEnd = start + 1;
      element.scrollTop = element.scrollHeight;
      element.focus();
    }, 0);
  }

  function onComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const text = event.clipboardData.getData("text/plain");
    if (!shouldCompactPaste(text)) return;
    event.preventDefault();
    insertComposerText(text, { compact: true, target: event.currentTarget });
  }

  function insertComposerText(
    text: string,
    options: { compact?: boolean; target?: HTMLTextAreaElement } = {}
  ) {
    const normalized = normalizeComposerText(text);
    if (!normalized) return;
    const insertedText = options.compact && shouldCompactPaste(normalized)
      ? createPastedContentMarker(normalized)
      : normalized;
    const target = options.target || composerRef.current;
    if (!target) {
      setComposerText((current) => current ? `${current}${insertedText}` : insertedText);
      resetComposerSubmitted();
      return;
    }
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const next = `${target.value.slice(0, start)}${insertedText}${target.value.slice(end)}`;
    setComposerText(next);
    resetComposerSubmitted();
    window.setTimeout(() => {
      const cursor = start + insertedText.length;
      target.selectionStart = cursor;
      target.selectionEnd = cursor;
      target.scrollTop = target.scrollHeight;
      target.focus();
    }, 0);
  }

  function startComposerResize(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    composerResizeRef.current = { y: event.clientY, height: composerHeight };
  }

  function createPastedContentMarker(text: string) {
    const marker = `[Pasted Content ${text.length} chars]`;
    pastedContentBlocksRef.current.push({ marker, text });
    return marker;
  }

  function expandPastedContent(text: string) {
    const used = new Set<number>();
    return text.replace(/\[Pasted Content \d+ chars\]/g, (marker) => {
      const index = pastedContentBlocksRef.current.findIndex((block, blockIndex) => !used.has(blockIndex) && block.marker === marker);
      if (index === -1) return marker;
      used.add(index);
      return pastedContentBlocksRef.current[index].text;
    });
  }

  function normalizeComposerText(text: string) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "");
  }

  function shouldCompactPaste(text: string) {
    if (!text) return false;
    return text.length >= COMPACT_PASTE_MIN_CHARS || text.split(/\r\n|\r|\n/).length >= COMPACT_PASTE_MIN_LINES;
  }

  function onComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      const target = event.currentTarget;
      if (target.selectionStart === target.selectionEnd) {
        event.preventDefault();
        sendComposerInterrupt();
      }
      return;
    }
    if (event.key !== "Enter") return;
    if (event.altKey) {
      event.preventDefault();
      insertComposerNewline(event.currentTarget);
      return;
    }
    event.preventDefault();
    submitComposerText();
  }

  function resetComposerSubmitted() {
    composerSubmittedRef.current = false;
  }

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    onInputModeChangeRef.current = onInputModeChange;
  }, [onInputModeChange]);

  useEffect(() => {
    onInputModeChangeRef.current?.({ mode: inputMode, composerVisible });
  }, [inputMode, composerVisible]);

  useEffect(() => {
    if (!requestedInputMode || requestedInputMode === inputModeRef.current) return;
    switchInputMode(requestedInputMode);
  }, [requestedInputMode]);

  useEffect(() => {
    inputModeRef.current = inputMode;
    if (!active) return;
    window.setTimeout(() => {
      if (inputMode === "composer" && composerVisible) composerRef.current?.focus();
      else terminalRef.current?.focus();
    }, 0);
  }, [active, inputMode, composerVisible]);

  useEffect(() => {
    lastSubmittedTextRef.current = lastSubmittedText;
  }, [lastSubmittedText]);

  useEffect(() => {
    function onMouseMove(event: MouseEvent) {
      const state = composerResizeRef.current;
      if (!state) return;
      const nextHeight = state.height + state.y - event.clientY;
      setComposerHeight(Math.max(COMPOSER_MIN_HEIGHT, Math.min(COMPOSER_MAX_HEIGHT, nextHeight)));
    }

    function onMouseUp() {
      composerResizeRef.current = null;
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  useEffect(() => {
    if (!contextMenu) return;

    const close = () => setContextMenu(null);
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
  }, [contextMenu]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const nextComposerVisible = !sessionId;
    const nextInputMode = sessionId ? "terminal" : "composer";
    composerVisibleRef.current = nextComposerVisible;
    setComposerVisible(nextComposerVisible);
    inputModeRef.current = nextInputMode;
    setInputMode(nextInputMode);

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 20000,
      theme: {
        background: "#111827",
        foreground: "#e5e7eb",
        cursor: "#f9fafb"
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    terminal.open(host);
    fitAddon.fit();
    if (active) setTimeout(() => (nextComposerVisible ? composerRef.current?.focus() : terminal.focus()), 0);

    function copySelection() {
      const selection = terminal.getSelection();
      if (!selection) return false;
      void window.codexConsole.copyText(selection);
      return true;
    }

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && inputModeRef.current === "terminal") {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && !terminal.hasSelection()) {
          sendRawInterrupt();
          return false;
        }
        if (event.key === "Backspace") {
          if (terminalIdRef.current) void window.codexConsole.writeTerminal(terminalIdRef.current, "\x7f");
          return false;
        }
      }
      if (
        event.type === "keydown" &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "c" &&
        terminal.hasSelection()
      ) {
        copySelection();
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
      if (inputModeRef.current === "composer" && event.type === "keydown") {
        return false;
      }
      return true;
    });

    function submitInput() {
      if (terminalIdRef.current) void window.codexConsole.writeTerminal(terminalIdRef.current, "\r");
    }

    function onTerminalKeyDown(event: KeyboardEvent) {
      if (inputModeRef.current === "terminal") {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && !terminal.hasSelection()) {
          event.preventDefault();
          event.stopPropagation();
          sendRawInterrupt();
          return;
        }
        if (event.key === "Backspace") {
          event.preventDefault();
          event.stopPropagation();
          if (terminalIdRef.current) void window.codexConsole.writeTerminal(terminalIdRef.current, "\x7f");
          return;
        }
      }
      const isEnter = event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter";
      if (!isEnter || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      submitInput();
    }

    function fitTerminal() {
      fitAddon.fit();
      if (terminalIdRef.current) {
        void window.codexConsole.resizeTerminal(terminalIdRef.current, terminal.cols, terminal.rows);
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(fitTerminal);
    });
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
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      showPasteDialog(text);
    };
    const onMouseDown = () => {
      if (inputModeRef.current !== "composer") return;
      inputModeRef.current = "terminal";
      setInputMode("terminal");
      window.setTimeout(() => terminal.focus(), 0);
    };
    host.addEventListener("contextmenu", onContextMenu);
    host.addEventListener("paste", onPaste);
    host.addEventListener("mousedown", onMouseDown);
    host.addEventListener("keydown", onTerminalKeyDown, true);

    const dataDisposable = terminal.onData((data) => {
      if (terminalIdRef.current) void window.codexConsole.writeTerminal(terminalIdRef.current, data);
    });
    const removeDataListener = window.codexConsole.onTerminalData((terminalId, data) => {
      if (terminalId !== terminalIdRef.current) return;
      terminal.write(data);
      if (!composerVisibleRef.current && data) {
        revealComposer();
        requestAnimationFrame(fitTerminal);
      }
    });
    const removeExitListener = window.codexConsole.onTerminalExit((terminalId, exitCode) => {
      if (terminalId !== terminalIdRef.current) return;
      if (exitCode === 0) {
        terminalIdRef.current = "";
        resetComposerSubmitted();
        onExitRef.current?.(exitCode);
        return;
      }
      setStatus(`Codex 已退出，退出码 ${exitCode}`);
      terminal.writeln("");
      terminal.writeln(`Codex 已退出，退出码 ${exitCode}`);
      terminalIdRef.current = "";
    });

    void window.codexConsole
      .startTerminal({
        targetId,
        sessionId,
        cwd,
        codexHome,
        useCodexCwdFlag,
        cliArgs,
        cols: terminal.cols,
        rows: terminal.rows
      })
      .then(({ terminalId }) => {
        if (disposed) {
          void window.codexConsole.stopTerminal(terminalId);
          return;
        }
        terminalIdRef.current = terminalId;
        setStatus("Codex 运行中");
        onReadyRef.current?.(terminalId);
        if (prompt?.trim() && !sessionId) {
          void window.codexConsole.writeTerminal(terminalId, `${prompt.trim()}\r`);
        }
      })
      .catch((error: any) => {
        if (disposed) return;
        const message = error?.message || "启动 Codex 失败。";
        setStatus("启动 Codex 失败");
        terminal.writeln(message);
        onReadyRef.current?.();
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
      host.removeEventListener("contextmenu", onContextMenu);
      host.removeEventListener("paste", onPaste);
      host.removeEventListener("mousedown", onMouseDown);
      host.removeEventListener("keydown", onTerminalKeyDown, true);
      fitAddon.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // 依赖为终端“身份”参数：纳入 active/composer 等会销毁并重建 PTY，属错误
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, sessionId, cwd, codexHome, useCodexCwdFlag, prompt, cliArgs]);

  useEffect(() => {
    if (!active) return;
    setTimeout(() => {
      const host = hostRef.current;
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!host || !terminal || !fitAddon) return;
      fitAddon.fit();
      if (terminalIdRef.current) void window.codexConsole.resizeTerminal(terminalIdRef.current, terminal.cols, terminal.rows);
      if (inputMode === "composer" && composerVisible) composerRef.current?.focus();
      else terminal.focus();
    }, 0);
  }, [active, inputMode, composerVisible]);

  return (
    <section className={`terminal-panel ${active ? "active" : ""}`}>
      <div className="terminal-host" ref={hostRef} />
      {composerVisible && (
        <div className={`terminal-composer ${inputMode === "composer" ? "active" : ""}`}>
          <div
            className="terminal-composer-resize"
            role="separator"
            aria-orientation="horizontal"
            title="拖动调整输入框高度"
            onMouseDown={startComposerResize}
          />
          <textarea
            ref={composerRef}
            value={composerText}
            style={{ height: `${composerHeight}px` }}
            spellCheck={false}
            placeholder="输入对话内容，Enter 发送，Alt + Enter 换行"
            onFocus={() => {
              if (inputModeRef.current !== "composer") switchInputMode("composer");
            }}
            onMouseDown={() => {
              if (inputModeRef.current !== "composer") switchInputMode("composer");
            }}
            onChange={(event) => {
              setComposerText(event.target.value);
              resetComposerSubmitted();
            }}
            onKeyDown={onComposerKeyDown}
            onPaste={onComposerPaste}
          />
          <button
            type="button"
            onClick={submitComposerText}
            disabled={!terminalIdRef.current || !composerText.trim()}
          >
            发送
          </button>
        </div>
      )}
      {contextMenu && (
        <div
          className="terminal-context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          role="menu"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" disabled={!contextMenu.canCopy} onClick={() => copyCurrentSelection()}>
            复制
          </button>
          <button type="button" role="menuitem" disabled={!terminalIdRef.current} onClick={() => void pasteClipboardText()}>
            粘贴
          </button>
        </div>
      )}
      {pasteDialog && (
        <div className="terminal-paste-overlay" role="presentation">
          <section className="terminal-paste-dialog" role="dialog" aria-modal="true" aria-labelledby="terminal-paste-title">
            <header>
              <div>
                <h2 id="terminal-paste-title">确认粘贴</h2>
                <p>确认后内容会粘贴到终端输入区，不会自动提交。</p>
              </div>
              <button type="button" aria-label="关闭" onClick={() => setPasteDialog(null)}>
                ×
              </button>
            </header>
            <textarea readOnly value={pasteDialog.text} spellCheck={false} />
            <footer>
              <button type="button" className="secondary" onClick={() => setPasteDialog(null)}>
                取消
              </button>
              <button type="button" onClick={confirmPasteText}>
                确认粘贴
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
