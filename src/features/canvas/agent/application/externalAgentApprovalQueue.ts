import type { ExternalAgentToolRequest } from '../domain/agentModel';

export type ExternalAgentPendingApproval = {
  request: ExternalAgentToolRequest;
  summary: string;
  impactSummary: string;
};

export function enqueueExternalAgentApproval(
  current: ExternalAgentPendingApproval[],
  next: ExternalAgentPendingApproval,
): ExternalAgentPendingApproval[] {
  if (current.some((item) => item.request.callId === next.request.callId)) return current;
  return [...current, next];
}
