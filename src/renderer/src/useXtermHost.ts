import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";

// contextMenu 的定位状态
type ContextMenuState = { x: number; y: number; canCopy: boolean } | null;

// 自定义按键处理器的签名：返回 false 阻止 xterm 默认行为，true/undefined 放行。
export type XtermKeyHandler = (event: {
  type: string; key: string; ctrlKey: boolean; metaKey: boolean;
  altKey: boolean; shiftKey: boolean; code: string;
}) => boolean | undefined;

export type UseXtermHostOptions = {
  /** 自定义按键处理器，覆盖默认的 Ctrl+C 复制 / Ctrl+V 粘贴 */
  customKeyHandler?: XtermKeyHandler;
  /** 粘贴回调（不传时用默认粘贴行为） */
  onPaste?: (text: string) => void;
};

// 提取两个终端组件（EmbeddedTerminal / SystemTerminal）共享的 xterm.js 基础设施：
//   Terminal 创建 + FitAddon + SearchAddon + 输出缓冲 + fit 调度 + ResizeObserver +
//   右键菜单 + 复制/粘贴 + Ctrl+C/V 键处理。
// 宿主组件负责：
//   - 在合适时机调用 mountTerminal(hostDiv) 并返回清理函数
//   - 提供 startTerminal IPC 调用（两个终端参数不同）
//   - 处理 onReady / onExit 等业务回调
//   - 注册 terminal:data / terminal:exit 监听
export function useXtermHost(options: UseXtermHostOptions = {}) {
  const { customKeyHandler, onPaste } = options;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalIdRef = useRef("");
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const disposeRef = useRef({ disposed: false });
  const outputBufferRef = useRef("");
  const outputFrameRef = useRef(0);
  const resizeFrameRef = useRef(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);

  // 用 ref 持有外部回调，避免 mountTerminal 的 useCallback 因它们而每渲染重建
  const customKeyHandlerRef = useRef(customKeyHandler);
  customKeyHandlerRef.current = customKeyHandler;
  const onPasteRef = useRef(onPaste);
  onPasteRef.current = onPaste;

  // 复制当前选中的文本
  const copyCurrentSelection = useCallback(() => {
    const selection = terminalRef.current?.getSelection();
    if (!selection) return false;
    void window.codexConsole.copyText(selection);
    setContextMenu(null);
    return true;
  }, []);

  // 默认粘贴：交给 xterm 处理，保持与原终端组件一致的输入/括号粘贴语义。
  const pasteClipboardText = useCallback(async () => {
    const text = await window.codexConsole.readText();
    if (!terminalIdRef.current || !text) return false;
    terminalRef.current?.paste(text);
    setContextMenu(null);
    return true;
  }, []);

  // 将 xterm 挂载到 host DOM 元素上。返回清理函数，宿主组件应在其 useEffect 的 cleanup 中调用。
  const mountTerminal = useCallback((host: HTMLDivElement) => {
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
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    terminal.open(host);
    fitAddon.fit();

    // 输出缓冲：requestAnimationFrame 节流，SystemTerminal 与 EmbeddedTerminal 共用相同函数。
    function flushOutput() {
      outputFrameRef.current = 0;
      if (!outputBufferRef.current) return;
      const data = outputBufferRef.current;
      outputBufferRef.current = "";
      terminal.write(data);
    }

    function writeTerminalOutput(data: string) {
      outputBufferRef.current += data;
      if (!outputFrameRef.current) outputFrameRef.current = requestAnimationFrame(flushOutput);
    }

    function fitTerminal() {
      fitAddon.fit();
      if (terminalIdRef.current) {
        void window.codexConsole.resizeTerminal(terminalIdRef.current, terminal.cols, terminal.rows);
      }
    }

    function scheduleFitTerminal() {
      if (resizeFrameRef.current) return;
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = 0;
        fitTerminal();
      });
    }

    const resizeObserver = new ResizeObserver(() => scheduleFitTerminal());
    resizeObserver.observe(host);
    resizeObserverRef.current = resizeObserver;

    // 右键菜单
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

    // 粘贴事件（由组件决定是否使用）
    let onPasteEvent: ((event: ClipboardEvent) => void) | undefined;
    if (onPaste) {
      onPasteEvent = (event: ClipboardEvent) => {
        event.preventDefault();
        const text = event.clipboardData?.getData("text/plain") ?? "";
        onPasteRef.current?.(text);
      };
      host.addEventListener("paste", onPasteEvent);
    }

    // 自定义按键处理：默认 Ctrl+C（有选中时复制）/ Ctrl+V 粘贴
    terminal.attachCustomKeyEventHandler((event) => {
      if (customKeyHandlerRef.current) return customKeyHandlerRef.current(event) ?? true;
      if (event.type === "keydown" && (event.ctrlKey || event.metaKey)) {
        if (event.key.toLowerCase() === "c" && terminal.hasSelection()) {
          const selection = terminal.getSelection();
          if (selection) void window.codexConsole.copyText(selection);
          return false;
        }
        if (event.key.toLowerCase() === "v") {
          void pasteClipboardText();
          return false;
        }
      }
      return true;
    });

    // 终端输入转发
    const dataDisposable = terminal.onData((data) => {
      if (terminalIdRef.current) void window.codexConsole.writeTerminal(terminalIdRef.current, data);
    });

    // 返回清理函数与共享工具
    return {
      flushOutput,
      writeTerminalOutput,
      fitTerminal,
      scheduleFitTerminal,
      dataDisposable,
      dispose: () => {
        if (outputFrameRef.current) cancelAnimationFrame(outputFrameRef.current);
        if (resizeFrameRef.current) cancelAnimationFrame(resizeFrameRef.current);
        resizeObserver.disconnect();
        host.removeEventListener("contextmenu", onContextMenu);
        if (onPasteEvent) host.removeEventListener("paste", onPasteEvent);
        dataDisposable.dispose();
        terminal.dispose();
        fitAddon.dispose();
        searchAddon.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        searchAddonRef.current = null;
      }
    };
  }, [pasteClipboardText]);

  // disposed 标记 + 兜底清理
  useEffect(() => {
    const dispose = disposeRef.current;
    dispose.disposed = false;
    return () => {
      dispose.disposed = true;
      const terminalId = terminalIdRef.current;
      terminalIdRef.current = "";
      if (terminalId) void window.codexConsole.stopTerminal(terminalId);
    };
  }, []);

  return {
    hostRef,
    terminalRef,
    terminalIdRef,
    fitAddonRef,
    searchAddonRef,
    disposeRef,
    contextMenu,
    setContextMenu,
    copyCurrentSelection,
    pasteClipboardText,
    mountTerminal
  };
}
