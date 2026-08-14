import type { AgentApprovalRecord } from './agentApproval';

export type CanvasAgentExecutionMode = 'manual' | 'auto';

export interface AgentAutoApprovalDecision {
  allowed: boolean;
  reason: string;
}

interface PreparedApprovalLike {
  record: AgentApprovalRecord;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Built-in Auto mode has one product-level confirmation gate: node deletion. */
export function decideAgentAutoApproval(
  approval: PreparedApprovalLike,
): AgentAutoApprovalDecision {
  const { record } = approval;
  if (record.status === 'conflicted' || record.expiresAt <= Date.now()) {
    return { allowed: false, reason: '审批预览已冲突或过期' };
  }
  if (record.toolName === 'canvas_command') {
    const command = asRecord(record.arguments);
    const commandType = typeof command?.type === 'string' ? command.type : '';
    if (!commandType) return { allowed: false, reason: '工具参数不完整' };
    if (commandType === 'node.delete') {
      return { allowed: false, reason: '删除画布节点仍需用户确认' };
    }
  }
  return { allowed: true, reason: '自动模式仅在删除画布节点前请求确认' };
}
