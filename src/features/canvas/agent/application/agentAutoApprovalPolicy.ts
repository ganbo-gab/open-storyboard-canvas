import type { AgentApprovalRecord } from './agentApproval';
import { inspectScopedAgentTool } from '@/features/agents/application/scopedAgentTools';

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

/** Internal and external sessions share this non-paying, non-destructive policy. */
export function decideAgentAutoApproval(
  approval: PreparedApprovalLike,
): AgentAutoApprovalDecision {
  const { record } = approval;
  if (record.status === 'conflicted' || record.expiresAt <= Date.now()) {
    return { allowed: false, reason: '审批预览已冲突或过期' };
  }
  if (record.impact.externalSideEffect || record.impact.effect === 'external-submit') {
    return { allowed: false, reason: '付费或外部提交必须明确确认，自动模式也不会跳过' };
  }
  if (record.toolName && !['canvas_command', 'diagnostics', 'config_patch', 'asset_read'].includes(record.toolName)) {
    const scope = record.impact.title.startsWith('home:') ? 'home' : 'stage';
    try {
      const { risk } = inspectScopedAgentTool(scope, record.toolName, record.arguments);
      return { allowed: risk !== 'paid' && risk !== 'destructive', reason: risk === 'paid' || risk === 'destructive' ? '付费或破坏性操作需要确认' : '自动模式的安全操作' };
    } catch {
      return { allowed: false, reason: '未知或无效的作用域工具' };
    }
  }
  if (record.toolName === 'canvas_command') {
    const command = asRecord(record.arguments);
    const commandType = typeof command?.type === 'string' ? command.type : '';
    if (!commandType) return { allowed: false, reason: '工具参数不完整' };
    if (commandType === 'node.delete') {
      return { allowed: false, reason: '删除画布节点仍需用户确认' };
    }
  }
  return { allowed: true, reason: '自动模式仅跳过非付费、非破坏性操作的确认' };
}
