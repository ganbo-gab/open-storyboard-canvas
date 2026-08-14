import type { AgentEffect } from './agentApproval';

export interface AgentPlanEstimate {
  value?: number;
  min?: number;
  max?: number;
  unit: 'seconds' | 'credits';
  confidence: 'known' | 'range' | 'unknown';
}

export interface AgentPlanStep {
  id: string;
  title: string;
  effect: AgentEffect;
  cost: AgentPlanEstimate;
  duration: AgentPlanEstimate;
}

export interface AgentPlanDraft {
  id: string;
  originalMessage: string;
  revision: number;
  steps: AgentPlanStep[];
  status: 'pending' | 'approved' | 'cancelled';
  createdAt: number;
}

const CONNECTOR_PATTERN = /(?:\r?\n+|[；;。]+|(?:，|,)?\s*(?:然后|接着|随后|并且|同时|再|最后|以及|and\s+then|then|also|finally)\s*)/gi;

function nextId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function classifyAgentPlanStep(text: string): AgentEffect {
  if (/(?:生成|生图|视频|音频|渲染|提交|调用模型|generate|render|submit|image|video|audio)/i.test(text)) {
    return 'external-submit';
  }
  if (/(?:配置|设置|服务商|供应商|模型参数|endpoint|provider|config|setting)/i.test(text)) {
    return 'config-write';
  }
  if (/(?:查看|读取|分析|检查|诊断|列出|搜索|定位|inspect|diagnos|read|list|find|locate)/i.test(text)) {
    return 'read';
  }
  return 'canvas-write';
}

function estimateFor(effect: AgentEffect): Pick<AgentPlanStep, 'cost' | 'duration'> {
  if (effect === 'external-submit') {
    return {
      cost: { unit: 'credits', confidence: 'unknown' },
      duration: { unit: 'seconds', confidence: 'range', min: 15, max: 600 },
    };
  }
  if (effect === 'read') {
    return {
      cost: { unit: 'credits', confidence: 'known', value: 0 },
      duration: { unit: 'seconds', confidence: 'range', min: 1, max: 10 },
    };
  }
  return {
    cost: { unit: 'credits', confidence: 'known', value: 0 },
    duration: { unit: 'seconds', confidence: 'range', min: 1, max: 30 },
  };
}

export function createAgentPlanStep(title = ''): AgentPlanStep {
  const normalized = title.trim().slice(0, 240);
  const effect = classifyAgentPlanStep(normalized);
  return {
    id: nextId('plan-step'),
    title: normalized,
    effect,
    ...estimateFor(effect),
  };
}

export function buildAgentPlanDraft(message: string, now = Date.now()): AgentPlanDraft | null {
  const normalized = message.trim();
  if (!normalized) return null;
  const steps = normalized
    .split(CONNECTOR_PATTERN)
    .map((item) => item.replace(/^\s*(?:先|首先|第一步|\d+[.、)）])\s*/i, '').trim())
    .filter((item) => item.length >= 2)
    .slice(0, 12)
    .map(createAgentPlanStep);
  if (steps.length < 2) return null;
  return {
    id: nextId('plan'),
    originalMessage: normalized,
    revision: 1,
    steps,
    status: 'pending',
    createdAt: now,
  };
}

export function compileAgentPlanMessage(plan: AgentPlanDraft): string {
  const steps = plan.steps
    .filter((step) => step.title.trim())
    .map((step, index) => `${index + 1}. [${step.effect}] ${step.title.trim()}`)
    .join('\n');
  if (!steps) return plan.originalMessage;
  return [
    'The user reviewed and approved this execution plan. Follow the edited steps in order:',
    steps,
    'Each tool call follows the current Manual/Auto execution policy. Do not treat plan approval as a node-deletion approval.',
  ].join('\n');
}

export function reviseAgentPlan(
  plan: AgentPlanDraft,
  steps: AgentPlanStep[],
): AgentPlanDraft {
  return {
    ...plan,
    revision: plan.revision + 1,
    steps: steps.slice(0, 12),
  };
}

export function updateAgentPlanStep(
  step: AgentPlanStep,
  patch: Partial<Pick<AgentPlanStep, 'title' | 'effect'>>,
): AgentPlanStep {
  const title = patch.title === undefined ? step.title : patch.title.slice(0, 240);
  const effect = patch.effect ?? classifyAgentPlanStep(title);
  return {
    ...step,
    title,
    effect,
    ...estimateFor(effect),
  };
}
