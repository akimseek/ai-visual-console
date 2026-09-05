import type { ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";

// 统一的图标按钮：避免在不同区域混用字符、手绘 SVG 与不一致的尺寸。
export function IconButton({
  icon: Icon,
  label,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
}) {
  return (
    <button
      {...props}
      type={props.type || "button"}
      className={`icon-button ${className}`.trim()}
      aria-label={label}
      title={label}
    >
      <Icon aria-hidden="true" size={17} strokeWidth={1.9} />
    </button>
  );
}
