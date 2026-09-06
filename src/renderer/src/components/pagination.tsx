import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, MoreHorizontal } from "lucide-react";
import { PAGINATION_PAGE_SIZE_OPTIONS } from "../../../shared/constants";

export const DEFAULT_PAGE_SIZE_OPTIONS = PAGINATION_PAGE_SIZE_OPTIONS;
export type PaginationItem = number | "ellipsis";

export function getPaginationItems(page: number, totalPages: number, maxVisiblePages = 5): PaginationItem[] {
  const safeTotalPages = Math.max(1, Math.floor(totalPages));
  const safePage = Math.min(safeTotalPages, Math.max(1, Math.floor(page)));
  const visible = Math.max(3, Math.floor(maxVisiblePages));
  if (safeTotalPages <= visible) return Array.from({ length: safeTotalPages }, (_, index) => index + 1);

  const half = Math.floor(visible / 2);
  let start = Math.max(2, safePage - half);
  const end = safePage > safeTotalPages - half
    ? safeTotalPages - 1
    : Math.min(safeTotalPages - 1, start + visible - 1);
  const windowSize = end === safeTotalPages - 1 ? visible - 1 : visible;
  start = Math.max(2, end - windowSize + 1);
  const items: PaginationItem[] = [1];
  if (start > 2) items.push("ellipsis");
  for (let value = start; value <= end; value += 1) items.push(value);
  if (end < safeTotalPages - 1) items.push("ellipsis");
  items.push(safeTotalPages);
  return items;
}

export function Pagination({
  total,
  page,
  pageSize,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  onPageChange,
  onPageSizeChange,
  disabled = false,
  label = "分页"
}: {
  total: number;
  page: number;
  pageSize: number;
  pageSizeOptions?: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  disabled?: boolean;
  label?: string;
}) {
  const safeTotal = Math.max(0, Math.floor(total));
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const totalPages = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const currentPage = Math.min(totalPages, Math.max(1, Math.floor(page)));
  const goTo = (nextPage: number) => {
    if (disabled || nextPage === currentPage) return;
    onPageChange(Math.min(totalPages, Math.max(1, nextPage)));
  };
  const firstItem = safeTotal === 0 ? 0 : (currentPage - 1) * safePageSize + 1;
  const lastItem = Math.min(currentPage * safePageSize, safeTotal);

  return (
    <nav className="pagination" aria-label={label}>
      <div className="pagination-summary">
        <span>共 {safeTotal} 条记录</span>
        {onPageSizeChange && (
          <label>
            <span className="visually-hidden">每页数量</span>
            <select
              aria-label="每页数量"
              value={safePageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              disabled={disabled}
            >
              {pageSizeOptions.map((option) => <option key={option} value={option}>{option} 条/页</option>)}
            </select>
          </label>
        )}
        {safeTotal > 0 && <span className="pagination-range">{firstItem}-{lastItem}</span>}
      </div>
      <div className="pagination-controls">
        <button type="button" aria-label="第一页" title="第一页" onClick={() => goTo(1)} disabled={disabled || currentPage <= 1}>
          <ChevronsLeft aria-hidden="true" size={15} />
        </button>
        <button type="button" aria-label="上一页" title="上一页" onClick={() => goTo(currentPage - 1)} disabled={disabled || currentPage <= 1}>
          <ChevronLeft aria-hidden="true" size={15} />
        </button>
        {getPaginationItems(currentPage, totalPages).map((item, index) => item === "ellipsis"
          ? <span className="pagination-ellipsis" key={`ellipsis-${index}`} aria-hidden="true"><MoreHorizontal size={15} /></span>
          : <button
            type="button"
            key={item}
            className={item === currentPage ? "is-current" : ""}
            aria-current={item === currentPage ? "page" : undefined}
            aria-label={`第 ${item} 页`}
            onClick={() => goTo(item)}
            disabled={disabled}
          >{item}</button>)}
        <button type="button" aria-label="下一页" title="下一页" onClick={() => goTo(currentPage + 1)} disabled={disabled || currentPage >= totalPages}>
          <ChevronRight aria-hidden="true" size={15} />
        </button>
        <button type="button" aria-label="最后一页" title="最后一页" onClick={() => goTo(totalPages)} disabled={disabled || currentPage >= totalPages}>
          <ChevronsRight aria-hidden="true" size={15} />
        </button>
      </div>
    </nav>
  );
}
