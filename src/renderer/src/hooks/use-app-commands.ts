import { useCallback } from 'react';
import type { AppCommand } from '../types';

/** 统一执行应用级命令，集中处理 IPC 错误反馈。 */
export function useAppCommands(setError: (message: string) => void) {
  return useCallback(async (command: AppCommand) => {
    try {
      await window.codexConsole.appCommand(command);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [setError]);
}
