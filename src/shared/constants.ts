export const PAGINATION_DEFAULT_PAGE_SIZE = 10;
export const PAGINATION_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
export const PAGINATION_MAX_PAGE_SIZE = 50;

export const GATEWAY_LOG_CONFIG = {
  requestRingCapacity: 200,
  eventRingCapacity: 100,
  flushIntervalMs: 200,
  maxFileBytes: 2 * 1024 * 1024,
  fileName: "gateway.log",
  rotatedFileName: "gateway.log.1"
} as const;

export const GATEWAY_REQUEST_LIMITS = {
  maxBodyBytes: 32 * 1024 * 1024,
  retryBufferBytes: 2 * 1024 * 1024,
  responseCaptureBytes: 512 * 1024,
  upstreamTimeoutMs: 10 * 60 * 1000
} as const;

export const GATEWAY_ERROR_MESSAGES = {
  routeNotFound: "gateway route not found",
  unauthorized: "gateway unauthorized",
  vendorUnavailable: "gateway vendor unavailable",
  localGatewayUpstream: "供应商地址不能指向本地 Gateway。",
  noAvailableVendor: "没有可用的供应商。",
  upstreamTimeout: "上游响应超时。",
  upstreamRequestFailed: "gateway upstream request failed",
  genericFailure: "Gateway 请求失败。"
} as const;
