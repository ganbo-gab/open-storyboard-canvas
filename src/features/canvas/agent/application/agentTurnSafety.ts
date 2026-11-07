import { z } from 'zod';

export const AGENT_TURN_TOOL_CALL_LIMIT = 96;
export const AGENT_TURN_DEADLINE_MS = 30 * 60_000;

export interface AgentTurnSafetySnapshot {
  startedAt: number;
  toolCalls: number;
}

/** Upgrade saved turns without resetting their elapsed time or already-issued calls. */
export function normalizeAgentTurnSafetySnapshot(value: unknown, startedAt: number, serializedState: string): AgentTurnSafetySnapshot {
  if (value !== undefined) {
    if (!value || typeof value !== 'object' || !('startedAt' in value) || !('toolCalls' in value)
      || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt) || value.startedAt < 0
      || typeof value.toolCalls !== 'number' || !Number.isSafeInteger(value.toolCalls) || value.toolCalls < 0) {
      throw new Error('无法安全恢复本回合的工具调用计数和总时限，请发起新回合。');
    }
    return { startedAt: value.startedAt, toolCalls: value.toolCalls };
  }
  const calls = new Set<string>();
  // originalInput includes previous user turns. Only generated items belong to this run.
  const saved = z.object({ generatedItems: z.array(z.unknown()).default([]) }).parse(JSON.parse(serializedState));
  const pending: unknown[] = [...saved.generatedItems];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) {
      for (const child of item) pending.push(child);
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type === 'function_call' && typeof record.callId === 'string') calls.add(record.callId);
    for (const child of Object.values(record)) pending.push(child);
  }
  return { startedAt, toolCalls: calls.size };
}

export class AgentTurnLimitError extends Error {
  constructor(readonly code: 'tool-call-limit' | 'turn-deadline') {
    super(code === 'tool-call-limit'
      ? '本回合已达到 96 次工具调用上限，已安全停止。已完成结果会保留，可以继续完成剩余步骤；不会自动重新提交生成任务。'
      : '本回合已达到 30 分钟总时限，已安全停止并撤销待处理审批。已完成结果会保留，可以继续剩余步骤；已提交的生成任务请查询原任务。');
    this.name = 'AgentTurnLimitError';
  }
}

/** One instance belongs to the entire turn, including approval pauses/resumes. */
export class AgentTurnSafety {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private readonly state: AgentTurnSafetySnapshot;
  private stopped?: AgentTurnLimitError;

  constructor(snapshot?: AgentTurnSafetySnapshot, private readonly onStop?: (error: AgentTurnLimitError) => void) {
    this.signal = this.controller.signal;
    this.state = snapshot ? { ...snapshot } : { startedAt: Date.now(), toolCalls: 0 };
    if (!Number.isFinite(this.state.startedAt) || this.state.startedAt < 0
      || !Number.isSafeInteger(this.state.toolCalls) || this.state.toolCalls < 0) {
      throw new Error('无法安全恢复本回合的工具调用计数和总时限，请发起新回合。');
    }
    const remaining = this.state.startedAt + AGENT_TURN_DEADLINE_MS - Date.now();
    this.timer = globalThis.setTimeout(() => this.stop('turn-deadline'), Math.max(0, Math.min(AGENT_TURN_DEADLINE_MS, remaining)));
    // Node fixtures must not keep an otherwise-finished process alive.
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
  }

  snapshot(): AgentTurnSafetySnapshot { return { ...this.state }; }

  assertActive(): void {
    if (!this.stopped && Date.now() >= this.state.startedAt + AGENT_TURN_DEADLINE_MS) this.stop('turn-deadline');
    if (!this.stopped && this.state.toolCalls > AGENT_TURN_TOOL_CALL_LIMIT) this.stop('tool-call-limit');
    if (this.stopped) throw this.stopped;
  }

  consumeToolCalls(count: number): void {
    this.assertActive();
    if (this.state.toolCalls + count > AGENT_TURN_TOOL_CALL_LIMIT) {
      this.stop('tool-call-limit');
      throw this.stopped;
    }
    this.state.toolCalls += count;
  }

  signalFor(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([this.signal, signal]) : this.signal;
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.assertActive();
    const combined = this.signalFor(signal);
    combined.throwIfAborted();
    const { promise: cancelled, reject } = Promise.withResolvers<never>();
    const abort = () => reject(this.stopped ?? combined.reason);
    combined.addEventListener('abort', abort, { once: true });
    try {
      const result = await Promise.race([operation(combined), cancelled]);
      this.assertActive();
      return result;
    } finally {
      combined.removeEventListener('abort', abort);
    }
  }

  dispose(): void {
    if (this.timer !== undefined) globalThis.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private stop(code: AgentTurnLimitError['code']): void {
    if (this.stopped) return;
    this.stopped = new AgentTurnLimitError(code);
    this.dispose();
    this.controller.abort(this.stopped);
    this.onStop?.(this.stopped);
  }
}
