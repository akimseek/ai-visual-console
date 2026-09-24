import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, PointerEvent, ReactNode } from "react";
import { Pencil, Plus, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";
import type { AiProviderId, AiTarget, ApiVendor, ApiVendorConfigTemplate, GatewayFailoverRule, GatewayFailoverRuleInput, GatewayFailoverRuleScope, VendorBalanceQueryConfig, VendorModelQueryConfig } from "../../types";
import { formatDate } from "../../lib/format";
import { GATEWAY_FAILOVER_DEFAULT_PATTERNS, GATEWAY_FAILOVER_DEFAULT_STATUS_CODES, PAGINATION_DEFAULT_PAGE_SIZE } from "../../../../shared/constants";
import { matchesGatewayFailoverCondition } from "../../../../shared/gateway-failover";
import { IconButton } from "../../components/icon-button";
import { Pagination } from "../../components/pagination";
import {
  buildVendorDraft,
  applyDeepSeekClaudePreset,
  renderVendorConfigPreview,
  toVendorConfigTemplate,
  visibleVendorConfigs,
  calculateVendorColumnWidths,
  VENDOR_COLUMN_MAX_WIDTHS,
  VENDOR_COLUMN_MIN_WIDTHS,
  type ApiVendorDraft,
  type VendorFieldErrors,
  type VendorFieldName
} from "./vendor-config";

// 供应商管理弹框：列表/表单两种模式，表单内按厂商展示配置文件预览并写回模板。从 App.tsx 抽出为独立组件。
// 供应商列表默认每页展示 10 条，避免供应商数量较多时一次性撑高弹框。
const VENDOR_PAGE_SIZE = PAGINATION_DEFAULT_PAGE_SIZE;
export function VendorManagerDialog({
  vendors,
  draft,
  mode,
  busy,
  error,
  fieldErrors,
  message,
  toast,
  target,
  onDraftChange,
  onFieldErrorClear,
  onNew,
  onEdit,
  onProviderChange,
  onSave,
  onDelete,
  onToggleEnabled,
  onRefreshBalance,
  onRefreshAllBalances,
  refreshingVendorIds,
  refreshingAllBalances,
  failoverRules,
  failoverRulesBusy,
  onSaveFailoverRule,
  onDeleteFailoverRule,
  onToggleFailoverRule,
  onBack,
  onClose
}: {
  vendors: ApiVendor[];
  draft: ApiVendorDraft;
  mode: "list" | "form";
  busy: string;
  error: string;
  fieldErrors: VendorFieldErrors;
  message: string;
  toast: { message: string; tone: "success" | "error" } | null;
  target?: AiTarget;
  onDraftChange: (draft: ApiVendorDraft) => void;
  onFieldErrorClear: (field: VendorFieldName) => void;
  onNew: (providerId: AiProviderId) => void;
  onEdit: (vendor: ApiVendor) => void;
  onProviderChange: (providerId: AiProviderId) => void;
  onSave: () => void;
  onDelete: (vendorId: string) => void;
  onToggleEnabled: (vendorId: string, enabled: boolean) => void;
  onRefreshBalance: (vendorId: string) => void;
  onRefreshAllBalances: () => void;
  refreshingVendorIds: string[];
  refreshingAllBalances: boolean;
  failoverRules: GatewayFailoverRule[];
  failoverRulesBusy: boolean;
  onSaveFailoverRule: (input: GatewayFailoverRuleInput) => void;
  onDeleteFailoverRule: (ruleId: string) => void;
  onToggleFailoverRule: (ruleId: string, enabled: boolean) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [deleteCandidate, setDeleteCandidate] = useState<ApiVendor | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [providerFilter, setProviderFilter] = useState<AiProviderId | "all">("all");
  const [pageSize, setPageSize] = useState(VENDOR_PAGE_SIZE);
  const [columnWidths, setColumnWidths] = useState<number[]>(() => calculateVendorColumnWidths([], 0));
  const [modelQueryText, setModelQueryText] = useState("");
  const [balanceQueryText, setBalanceQueryText] = useState("");
  const [queryConfigErrors, setQueryConfigErrors] = useState<{ model?: string; balance?: string }>({});
  const [ruleScope, setRuleScope] = useState<GatewayFailoverRuleScope>("global");
  const [ruleProvider, setRuleProvider] = useState<AiProviderId>(target?.provider || "codex");
  const [ruleVendor, setRuleVendor] = useState("");
  const [rulePattern, setRulePattern] = useState("");
  const [ruleStatusCodesText, setRuleStatusCodesText] = useState("");
  const [ruleCustomResponseStatusText, setRuleCustomResponseStatusText] = useState("");
  const [ruleCustomResponseBody, setRuleCustomResponseBody] = useState("");
  const [ruleTestText, setRuleTestText] = useState("");
  const [ruleTestStatusCodeText, setRuleTestStatusCodeText] = useState("");
  const [failoverRulesOpen, setFailoverRulesOpen] = useState(false);
  const tableContainerRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const resizeRef = useRef<{ index: number; startX: number; startWidths: number[] } | null>(null);
  const manualResizeRef = useRef(false);
  const filteredVendors = providerFilter === "all" ? vendors : vendors.filter((vendor) => vendor.providerId === providerFilter);
  const totalPages = Math.max(1, Math.ceil(filteredVendors.length / pageSize));

  useEffect(() => {
    if (mode === "list") setCurrentPage(1);
  }, [mode]);

  useEffect(() => {
    // 删除最后一页的供应商后，自动回到仍然存在的最后一页。
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  useEffect(() => {
    if (mode === "list") manualResizeRef.current = false;
  }, [mode]);

  // 仅在切换供应商表单或厂商时同步文本；输入中的合法 JSON 不应被每次按键重新格式化。
  useEffect(() => {
    if (mode !== "form") return;
    setModelQueryText(draft.modelQuery ? JSON.stringify(draft.modelQuery, null, 2) : "");
    setBalanceQueryText(draft.balanceQuery ? JSON.stringify(draft.balanceQuery, null, 2) : "");
    setQueryConfigErrors({});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, draft.id, draft.providerId]);

  useEffect(() => {
    if (mode !== "list") return;
    const container = tableContainerRef.current;
    if (!container) return;
    const updateWidths = () => {
      if (manualResizeRef.current) return;
      setColumnWidths(calculateVendorColumnWidths(measureVendorColumns(vendors, container), container.clientWidth));
    };
    updateWidths();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWidths);
    observer.observe(container);
    return () => observer.disconnect();
  }, [mode, vendors]);

  function updateDraft(patch: Partial<ApiVendorDraft>) {
    (["name", "apiBaseUrl", "apiKey", "sort", "inputPrice", "outputPrice"] as const).forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(patch, field)) onFieldErrorClear(field);
    });
    onDraftChange(buildVendorDraft({ ...draft, ...patch }));
  }

  function updateConfig(configId: string, patch: Partial<ApiVendorConfigTemplate>) {
    onDraftChange({
      ...draft,
      configs: draft.configs.map((config) => config.id === configId ? { ...config, ...patch } : config)
    });
  }

  const visibleConfigs = visibleVendorConfigs(draft);
  const deleteCandidateExists = deleteCandidate && vendors.some((vendor) => vendor.id === deleteCandidate.id);
  const pagedVendors = filteredVendors.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  // 记录拖拽起点，按像素调整相邻两列，并保留两列的最小/最大约束。
  function startColumnResize(index: number, event: PointerEvent<HTMLSpanElement>) {
    if (index >= columnWidths.length - 1) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    manualResizeRef.current = true;
    resizeRef.current = { index, startX: event.clientX, startWidths: columnWidths };
  }

  function updateQueryConfig(kind: "model" | "balance", value: string) {
    const setText = kind === "model" ? setModelQueryText : setBalanceQueryText;
    setText(value);
    if (!value.trim()) {
      setQueryConfigErrors((current) => ({ ...current, [kind]: undefined }));
      if (kind === "model") onDraftChange({ ...draft, modelQuery: undefined });
      else onDraftChange({ ...draft, balanceQuery: undefined });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("必须是 JSON 对象");
      setQueryConfigErrors((current) => ({ ...current, [kind]: undefined }));
      if (kind === "model") onDraftChange({ ...draft, modelQuery: parsed as VendorModelQueryConfig });
      else onDraftChange({ ...draft, balanceQuery: parsed as VendorBalanceQueryConfig });
    } catch (error: unknown) {
      setQueryConfigErrors((current) => ({ ...current, [kind]: error instanceof Error ? error.message : "JSON 格式无效" }));
    }
  }

  function saveForm() {
    if (queryConfigErrors.model || queryConfigErrors.balance) return;
    onSave();
  }

  function saveRule() {
    const pattern = rulePattern.trim();
    const parsedStatusCodes = parseGatewayFailoverStatusCodes(ruleStatusCodesText);
    const parsedCustomResponse = parseGatewayFailoverCustomResponse(ruleCustomResponseStatusText, ruleCustomResponseBody);
    if (failoverRulesBusy || parsedStatusCodes.error || parsedCustomResponse.error || (!pattern && parsedStatusCodes.statusCodes.length === 0)) return;
    onSaveFailoverRule({
      scope: ruleScope,
      providerId: ruleScope === "global" ? undefined : ruleProvider,
      vendorId: ruleScope === "vendor" ? ruleVendor || undefined : undefined,
      pattern,
      statusCodes: parsedStatusCodes.statusCodes,
      customResponseStatus: parsedCustomResponse.status,
      customResponseBody: parsedCustomResponse.body
    });
    setRulePattern("");
    setRuleStatusCodesText("");
    setRuleCustomResponseStatusText("");
    setRuleCustomResponseBody("");
  }

  const testProvider = ruleScope === "global" ? (target?.provider || "codex") : ruleProvider;
  const parsedRuleStatusCodes = parseGatewayFailoverStatusCodes(ruleStatusCodesText);
  const parsedRuleCustomResponse = parseGatewayFailoverCustomResponse(ruleCustomResponseStatusText, ruleCustomResponseBody);
  const parsedTestStatusCode = Number(ruleTestStatusCodeText);
  const testStatusCode = Number.isInteger(parsedTestStatusCode) && parsedTestStatusCode >= 400 && parsedTestStatusCode <= 599
    ? parsedTestStatusCode
    : undefined;
  const applicableRules = failoverRules.filter((rule) => rule.enabled && (rule.scope === "global"
    || (rule.scope === "provider" && rule.providerId === testProvider)
    || (rule.scope === "vendor" && rule.providerId === testProvider && rule.vendorId === ruleVendor)));
  const defaultRuleMatched = GATEWAY_FAILOVER_DEFAULT_STATUS_CODES.some((statusCode) => statusCode === testStatusCode)
    || GATEWAY_FAILOVER_DEFAULT_PATTERNS.some((pattern) => ruleTestText.toLocaleLowerCase().includes(pattern.toLocaleLowerCase()));
  const savedRuleMatched = applicableRules.some((rule) => matchesGatewayFailoverCondition(rule, testStatusCode, ruleTestText));
  const draftRuleMatched = !parsedRuleStatusCodes.error && matchesGatewayFailoverCondition(
    { pattern: rulePattern, statusCodes: parsedRuleStatusCodes.statusCodes },
    testStatusCode,
    ruleTestText
  );
  const ruleTestMatched = defaultRuleMatched || savedRuleMatched || draftRuleMatched;
  const ruleTestCustomResponseStatus = applicableRules.find((rule) => matchesGatewayFailoverCondition(rule, testStatusCode, ruleTestText) && rule.customResponseStatus !== undefined)?.customResponseStatus
    || (draftRuleMatched ? parsedRuleCustomResponse.status : undefined);

  function moveColumnResize(event: PointerEvent<HTMLSpanElement>) {
    const resize = resizeRef.current;
    if (!resize) return;
    const delta = event.clientX - resize.startX;
    const leftMin = VENDOR_COLUMN_MIN_WIDTHS[resize.index];
    const rightMin = VENDOR_COLUMN_MIN_WIDTHS[resize.index + 1];
    const maxLeft = Math.min(
      resize.startWidths[resize.index] + resize.startWidths[resize.index + 1] - rightMin,
      VENDOR_COLUMN_MAX_WIDTHS[resize.index]
    );
    const nextLeft = Math.max(leftMin, Math.min(resize.startWidths[resize.index] + delta, maxLeft));
    const adjustedDelta = nextLeft - resize.startWidths[resize.index];
    setColumnWidths(resize.startWidths.map((width, columnIndex) => {
      if (columnIndex === resize.index) return nextLeft;
      if (columnIndex === resize.index + 1) return resize.startWidths[columnIndex] - adjustedDelta;
      return width;
    }));
  }

  function endColumnResize(event: PointerEvent<HTMLSpanElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    resizeRef.current = null;
  }

  return (
    <>
    <div className="dialog-overlay" role="presentation">
      <section className="vendor-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="vendor-manager-title">
        <header>
          <div>
            <h2 id="vendor-manager-title">供应商管理</h2>
            <p>
              供应商信息保存在本地数据库中。参与候选池的供应商将由本地 Gateway 按协议参与请求路由和故障切换。
            </p>
          </div>
          <IconButton icon={X} label="关闭" onClick={onClose} disabled={Boolean(busy)} />
        </header>
        {mode === "list" ? (
          <div className="vendor-list-page">
            <div className="vendor-list-toolbar">
              <div className="vendor-list-count">
                <strong>历史供应商</strong>
                <span>{filteredVendors.length} 个</span>
                <label className="vendor-provider-filter">
                  <span>平台</span>
                  <select value={providerFilter} onChange={(event) => { setProviderFilter(event.target.value as AiProviderId | "all"); setCurrentPage(1); }}>
                    <option value="all">全部平台</option>
                    {(["codex", "claude", "gemini", "qoder"] as AiProviderId[]).map((item) => <option key={item} value={item}>{providerLabel(item)}</option>)}
                  </select>
                </label>
              </div>
              <div className="vendor-list-toolbar-actions">
                <button type="button" className="ui-button ui-button-primary" onClick={() => { setCurrentPage(1); onNew(providerFilter === "all" ? target?.provider || "codex" : providerFilter); }} disabled={Boolean(busy)}>
                  <Plus aria-hidden="true" size={15} strokeWidth={2} />
                  新增供应商
                </button>
                <button type="button" className="ui-button ui-button-primary" onClick={onRefreshAllBalances} disabled={Boolean(busy) || vendors.length === 0}>
                  <RefreshCw aria-hidden="true" size={15} strokeWidth={2} className={refreshingAllBalances ? "is-spinning" : undefined} />
                  刷新全部余额
                </button>
                <button type="button" className="ui-button ui-button-primary" onClick={() => setFailoverRulesOpen(true)} disabled={Boolean(busy)}>
                  <ShieldAlert aria-hidden="true" size={15} strokeWidth={2} />
                  故障规则
                </button>
              </div>
            </div>
            {toast && <div className={`vendor-list-toast ${toast.tone}`}>{toast.message}</div>}
            <div ref={tableContainerRef} className="vendor-list-table">
              {filteredVendors.length === 0 ? (
                <div className="vendor-empty">暂无供应商。</div>
              ) : (
                <table
                  ref={tableRef}
                  style={{
                    // 列宽总和由计算函数确定，表格不再同时参与百分比布局，避免浏览器二次分配。
                    width: `${columnWidths.reduce((total, width) => total + width, 0)}px`,
                    minWidth: `${columnWidths.reduce((total, width) => total + width, 0)}px`,
                    tableLayout: "fixed"
                  }}
                >
                  <colgroup>
                    {columnWidths.map((width, index) => <col key={index} style={{ width: `${width}px` }} />)}
                  </colgroup>
                  <thead>
                    <tr>
                      {["名称", "厂商", "余额", "排序", "创建时间", "参与候选池", "操作"].map((label, index) => (
                        <th key={label} scope="col" className={index === 6 ? "vendor-table-actions-heading" : undefined}>
                          {label}
                          {index < 6 && (
                            <span
                              className="vendor-column-resizer"
                              role="separator"
                              aria-label={`调整${label}列宽`}
                              aria-orientation="vertical"
                              onPointerDown={(event) => startColumnResize(index, event)}
                              onPointerMove={moveColumnResize}
                              onPointerUp={endColumnResize}
                              onPointerCancel={endColumnResize}
                            />
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pagedVendors.map((vendor) => (
                      <tr key={vendor.id}>
                        <VendorTableCell className="vendor-name-cell-content">
                          <div className="vendor-list-main">
                            <strong>{vendor.name}</strong>
                            <span title={vendor.apiBaseUrl}>{vendor.apiBaseUrl}</span>
                          </div>
                        </VendorTableCell>
                        <VendorTableCell className="vendor-provider-cell">
                          <span className="vendor-provider-name">{providerLabel(vendor.providerId)}</span>
                          {vendor.gatewayHealth && <small className={`vendor-health-status ${vendor.gatewayHealth.status}`}>
                            {formatGatewayHealthStatus(vendor.gatewayHealth.status)}
                          </small>}
                        </VendorTableCell>
                        <VendorTableCell className="vendor-balance-placeholder" title={vendor.balanceError || vendor.balanceQueriedAt || undefined}>
                          <span className="vendor-balance-value">{renderVendorBalance(vendor, refreshingAllBalances || refreshingVendorIds.includes(vendor.id))}</span>
                          <IconButton
                            icon={RefreshCw}
                            label={`刷新 ${vendor.name} 的余额`}
                            className={`vendor-balance-refresh ${refreshingVendorIds.includes(vendor.id) ? "is-spinning" : ""}`}
                            onClick={() => onRefreshBalance(vendor.id)}
                            disabled={Boolean(busy) || refreshingAllBalances || refreshingVendorIds.includes(vendor.id)}
                          />
                        </VendorTableCell>
                        <VendorTableCell>{vendor.sort}</VendorTableCell>
                        <VendorTableCell title={vendor.createdAt}>{formatDate(vendor.createdAt)}</VendorTableCell>
                        <VendorTableCell>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={vendor.enabled === true}
                            aria-label={`${vendor.name}${vendor.enabled ? "已参与候选池" : "未参与候选池"}`}
                            className={`vendor-candidate-toggle ${vendor.enabled ? "active" : ""}`}
                            onClick={() => onToggleEnabled(vendor.id, !vendor.enabled)}
                            disabled={Boolean(busy)}
                          ><span /></button>
                        </VendorTableCell>
                        <td className="vendor-actions-cell">
                          <div className="vendor-card-actions">
                            <button type="button" className="ui-button ui-button-secondary" onClick={() => onEdit(vendor)} disabled={Boolean(busy)}>
                              <Pencil aria-hidden="true" size={14} strokeWidth={2} />
                              编辑
                            </button>
                            <button type="button" className="ui-button ui-button-danger" onClick={() => setDeleteCandidate(vendor)} disabled={Boolean(busy)}>
                              <Trash2 aria-hidden="true" size={14} strokeWidth={2} />
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {vendors.length > 0 && (
              <Pagination
                total={filteredVendors.length}
                page={currentPage}
                pageSize={pageSize}
                onPageChange={setCurrentPage}
                onPageSizeChange={(nextPageSize) => {
                  setPageSize(nextPageSize);
                  setCurrentPage(1);
                }}
                label="供应商分页"
              />
            )}
            {deleteCandidateExists && (
              <div className="vendor-confirm-overlay" role="presentation">
                <section className="vendor-confirm-dialog" role="alertdialog" aria-modal="true">
                  <h3>删除供应商</h3>
                  <p>确认删除供应商「{deleteCandidate.name}」？此操作不会还原已写入的 CLI 配置。</p>
                  <div>
                    <button type="button" className="ui-button ui-button-secondary" onClick={() => setDeleteCandidate(null)} disabled={Boolean(busy)}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="ui-button ui-button-danger"
                      onClick={() => {
                        const vendorId = deleteCandidate.id;
                        setDeleteCandidate(null);
                        onDelete(vendorId);
                      }}
                      disabled={Boolean(busy)}
                    >
                      删除
                    </button>
                  </div>
                </section>
              </div>
            )}
          </div>
        ) : (
          <div className="vendor-editor">
            <div className="vendor-target-summary">
              <span>供应商平台</span>
              <strong>{providerLabel(draft.providerId)}</strong>
              <small>供应商保存在应用数据库；维护记录无需选择 CLI 目标。</small>
            </div>
            <div className="vendor-provider-picker">
              <span>模型厂商</span>
              <div>
                {(["codex", "claude", "gemini", "qoder"] as AiProviderId[]).map((nextProviderId) => (
                  <button
                    key={nextProviderId}
                    type="button"
                    className={`ui-button ui-button-secondary ${draft.providerId === nextProviderId ? "active" : ""}`}
                    onClick={() => onProviderChange(nextProviderId)}
                  >
                    {providerLabel(nextProviderId)}
                  </button>
                ))}
              </div>
              {draft.providerId === "claude" && !draft.id && (
                <div className="vendor-deepseek-preset">
                  <button
                    type="button"
                    className="ui-button ui-button-secondary"
                    onClick={() => onDraftChange(applyDeepSeekClaudePreset(draft))}
                  >
                    使用 DeepSeek 预设
                  </button>
                  <small>仅用于 Claude Code；当前不兼容 Codex Responses API。</small>
                </div>
              )}
            </div>
            <div className="vendor-form-grid">
              <label className="required">
                <span>供应商名称</span>
                <input
                  value={draft.name}
                  aria-invalid={Boolean(fieldErrors.name)}
                  onChange={(event) => updateDraft({ name: event.target.value })}
                />
                {fieldErrors.name && <small>{fieldErrors.name}</small>}
              </label>
              <label className="required">
                <span>API 请求地址</span>
                <input
                  value={draft.apiBaseUrl}
                  aria-invalid={Boolean(fieldErrors.apiBaseUrl)}
                  onChange={(event) => updateDraft({ apiBaseUrl: event.target.value })}
                />
                {fieldErrors.apiBaseUrl && <small>{fieldErrors.apiBaseUrl}</small>}
              </label>
              <label className="required">
                <span>API Key</span>
                <input
                  value={draft.apiKey}
                  type="text"
                  placeholder={draft.id ? "留空以保留现有 API Key" : "输入 API Key"}
                  aria-invalid={Boolean(fieldErrors.apiKey)}
                  onChange={(event) => updateDraft({ apiKey: event.target.value })}
                />
                {fieldErrors.apiKey && <small>{fieldErrors.apiKey}</small>}
              </label>
              <label>
                <span className="vendor-required-label">排序</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  inputMode="numeric"
                  value={draft.sort ?? ""}
                  aria-invalid={Boolean(fieldErrors.sort)}
                  onChange={(event) => updateDraft({ sort: parseSortInput(event.target.value) })}
                />
                {fieldErrors.sort && <small>{fieldErrors.sort}</small>}
              </label>
              <label>
                <span>输入费率(百万 Token)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={draft.pricing?.inputPerMillionUsd ?? ""}
                  aria-invalid={Boolean(fieldErrors.inputPrice)}
                  onChange={(event) => updateDraft({ pricing: { ...draft.pricing, inputPerMillionUsd: parsePriceInput(event.target.value) } })}
                />
                {fieldErrors.inputPrice && <small>{fieldErrors.inputPrice}</small>}
              </label>
              <label>
                <span>输出费率（百万 Token）</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={draft.pricing?.outputPerMillionUsd ?? ""}
                  aria-invalid={Boolean(fieldErrors.outputPrice)}
                  onChange={(event) => updateDraft({ pricing: { ...draft.pricing, outputPerMillionUsd: parsePriceInput(event.target.value) } })}
                />
                {fieldErrors.outputPrice && <small>{fieldErrors.outputPrice}</small>}
              </label>
            </div>
            <div className="vendor-query-config-grid">
              <label>
                <span>模型查询配置（高级 JSON，可选）</span>
                <textarea
                  value={modelQueryText}
                  rows={6}
                  placeholder={'例如：{"endpoint":"/v1/models","authMode":"bearer"}'}
                  aria-invalid={Boolean(queryConfigErrors.model)}
                  onChange={(event) => updateQueryConfig("model", event.target.value)}
                />
                {queryConfigErrors.model && <small>{queryConfigErrors.model}</small>}
              </label>
              <label>
                <span>余额查询配置（高级 JSON，可选）</span>
                <textarea
                  value={balanceQueryText}
                  rows={6}
                  placeholder={'例如：{"template":"new-api"}'}
                  aria-invalid={Boolean(queryConfigErrors.balance)}
                  onChange={(event) => updateQueryConfig("balance", event.target.value)}
                />
                {queryConfigErrors.balance && <small>{queryConfigErrors.balance}</small>}
              </label>
            </div>
            <div className="vendor-config-heading">
              <strong>配置模板（兼容模式）：</strong>
              <label>
                <input
                  type="checkbox"
                  checked={draft.enabled !== false}
                  onChange={(event) => updateDraft({ enabled: event.target.checked })}
                />
                <span>参与候选池</span>
              </label>
            </div>
            <div className="vendor-config-list">
              {visibleConfigs.length === 0 ? (
                <div className="vendor-config-empty">当前平台没有可用的兼容配置模板。</div>
              ) : visibleConfigs.map((config) => (
                <div key={config.id || `${config.providerId}-${config.targetPath}`} className="vendor-config-editor">
                  <h3>{configFileName(config.targetPath)}</h3>
                  <label>
                    <span>配置文件预览</span>
                    <VendorConfigPreviewEditor
                      value={renderVendorConfigPreview(config, draft)}
                      onChange={(event) => updateConfig(config.id!, { content: toVendorConfigTemplate(event.target.value, draft) })}
                    />
                  </label>
                </div>
              ))}
            </div>
          </div>
        )}
        {(busy || error || message) && (
          <section className="vendor-manager-message" aria-live="polite">
            {busy && <strong>{busy}</strong>}
            {message && <span>{message}</span>}
            {error && <pre>{error}</pre>}
          </section>
        )}
        {mode === "form" && (
          <footer>
            <button type="button" className="ui-button ui-button-secondary" onClick={onBack} disabled={Boolean(busy)}>
              返回
            </button>
            <button type="button" className="ui-button ui-button-primary" onClick={saveForm} disabled={Boolean(busy) || Boolean(queryConfigErrors.model || queryConfigErrors.balance)}>
              保存
            </button>
          </footer>
        )}
      </section>
    </div>
    {failoverRulesOpen && (
      <div className="dialog-overlay" role="presentation">
        <section className="gateway-failover-rules-dialog" role="dialog" aria-modal="true" aria-labelledby="gateway-failover-rules-dialog-title">
          <header>
            <div>
              <h2 id="gateway-failover-rules-dialog-title">Gateway 故障规则</h2>
              <p>识别容量、限流和临时不可用响应。内置规则始终生效；自定义规则按已填写条件同时匹配。</p>
            </div>
            <div className="gateway-failover-rules-header-actions">
              <span>{failoverRules.length} 条自定义规则</span>
              <IconButton icon={X} label="关闭故障规则" onClick={() => setFailoverRulesOpen(false)} disabled={failoverRulesBusy} />
            </div>
          </header>
          <GatewayFailoverRulesPanel
            vendors={vendors}
            rules={failoverRules}
            busy={failoverRulesBusy}
            scope={ruleScope}
            providerId={ruleProvider}
            vendorId={ruleVendor}
            pattern={rulePattern}
            statusCodesText={ruleStatusCodesText}
            statusCodeError={parsedRuleStatusCodes.error || ""}
            customResponseStatusText={ruleCustomResponseStatusText}
            customResponseBody={ruleCustomResponseBody}
            customResponseError={parsedRuleCustomResponse.error || ""}
            testText={ruleTestText}
            testStatusCodeText={ruleTestStatusCodeText}
            testMatched={Boolean(ruleTestMatched)}
            testCustomResponseStatus={ruleTestCustomResponseStatus}
            onScopeChange={setRuleScope}
            onProviderChange={setRuleProvider}
            onVendorChange={setRuleVendor}
            onPatternChange={setRulePattern}
            onStatusCodesTextChange={setRuleStatusCodesText}
            onCustomResponseStatusTextChange={setRuleCustomResponseStatusText}
            onCustomResponseBodyChange={setRuleCustomResponseBody}
            onTestTextChange={setRuleTestText}
            onTestStatusCodeTextChange={setRuleTestStatusCodeText}
            onSave={saveRule}
            onDelete={onDeleteFailoverRule}
            onToggle={onToggleFailoverRule}
          />
          <footer>
            <button type="button" className="ui-button ui-button-secondary" onClick={() => setFailoverRulesOpen(false)} disabled={failoverRulesBusy}>关闭</button>
          </footer>
        </section>
      </div>
    )}
    </>
  );
}

function parsePriceInput(value: string) {
  if (!value.trim()) return undefined;
  const normalized = value.replace(/[^0-9.]/g, "");
  const [integer = "", fraction = ""] = normalized.split(".");
  const text = `${integer || "0"}.${fraction.slice(0, 2)}`;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseGatewayFailoverStatusCodes(value: string) {
  if (!value.trim()) return { statusCodes: [] as number[] };
  const parts = value.split(/[\s,，]+/).filter(Boolean);
  const statusCodes = parts.map(Number);
  if (statusCodes.some((statusCode) => !Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599)) {
    return { statusCodes: [] as number[], error: "状态码需为 400 到 599 之间的整数，可用逗号分隔。" };
  }
  return { statusCodes: [...new Set(statusCodes)].sort((left, right) => left - right) };
}

function parseGatewayFailoverCustomResponse(statusText: string, body: string) {
  const hasStatus = Boolean(statusText.trim());
  const hasBody = Boolean(body.trim());
  if (!hasStatus && !hasBody) return { status: undefined, body: undefined };
  if (!hasStatus || !hasBody) return { error: "自定义返回状态码和内容必须同时配置。" };
  const status = Number(statusText.trim());
  if (!Number.isInteger(status) || status < 100 || status > 599) return { error: "自定义返回状态码需为 100 到 599 之间的整数。" };
  try {
    JSON.parse(body);
  } catch {
    return { error: "自定义返回内容必须是合法 JSON。" };
  }
  if (new TextEncoder().encode(body).byteLength > 32 * 1024) return { error: "自定义返回内容不能超过 32 KB。" };
  return { status, body };
}

function GatewayFailoverRulesPanel({
  vendors,
  rules,
  busy,
  scope,
  providerId,
  vendorId,
  pattern,
  statusCodesText,
  statusCodeError,
  customResponseStatusText,
  customResponseBody,
  customResponseError,
  testText,
  testStatusCodeText,
  testMatched,
  testCustomResponseStatus,
  onScopeChange,
  onProviderChange,
  onVendorChange,
  onPatternChange,
  onStatusCodesTextChange,
  onCustomResponseStatusTextChange,
  onCustomResponseBodyChange,
  onTestTextChange,
  onTestStatusCodeTextChange,
  onSave,
  onDelete,
  onToggle
}: {
  vendors: ApiVendor[];
  rules: GatewayFailoverRule[];
  busy: boolean;
  scope: GatewayFailoverRuleScope;
  providerId: AiProviderId;
  vendorId: string;
  pattern: string;
  statusCodesText: string;
  statusCodeError: string;
  customResponseStatusText: string;
  customResponseBody: string;
  customResponseError: string;
  testText: string;
  testStatusCodeText: string;
  testMatched: boolean;
  testCustomResponseStatus?: number;
  onScopeChange: (scope: GatewayFailoverRuleScope) => void;
  onProviderChange: (providerId: AiProviderId) => void;
  onVendorChange: (vendorId: string) => void;
  onPatternChange: (pattern: string) => void;
  onStatusCodesTextChange: (statusCodes: string) => void;
  onCustomResponseStatusTextChange: (status: string) => void;
  onCustomResponseBodyChange: (body: string) => void;
  onTestTextChange: (text: string) => void;
  onTestStatusCodeTextChange: (statusCode: string) => void;
  onSave: () => void;
  onDelete: (ruleId: string) => void;
  onToggle: (ruleId: string, enabled: boolean) => void;
}) {
  return (
    <section className="vendor-failover-rules" aria-labelledby="vendor-failover-rules-title">
      <section className="vendor-failover-rule-section" aria-labelledby="vendor-failover-rules-title">
        <div className="vendor-failover-section-heading">
          <strong id="vendor-failover-rules-title">内置规则</strong>
          <span>始终生效</span>
        </div>
      <div className="vendor-failover-defaults">
        <code>HTTP {GATEWAY_FAILOVER_DEFAULT_STATUS_CODES.join(", ")}</code>
        {GATEWAY_FAILOVER_DEFAULT_PATTERNS.map((item) => <code key={item}>{item}</code>)}
      </div>
      </section>
      <section className="vendor-failover-rule-section" aria-labelledby="vendor-failover-custom-title">
        <div className="vendor-failover-section-heading">
          <strong id="vendor-failover-custom-title">自定义规则</strong>
          <span>可限定全局、Provider 或供应商</span>
        </div>
      {rules.length > 0 && (
        <div className="vendor-failover-rule-table-wrap">
          <table className="vendor-failover-rule-table">
            <thead>
              <tr>
                <th scope="col">匹配条件</th>
                <th scope="col">作用范围</th>
                <th scope="col">失败响应</th>
                <th scope="col">状态</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className={rule.enabled ? undefined : "disabled"}>
                  <td><code title={formatRuleConditions(rule)}>{formatRuleConditions(rule)}</code></td>
                  <td>{formatRuleScope(rule, vendors)}</td>
                  <td>{rule.customResponseStatus !== undefined ? `HTTP ${rule.customResponseStatus}` : "网关默认响应"}</td>
                  <td>
                    <button
                      type="button"
                      className={`vendor-candidate-toggle${rule.enabled ? " active" : ""}`}
                      role="switch"
                      aria-checked={rule.enabled}
                      aria-label={`${formatRuleConditions(rule)}${rule.enabled ? "已启用" : "已停用"}`}
                      onClick={() => onToggle(rule.id, !rule.enabled)}
                      disabled={busy}
                    ><span /></button>
                  </td>
                  <td className="vendor-failover-rule-actions">
                    <IconButton icon={Trash2} label={`删除规则 ${rule.pattern}`} onClick={() => onDelete(rule.id)} disabled={busy} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rules.length === 0 && <p className="vendor-failover-empty">尚未添加自定义规则</p>}
      </section>
      <section className="vendor-failover-rule-section" aria-labelledby="vendor-failover-editor-title">
        <div className="vendor-failover-section-heading">
          <strong id="vendor-failover-editor-title">添加规则</strong>
        </div>
      <div className="vendor-failover-rule-editor">
        <label className="vendor-failover-scope-field">
          <span>作用域</span>
          <select value={scope} onChange={(event) => onScopeChange(event.target.value as GatewayFailoverRuleScope)}>
            <option value="global">全局</option>
            <option value="provider">指定 Provider</option>
            <option value="vendor">指定供应商</option>
          </select>
        </label>
        {scope !== "global" && <label className="vendor-failover-provider-field">
          <span>Provider</span>
          <select value={providerId} onChange={(event) => onProviderChange(event.target.value as AiProviderId)}>
            {(["codex", "claude", "gemini", "qoder"] as AiProviderId[]).map((item) => <option key={item} value={item}>{providerLabel(item)}</option>)}
          </select>
        </label>}
        {scope === "vendor" && <label className="vendor-failover-vendor-field">
          <span>供应商</span>
          <select value={vendorId} onChange={(event) => onVendorChange(event.target.value)}>
            <option value="">请选择供应商</option>
            {vendors.filter((vendor) => vendor.providerId === providerId).map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
          </select>
        </label>}
        <label className="vendor-failover-pattern-field">
          <span>错误信息包含</span>
          <input value={pattern} maxLength={200} placeholder="例如：credit insufficient balance" onChange={(event) => onPatternChange(event.target.value)} />
        </label>
        <label className="vendor-failover-status-field">
          <span>HTTP 状态码</span>
          <input value={statusCodesText} inputMode="numeric" aria-invalid={Boolean(statusCodeError)} placeholder="例如：400, 429" onChange={(event) => onStatusCodesTextChange(event.target.value)} />
          {statusCodeError && <small className="form-field-error">{statusCodeError}</small>}
        </label>
        <label className="vendor-failover-custom-status-field">
          <span>自定义返回状态码（可选）</span>
          <input value={customResponseStatusText} inputMode="numeric" aria-invalid={Boolean(customResponseError)} placeholder="例如：503" onChange={(event) => onCustomResponseStatusTextChange(event.target.value)} />
        </label>
        <label className="vendor-failover-custom-response-field">
          <span>自定义返回内容（JSON，可选）</span>
          <textarea value={customResponseBody} rows={3} aria-invalid={Boolean(customResponseError)} placeholder={'例如：{"error":"provider unavailable"}'} onChange={(event) => onCustomResponseBodyChange(event.target.value)} />
          {customResponseError && <small className="form-field-error">{customResponseError}</small>}
        </label>
        <button type="button" className="ui-button ui-button-secondary vendor-failover-add-rule" onClick={onSave} disabled={busy || (!pattern.trim() && parseGatewayFailoverStatusCodes(statusCodesText).statusCodes.length === 0) || Boolean(parseGatewayFailoverStatusCodes(statusCodesText).error) || Boolean(parseGatewayFailoverCustomResponse(customResponseStatusText, customResponseBody).error) || (scope === "vendor" && !vendorId)}>
          <Plus aria-hidden="true" size={14} />
          添加规则
        </button>
      </div>
      </section>
      <section className="vendor-failover-rule-section vendor-failover-rule-test" aria-labelledby="vendor-failover-test-title">
        <div className="vendor-failover-section-heading vendor-failover-test-heading">
          <strong id="vendor-failover-test-title">规则测试</strong>
          <span>输入状态码和供应商错误内容，查看是否命中</span>
        </div>
        <label>
          <span>HTTP 状态码</span>
          <input type="number" min={400} max={599} value={testStatusCodeText} placeholder="例如：400" onChange={(event) => onTestStatusCodeTextChange(event.target.value)} />
        </label>
        <label>
          <span>错误信息</span>
          <input value={testText} placeholder="粘贴供应商返回的错误信息" onChange={(event) => onTestTextChange(event.target.value)} />
        </label>
        {(testText.trim() || testStatusCodeText.trim()) && <small className={testMatched ? "matched" : "not-matched"}>{testMatched ? `将触发故障切换${testCustomResponseStatus ? `；最终失败时返回 HTTP ${testCustomResponseStatus}` : "；未配置自定义响应"}` : "不会触发故障切换"}</small>}
      </section>
    </section>
  );
}

function formatRuleScope(rule: GatewayFailoverRule, vendors: ApiVendor[]) {
  if (rule.scope === "global") return "全局";
  if (rule.scope === "provider") return providerLabel(rule.providerId!);
  return vendors.find((vendor) => vendor.id === rule.vendorId)?.name || "已删除供应商";
}

function formatRuleConditions(rule: GatewayFailoverRule) {
  return [rule.statusCodes?.length ? `HTTP ${rule.statusCodes.join(", ")}` : "", rule.pattern].filter(Boolean).join(" · ");
}

function parseSortInput(value: string) {
  // 保留空值，让必填校验明确提示，而不是把用户清空的输入悄悄改回 0。
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

// 单元格内容较短时居中，实际溢出时切换为左对齐，避免长地址被截断后仍留在中间。
function VendorTableCell({
  children,
  className = "",
  title
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const measure = () => {
      const descendants = Array.from(element.querySelectorAll<HTMLElement>("*"));
      setOverflowing(
        element.scrollWidth > element.clientWidth + 1
        || descendants.some((child) => child.scrollWidth > child.clientWidth + 1)
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children]);

  return (
    <td title={title} className="vendor-table-cell">
      <div
        ref={contentRef}
        className={`vendor-table-cell-content ${className} ${overflowing ? "is-overflowing" : "is-centered"}`}
      >
        {children}
      </div>
    </td>
  );
}

function VendorConfigPreviewEditor({
  value,
  onChange
}: {
  value: string;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}) {
  const lineCount = Math.max(1, value.split(/\r\n|\r|\n/).length);
  const rows = Math.max(3, lineCount);
  return (
    <div className="vendor-config-preview-editor">
      <pre aria-hidden="true">{Array.from({ length: lineCount }, (_item, index) => index + 1).join("\n")}</pre>
      <textarea
        value={value}
        rows={rows}
        wrap="off"
        spellCheck={false}
        onChange={onChange}
      />
    </div>
  );
}

function providerLabel(providerId: AiProviderId) {
  if (providerId === "gemini") return "Gemini";
  if (providerId === "claude") return "Claude";
  if (providerId === "qoder") return "Qoder CN";
  return "Codex";
}

function renderVendorBalance(vendor: ApiVendor, refreshing: boolean) {
  if (refreshing || vendor.balanceStatus === "loading") return "查询中...";
  if (vendor.balance?.remaining !== undefined) {
    const amount = formatBalanceNumber(vendor.balance.remaining);
    return `$${amount}${vendor.balanceStatus === "error" ? "（已过期）" : ""}`;
  }
  if (vendor.balanceStatus === "error") return "查询失败";
  return "未获取";
}

function formatBalanceNumber(value: number) {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatGatewayHealthStatus(status: NonNullable<ApiVendor["gatewayHealth"]>["status"]) {
  if (status === "open") return "已熔断";
  if (status === "half-open") return "探测中";
  if (status === "degraded") return "降级";
  return "健康";
}

function configFileName(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || filePath;
}

function measureVendorColumns(vendors: ApiVendor[], container: HTMLElement) {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return [];
  const fontFamily = getComputedStyle(container).fontFamily || "sans-serif";
  const measure = (value: string, fontSize = 13, fontWeight = 400) => {
    context.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    return context.measureText(value).width + 24;
  };
  const largest = (values: string[], fontSize = 13, fontWeight = 400) =>
    Math.max(...values.map((value) => measure(value, fontSize, fontWeight)));
  const providerValues = vendors.map((vendor) => {
    const status = vendor.gatewayHealth ? ` ${formatGatewayHealthStatus(vendor.gatewayHealth.status)}` : "";
    return `${providerLabel(vendor.providerId)}${status}`;
  });
  const balanceValues = vendors.map((vendor) => renderVendorBalance(vendor, false));
  return [
    largest(["名称", ...vendors.flatMap((vendor) => [vendor.name, vendor.apiBaseUrl])], 12),
    largest(["厂商", ...providerValues], 12),
    largest(["余额", "$0.00", "查询中...", "查询失败", ...balanceValues]),
    largest(["排序", ...vendors.map((vendor) => String(vendor.sort))]),
    largest(["创建时间", ...vendors.map((vendor) => formatDate(vendor.createdAt))], 12),
    largest(["参与候选池", "已开启", "已关闭"], 12),
    Math.max(measure("编辑") + measure("删除") + 6, 164)
  ];
}
