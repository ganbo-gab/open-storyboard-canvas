import type { AgentApprovalRecord } from './agentApproval';
import { inspectScopedAgentTool } from '@/features/agents/application/scopedAgentTools';

export type CanvasAgentExecutionMode = 'manual' | 'auto' | 'full';

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
  mode: CanvasAgentExecutionMode = 'auto',
): AgentAutoApprovalDecision {
  const { record } = approval;
  if (record.status === 'conflicted' || record.expiresAt <= Date.now()) {
    return { allowed: false, reason: '审批预览已冲突或过期' };
  }
  if (record.toolName === 'request_user_input') return { allowed: false, reason: '等待用户补充必要信息' };
  if (mode === 'manual') return { allowed: false, reason: '请求确认模式' };
  if (mode === 'full') return { allowed: true, reason: '用户已选择完全执行；仅限应用提供的工具，保留预算与幂等校验' };
  if (record.impact.externalSideEffect || record.impact.effect === 'external-submit') {
    return { allowed: false, reason: '付费或外部提交必须明确确认，自动模式也不会跳过' };
  }
  if (record.toolName === 'channel_create' || record.toolName === 'channel_update'
    || record.toolName === 'integration_comfy_apply' || record.toolName === 'integration_image_host_apply') {
    return { allowed: false, reason: '接入配置写入必须明确确认，自动模式不会跳过' };
  }
  if (record.toolName && !['canvas_command', 'diagnostics', 'config_patch', 'asset_read'].includes(record.toolName)) {
    const scope = record.impact.title.startsWith('home:') ? 'home' : record.impact.title.startsWith('canvas:') ? 'canvas' : 'stage';
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

/** Read-only queries remain direct; every mutation obeys the selected mode. */
export function shouldAutomaticallyResolveAgentApproval(approval: PreparedApprovalLike, mode: CanvasAgentExecutionMode): boolean {
  if (approval.record.toolName === 'request_user_input') return false;
  return (approval.record.impact.effect === 'read' && approval.record.toolName !== 'asset_read')
    || decideAgentAutoApproval(approval, mode).allowed;
}
