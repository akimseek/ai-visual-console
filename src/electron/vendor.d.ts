declare module "node-pty" {
  export type IPty = {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    onData(handler: (data: string) => void): void;
    onExit(handler: (event: { exitCode: number }) => void): void;
  };

  export function spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }
  ): IPty;
}
