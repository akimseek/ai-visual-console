export type GatewayFailoverCondition = {
  pattern?: string;
  statusCodes?: number[];
};

// A single rule combines its configured conditions with AND; separate rules are ORed by the caller.
export function matchesGatewayFailoverCondition(
  condition: GatewayFailoverCondition,
  statusCode: number | undefined,
  errorText: string | undefined
) {
  const hasPattern = Boolean(condition.pattern?.trim());
  const hasStatusCodes = Boolean(condition.statusCodes?.length);
  if (!hasPattern && !hasStatusCodes) return false;

  const statusMatches = !hasStatusCodes || condition.statusCodes!.includes(statusCode || 0);
  const textMatches = !hasPattern || Boolean(errorText?.toLocaleLowerCase().includes(condition.pattern!.toLocaleLowerCase()));
  return statusMatches && textMatches;
}
