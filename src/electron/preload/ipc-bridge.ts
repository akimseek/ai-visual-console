import type { IpcRenderer } from "electron";

// 统一封装 invoke 的类型边界；具体 IPC channel 仍由各业务域模块明确声明。
export function invoke<T>(ipc: IpcRenderer, channel: string, ...args: unknown[]): Promise<T> {
  return ipc.invoke(channel, ...args) as Promise<T>;
}

// 统一封装单参数事件订阅，并返回可直接用于 React effect 清理的取消函数。
export function subscribe<T>(ipc: IpcRenderer, channel: string, handler: (payload: T) => void) {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload);
  ipc.on(channel, listener);
  return () => ipc.off(channel, listener);
}

// 终端事件携带多个参数，单独保留多参数订阅封装以避免丢失现有事件顺序。
export function subscribeArgs<TArgs extends unknown[]>(
  ipc: IpcRenderer,
  channel: string,
  handler: (...args: TArgs) => void
) {
  const listener = (_event: Electron.IpcRendererEvent, ...args: TArgs) => handler(...args);
  ipc.on(channel, listener);
  return () => ipc.off(channel, listener);
}
