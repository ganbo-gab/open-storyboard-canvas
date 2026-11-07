import type { TFunction } from 'i18next';
import { classifyCanvasAgentFailure } from '@/features/canvas/agent/application/agentFailurePolicy';
import { AgentTurnLimitError, AGENT_TURN_TOOL_CALL_LIMIT, AGENT_TURN_DEADLINE_MS } from '@/features/canvas/agent/application/agentTurnSafety';

export function agentTurnLimitText(error: AgentTurnLimitError, t: TFunction): string {
  return t(error.code === 'tool-call-limit'
    ? 'canvasAgent.failureMessages.toolCallLimitReached'
    : 'canvasAgent.failureMessages.turnDeadlineExceeded', { count: AGENT_TURN_TOOL_CALL_LIMIT, minutes: AGENT_TURN_DEADLINE_MS / 60_000 });
}

/** One readable failure text for every Agent surface; unknown failures keep their original message. */
export function readableAgentFailure(error: unknown, t: TFunction): string {
  if (error instanceof AgentTurnLimitError) return agentTurnLimitText(error, t);
  const failure = classifyCanvasAgentFailure(error);
  const message = failure.rawMessage;
  if (failure.kind === 'local-storage') return t('canvasAgent.failureMessages.localStorageFull');
  if (failure.kind === 'provider-quota') return t('canvasAgent.failureMessages.providerQuotaExceeded');
  if (failure.kind === 'provider-rate-limit') return t('canvasAgent.failureMessages.providerRateLimited');
  if (/Invalid stage_command arguments|Invalid stage_direct arguments|Invalid scene draft|invalid_union/i.test(message)) {
    return t('ui.agent.invalidToolArguments');
  }
  if (/nodeIds\.length|nodeIds.*required|Missing required.*nodeIds/i.test(message)) {
    return t('canvasAgent.failureMessages.missingNodeSelection');
  }
  if (/canvas\.query.*scope|Invalid query scope|Missing required.*scope/i.test(message)) {
    return t('canvasAgent.failureMessages.invalidQueryScope');
  }
  if (/审批.*失效|已处理|approval.*expired/i.test(message)) {
    return t('canvasAgent.failureMessages.expiredApproval');
  }
  if (/revision.*conflict|项目已切换|参数.*不一致/i.test(message)) {
    return t('canvasAgent.failureMessages.stateChanged');
  }
  if (/reasoning_content.*(?:must|Missing|required)|Missing.*reasoning_content/i.test(message)) return '供应商要求的续聊数据不完整。请更新到修复版后新建会话重试；已完成的工具操作仍保留。';
  if (/model declaration contains an unknown field/i.test(message)) return '模型配置与本机版本不兼容，请更新应用。请求在本地校验阶段被阻止。';
  const detail = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(message);
  if (detail) {
    try {
      const parsed: unknown = JSON.parse(`"${detail[1]}"`);
      if (typeof parsed === 'string') return `服务商拒绝请求：${parsed.replace(/\s*\(request[_ ]id:[^)]*\)/gi, '').slice(0, 300)}`;
    } catch { /* Keep the safe fallback below. */ }
  }
  return message.length > 400 ? `${message.slice(0, 400)}…` : message;
}
