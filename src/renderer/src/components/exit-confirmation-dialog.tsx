import { LogOut, Minimize2 } from "lucide-react";
import { Dialog } from "./dialog";

export function ExitConfirmationDialog({
  busy,
  onChoose,
  onClose
}: {
  busy: boolean;
  onChoose: (choice: "minimize" | "quit") => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title="退出 AI 可视化控制台"
      onClose={onClose}
      className="exit-confirmation-dialog"
      busy={busy}
      footer={
        <>
          <button type="button" className="ui-button ui-button-secondary" onClick={() => onChoose("minimize")} disabled={busy}>
            <Minimize2 aria-hidden="true" size={15} />
            最小化到托盘
          </button>
          <button type="button" className="ui-button ui-button-danger" onClick={() => onChoose("quit")} disabled={busy}>
            <LogOut aria-hidden="true" size={15} />
            直接退出
          </button>
        </>
      }
    >
      <p className="exit-confirmation-copy">最小化后应用会继续在后台运行；直接退出将关闭所有终端和本地 Gateway。</p>
    </Dialog>
  );
}
