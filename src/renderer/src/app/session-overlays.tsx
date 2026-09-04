import type { AiTarget } from '../types';
import { NewSessionDialog } from '../features/sessions/new-session-dialog';
import { SessionSettingsDialog } from '../features/sessions/session-settings-dialog';

type SessionOverlaysProps = {
  newSessionOpen: boolean;
  pendingResume: { missingCwd: string } | null;
  supportsCustomCwd: boolean;
  cwd: string;
  title: string;
  prompt: string;
  cliArgs: string;
  onChooseDirectory: () => void;
  onTitleChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onCliArgsChange: (value: string) => void;
  onCloseNewSession: () => void;
  onConfirmNewSession: () => void;
  settingsOpen: boolean;
  target?: AiTarget;
  wslPath: string;
  supportsSessionSettings: boolean;
  onWslPathChange: (value: string) => void;
  onCloseSettings: () => void;
  onRestoreWslPath: () => void;
  onSaveWslPath: () => void;
};

/** 会话相关弹窗的展示编排，目录选择、会话创建和 WSL 配置由页面 Hook 负责。 */
export function SessionOverlays({
  newSessionOpen,
  pendingResume,
  supportsCustomCwd,
  cwd,
  title,
  prompt,
  cliArgs,
  onChooseDirectory,
  onTitleChange,
  onPromptChange,
  onCliArgsChange,
  onCloseNewSession,
  onConfirmNewSession,
  settingsOpen,
  target,
  wslPath,
  supportsSessionSettings,
  onWslPathChange,
  onCloseSettings,
  onRestoreWslPath,
  onSaveWslPath
}: SessionOverlaysProps) {
  return (
    <>
      {newSessionOpen && (
        <NewSessionDialog
          pendingResume={pendingResume}
          supportsCustomCwd={supportsCustomCwd}
          cwd={cwd}
          title={title}
          prompt={prompt}
          cliArgs={cliArgs}
          onChooseDirectory={onChooseDirectory}
          onTitleChange={onTitleChange}
          onPromptChange={onPromptChange}
          onCliArgsChange={onCliArgsChange}
          onClose={onCloseNewSession}
          onConfirm={onConfirmNewSession}
        />
      )}
      {settingsOpen && (
        <SessionSettingsDialog
          wslPath={wslPath}
          isWsl={target?.kind === 'wsl'}
          supportsSessionSettings={supportsSessionSettings}
          onChange={onWslPathChange}
          onClose={onCloseSettings}
          onRestore={onRestoreWslPath}
          onSave={onSaveWslPath}
        />
      )}
    </>
  );
}
