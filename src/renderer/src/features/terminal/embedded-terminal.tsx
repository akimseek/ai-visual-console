import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent
} from "react";
import "@xterm/xterm/css/xterm.css";
import { TerminalSearchBar } from "./terminal-search-bar";
import { useTerminalSearch } from "./use-terminal-search";
import { useXtermHost, type XtermKeyHandler } from "./use-xterm-host";
import { ComposerInput, type ComposerAttachment, type ComposerSubmitPayload } from "./composer-input";
import type { ApiVendor } from "../../types";

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
  focusRequest?: number;
  requestedInputMode?: "composer" | "terminal";
  onReady?: (terminalId?: string, vendorId?: string) => void;
  onVendorSwitch?: (vendorId: string, reason: "manual" | "candidate-pool" | "failure") => void;
  onExit?: (exitCode: number) => void;
  onInputModeChange?: (state: { mode: "composer" | "terminal"; composerVisible: boolean }) => void;
  vendors?: ApiVendor[];
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
const QODER_PASTE_SUBMIT_DELAY_MS = 60;

export function EmbeddedTerminal({
  targetId,
  sessionId,
  cwd,
  codexHome,
  useCodexCwdFlag,
  prompt,
  cliArgs,
  active,
  focusRequest,
  requestedInputMode,
  onReady,
  onVendorSwitch,
  onExit,
  onInputModeChange,
  vendors = []
}: EmbeddedTerminalProps) {
  const initialInputMode = sessionId ? "terminal" : "composer";
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const terminalIdRef = useRef("");
  // 网关可能在 PTY 启动回调返回前就完成首个请求并切换供应商，先暂存事件，
  // 待 terminalIdRef 建立后再提交给父组件更新状态栏。
  const pendingVendorSwitchRef = useRef<{ vendorId: string; reason: "manual" | "candidate-pool" | "failure" } | null>(null);
  const inputModeRef = useRef<"composer" | "terminal">(initialInputMode);
  const composerVisibleRef = useRef(!sessionId);
  const composerSubmittedRef = useRef(false);
  const lastSubmittedTextRef = useRef("");
  const pastedContentBlocksRef = useRef<PastedContentBlock[]>([]);
  const composerResizeRef = useRef<{ y: number; height: number } | null>(null);
  const onReadyRef = useRef(onReady);
  const onExitRef = useRef(onExit);
  const onVendorSwitchRef = useRef(onVendorSwitch);
  const onInputModeChangeRef = useRef(onInputModeChange);
  const [, setStatus] = useState("正在启动 Codex...");
  const [inputMode, setInputMode] = useState<"composer" | "terminal">(initialInputMode);
  const [composerVisible, setComposerVisible] = useState(!sessionId);
  const [composerText, setComposerText] = useState("");
  const [composerHeight, setComposerHeight] = useState(COMPOSER_DEFAULT_HEIGHT);
  const [lastSubmittedText, setLastSubmittedText] = useState("");
  const [pasteDialog, setPasteDialog] = useState<{ text: string } | null>(null);

  const showPasteDialog = useCallback((text: string) => {
    if (!text) return;
    setPasteDialog({ text });
  }, []);

  const xterm = useXtermHost({
    customKeyHandler: useCallback<XtermKeyHandler>((event) => {
      if (event.type === "keydown" && inputModeRef.current === "terminal") {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
          if (xterm.terminalRef.current?.hasSelection()) {
            void xterm.copyCurrentSelection();
            return false;
          }
          sendRawInterrupt();
          return false;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
          void xterm.pasteClipboardText();
          return false;
        }
        if (event.key === "Backspace") {
          if (terminalIdRef.current) void window.codexConsole.writeTerminal(terminalIdRef.current, "\x7f");
          return false;
        }
      }
      if (inputModeRef.current === "composer" && event.type === "keydown") {
        return false;
      }
      return undefined;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
    onPaste: useCallback((text: string) => {
      showPasteDialog(text);
    }, [showPasteDialog]),
    terminalIdRef
  });

  const search = useTerminalSearch({
    restoreFocus: () => {
      if (inputModeRef.current === "composer" && composerVisibleRef.current) composerRef.current?.focus();
      else xterm.terminalRef.current?.focus();
    }
  });

  function sendRawInterrupt() {
    const terminalId = terminalIdRef.current;
    if (!terminalId) return;
    void window.codexConsole.writeTerminal(terminalId, "\x03");
  }

  function showPasteDialogFromClipboard() {
    void window.codexConsole.readText().then((text) => {
      if (!terminalIdRef.current || !text) return;
      showPasteDialog(text);
    });
  }

  function confirmPasteText() {
    const terminal = xterm.terminalRef.current;
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

  async function submitComposerText(payload: ComposerSubmitPayload) {
    const terminalId = terminalIdRef.current;
    const displayText = normalizeComposerText(payload.text);
    const attachmentText = formatAttachments(payload.attachments);
    const fullText = attachmentText ? `${attachmentText}\n${displayText}` : displayText;
    const expandedText = expandPastedContent(fullText);
    if (!terminalId || !expandedText.trim()) return;
    await writeBracketedPaste(terminalId, expandedText);
    if (targetId.startsWith("qoder:")) await wait(QODER_PASTE_SUBMIT_DELAY_MS);
    if (terminalIdRef.current !== terminalId) return;
    await window.codexConsole.writeTerminal(terminalId, "\r");
    setComposerText("");
    lastSubmittedTextRef.current = displayText;
    composerSubmittedRef.current = true;
    setLastSubmittedText(displayText);
  }

  function formatAttachments(attachments: ComposerAttachment[]): string {
    if (attachments.length === 0) return "";
    const lines: string[] = [];
    for (const attachment of attachments) {
      // PTY 只能传输文本；使用完整路径让 CLI 在本地读取真实文件/目录，而不是伪造仅含文件名的附件。
      const path = /\s/.test(attachment.path) ? `"${attachment.path.replace(/"/g, "\\\"")}"` : attachment.path;
      lines.push(`@${path}`);
    }
    return lines.join("\n");
  }

  function selectComposerModel(modelId: string) {
    const terminalId = terminalIdRef.current;
    if (!terminalId || !modelId) return;
    // 各 CLI 的交互终端均使用 /model 命令；选择后立即作用于当前会话。
    void window.codexConsole.writeTerminal(terminalId, `/model ${modelId}\r`);
  }

  async function writeBracketedPaste(id: string, text: string) {
    const safeText = text.replace(/\x1b/g, "");
    await window.codexConsole.writeTerminal(id, `\x1b[200~${safeText}\x1b[201~`);
  }

  function wait(delayMs: number) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
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
      else xterm.terminalRef.current?.focus();
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
    onVendorSwitchRef.current = onVendorSwitch;
  }, [onVendorSwitch]);

  useEffect(() => {
    onInputModeChangeRef.current = onInputModeChange;
  }, [onInputModeChange]);

  useEffect(() => {
    onInputModeChangeRef.current?.({ mode: inputMode, composerVisible });
  }, [inputMode, composerVisible]);

  useEffect(() => {
    if (!requestedInputMode || requestedInputMode === inputModeRef.current) return;
    switchInputMode(requestedInputMode);
    // switchInputMode 仅依赖当前终端 refs，身份 effect 外保持稳定即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedInputMode]);

  useEffect(() => {
    inputModeRef.current = inputMode;
    if (!active) return;
    window.setTimeout(() => {
      if (inputMode === "composer" && composerVisible) composerRef.current?.focus();
      else xterm.terminalRef.current?.focus();
    }, 0);
    // xterm refs 是稳定容器，不作为状态依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, inputMode, composerVisible, focusRequest]);

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
    const host = xterm.hostRef.current;
    if (!host) return;
    let disposed = false;
    const nextComposerVisible = !sessionId;
    const nextInputMode = sessionId ? "terminal" : "composer";
    composerVisibleRef.current = nextComposerVisible;
    setComposerVisible(nextComposerVisible);
    inputModeRef.current = nextInputMode;
    setInputMode(nextInputMode);

    const { writeTerminalOutput, flushOutput, scheduleFitTerminal, dispose: mountDispose } = xterm.mountTerminal(host);

    const detachSearchAddon = search.attachAddon(xterm.searchAddonRef.current!, xterm.terminalRef.current!);
    if (active) setTimeout(() => (nextComposerVisible ? composerRef.current?.focus() : xterm.terminalRef.current?.focus()), 0);

    const onMouseDown = () => {
      if (inputModeRef.current !== "composer") return;
      inputModeRef.current = "terminal";
      setInputMode("terminal");
      window.setTimeout(() => xterm.terminalRef.current?.focus(), 0);
    };
    host.addEventListener("mousedown", onMouseDown);

    const removeDataListener = window.codexConsole.onTerminalData((terminalId, data) => {
      if (terminalId !== terminalIdRef.current) return;
      writeTerminalOutput(data);
      if (!composerVisibleRef.current && data) {
        revealComposer();
        scheduleFitTerminal();
      }
    });
    const removeExitListener = window.codexConsole.onTerminalExit((terminalId, exitCode) => {
      if (terminalId !== terminalIdRef.current) return;
      flushOutput();
      if (exitCode === 0) {
        terminalIdRef.current = "";
        resetComposerSubmitted();
        onExitRef.current?.(exitCode);
        return;
      }
      setStatus(`Codex 已退出，退出码 ${exitCode}`);
      xterm.terminalRef.current?.writeln("");
      xterm.terminalRef.current?.writeln(`Codex 已退出，退出码 ${exitCode}`);
      terminalIdRef.current = "";
    });
    const removeVendorSwitchListener = window.codexConsole.onGatewayVendorSwitched((event) => {
      if (!event.vendorId) return;
      // 只有旧版/极早期事件没有 terminalId 时才暂存；带 terminalId 的事件属于其他终端时必须继续过滤。
      if (!terminalIdRef.current && !event.terminalId) {
        pendingVendorSwitchRef.current = { vendorId: event.vendorId, reason: event.reason };
        return;
      }
      if (event.terminalId !== terminalIdRef.current) return;
      onVendorSwitchRef.current?.(event.vendorId, event.reason);
    });

    void window.codexConsole
      .startTerminal({
        targetId,
        sessionId,
        cwd,
        codexHome,
        useCodexCwdFlag,
        cliArgs,
        cols: xterm.terminalRef.current!.cols,
        rows: xterm.terminalRef.current!.rows
      })
      .then(({ terminalId, vendorId }) => {
        if (disposed || xterm.disposeRef.current.disposed) {
          void window.codexConsole.stopTerminal(terminalId);
          return;
        }
        terminalIdRef.current = terminalId;
        setStatus("Codex 运行中");
        const pendingVendorSwitch = pendingVendorSwitchRef.current;
        pendingVendorSwitchRef.current = null;
        onReadyRef.current?.(terminalId, pendingVendorSwitch?.vendorId || vendorId);
        if (pendingVendorSwitch && pendingVendorSwitch.vendorId !== vendorId) {
          onVendorSwitchRef.current?.(pendingVendorSwitch.vendorId, pendingVendorSwitch.reason);
        }
        if (prompt?.trim() && !sessionId) {
          void window.codexConsole.writeTerminal(terminalId, `${prompt.trim()}\r`);
        }
      })
      .catch((error: unknown) => {
        if (disposed || xterm.disposeRef.current.disposed) return;
        const message = error instanceof Error ? error.message : "启动 Codex 失败。";
        setStatus("启动 Codex 失败");
        xterm.terminalRef.current?.writeln(message);
        onReadyRef.current?.();
      });

    return () => {
      disposed = true;
      const terminalId = terminalIdRef.current;
      terminalIdRef.current = "";
      if (terminalId) void window.codexConsole.stopTerminal(terminalId);
      removeDataListener();
      removeExitListener();
      removeVendorSwitchListener();
      detachSearchAddon();
      host.removeEventListener("mousedown", onMouseDown);
      mountDispose();
    };
    // 依赖为终端"身份"参数：纳入 active/composer 等会销毁并重建 PTY，属错误
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, sessionId, cwd, codexHome, useCodexCwdFlag, prompt, cliArgs, xterm.mountTerminal, xterm.hostRef, xterm.terminalRef, xterm.searchAddonRef, xterm.disposeRef, search.attachAddon]);

  useEffect(() => {
    if (!active) return;
    setTimeout(() => {
      xterm.fitAddonRef.current?.fit();
      if (xterm.terminalIdRef.current) {
        void window.codexConsole.resizeTerminal(xterm.terminalIdRef.current, xterm.terminalRef.current!.cols, xterm.terminalRef.current!.rows);
      }
      if (inputMode === "composer" && composerVisible) composerRef.current?.focus();
      else xterm.terminalRef.current?.focus();
    }, 0);
    // xterm refs 是稳定容器，不作为状态依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, inputMode, composerVisible]);

  return (
    <section className={`terminal-panel ${active ? "active" : ""}`} onKeyDownCapture={search.onPanelKeyDownCapture}>
      <div className="terminal-host" ref={xterm.hostRef} />
      {search.open && (
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
      {composerVisible && (
        <ComposerInput
          composerRef={composerRef}
          text={composerText}
          onTextChange={(text) => {
            setComposerText(text);
            resetComposerSubmitted();
          }}
          onSubmit={(payload) => void submitComposerText(payload)}
          onInterrupt={sendComposerInterrupt}
          canSubmit={Boolean(terminalIdRef.current && composerText.trim())}
          height={composerHeight}
          onResizeStart={startComposerResize}
          onFocus={() => {
            if (inputModeRef.current !== "composer") switchInputMode("composer");
          }}
          onMouseDown={() => {
            if (inputModeRef.current !== "composer") switchInputMode("composer");
          }}
          onModelSelect={selectComposerModel}
          vendors={vendors}
          targetId={targetId}
        />
      )}
      {xterm.contextMenu && (
        <div
          className="terminal-context-menu"
          style={{ left: `${xterm.contextMenu.x}px`, top: `${xterm.contextMenu.y}px` }}
          role="menu"
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" disabled={!xterm.contextMenu.canCopy} onClick={xterm.copyCurrentSelection}>
            复制
          </button>
          <button type="button" role="menuitem" disabled={!terminalIdRef.current} onClick={showPasteDialogFromClipboard}>
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
