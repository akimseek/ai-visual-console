import { useState } from "react";

export function useSystemTerminal() {
  const [systemTerminalOpen, setSystemTerminalOpen] = useState(false);
  const [systemTerminalMinimized, setSystemTerminalMinimized] = useState(false);
  const [systemTerminalCreateSignal, setSystemTerminalCreateSignal] = useState(0);

  function openNewSystemTerminal() {
    setSystemTerminalOpen(true);
    setSystemTerminalMinimized(false);
    setSystemTerminalCreateSignal((current) => current + 1);
  }

  function closeSystemTerminal() {
    setSystemTerminalOpen(false);
  }

  function toggleSystemTerminalMinimized() {
    setSystemTerminalMinimized((current) => !current);
  }

  return {
    systemTerminalOpen,
    systemTerminalMinimized,
    systemTerminalCreateSignal,
    openNewSystemTerminal,
    closeSystemTerminal,
    toggleSystemTerminalMinimized
  };
}
