declare module "@xterm/xterm" {
  export class Terminal {
    cols: number;
    rows: number;
    constructor(options?: Record<string, unknown>);
    loadAddon(addon: { activate(terminal: Terminal): void; dispose?(): void }): void;
    open(element: HTMLElement): void;
    focus(): void;
    write(data: string): void;
    writeln(data: string): void;
    resize(cols: number, rows: number): void;
    dispose(): void;
    onData(handler: (data: string) => void): { dispose(): void };
  }
}

declare module "@xterm/addon-fit" {
  export class FitAddon {
    activate(terminal: import("@xterm/xterm").Terminal): void;
    dispose(): void;
    fit(): void;
  }
}

declare module "@xterm/xterm/css/xterm.css";
