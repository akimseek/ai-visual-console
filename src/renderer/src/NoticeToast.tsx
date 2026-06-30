// 右上角提示 toast（可带一个操作按钮）。从 App.tsx 的内联 JSX 抽出为展示组件。
export function NoticeToast({
  notice,
  onDismiss
}: {
  notice: { message: string; actionLabel?: string; onAction?: () => void };
  onDismiss: () => void;
}) {
  return (
    <div className={`notice-toast ${notice.onAction ? "notice-toast-actionable" : ""}`}>
      <span>{notice.message}</span>
      {notice.onAction && (
        <button
          type="button"
          onClick={() => {
            notice.onAction?.();
            onDismiss();
          }}
        >
          {notice.actionLabel}
        </button>
      )}
    </div>
  );
}
