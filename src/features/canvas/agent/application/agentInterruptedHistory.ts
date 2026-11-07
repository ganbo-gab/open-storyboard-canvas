import type { Agent, AgentInputItem, RunState } from '@openai/agents';
import type { AgentExecutionReceipt } from './agentApproval';
import { redactSensitiveValue } from './agentRedaction';

type ToolCall = Extract<AgentInputItem, { type: 'function_call' }>;
type ToolResult = Extract<AgentInputItem, { type: 'function_call_result' }>;

function comparableItem(item: AgentInputItem): unknown {
  // The SDK strips transient tool ids before writing sessions. Do the same
  // comparison here, while retaining the saved item's actual payload below.
  if (item.type === 'function_call' || item.type === 'function_call_result') {
    const { id: _id, ...rest } = item;
    return rest;
  }
  return item.type === undefined && 'role' in item ? { ...item, type: 'message' } : item;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameItem(left: AgentInputItem, right: AgentInputItem): boolean {
  return stableJson(comparableItem(left)) === stableJson(comparableItem(right));
}

function sameTool(left: ToolCall | ToolResult, right: ToolCall | ToolResult): boolean {
  return left.callId === right.callId && left.name === right.name && left.namespace === right.namespace;
}

/**
 * Recover a terminal run from the public SDK snapshot. RunState.history prunes
 * unanswered calls, so it cannot be used as the persistence source here.
 *
 * Saved history must match this run's input/output prefix. A different turn's
 * appended message is never overwritten. Within result blocks, existing saved
 * results remain authoritative even if the SDK snapshot has fewer results.
 */
export function recoverInterruptedAgentHistory(
  persisted: readonly AgentInputItem[],
  state: Pick<RunState<unknown, Agent<unknown, 'text'>>, 'toJSON'>,
  receiptFor: (call: ToolCall) => AgentExecutionReceipt | undefined = () => undefined,
): AgentInputItem[] | undefined {
  const snapshot = state.toJSON({ includeTracingApiKey: false });
  const input: AgentInputItem[] = typeof snapshot.originalInput === 'string'
    ? [{ role: 'user', content: snapshot.originalInput }]
    : snapshot.originalInput;
  // Select only portable input and run items. Never copy modelResponses,
  // context, traces, or the provider's raw response into conversation history.
  const generated: AgentInputItem[] = snapshot.generatedItems.flatMap((item) =>
    item.type === 'tool_approval_item' ? [] : [item.rawItem]);
  return mergeInterruptedAgentHistory(persisted, [...input, ...generated], generated, receiptFor);
}

/** The latest SDK model input also retains outputs for nonstreaming failures without a RunState. */
export function recoverInterruptedAgentRequestHistory(
  persisted: readonly AgentInputItem[],
  input: readonly AgentInputItem[],
  receiptFor: (call: ToolCall) => AgentExecutionReceipt | undefined = () => undefined,
): AgentInputItem[] | undefined {
  return mergeInterruptedAgentHistory(persisted, input, input, receiptFor);
}

function mergeInterruptedAgentHistory(
  persisted: readonly AgentInputItem[],
  candidate: readonly AgentInputItem[],
  generated: readonly AgentInputItem[],
  receiptFor: (call: ToolCall) => AgentExecutionReceipt | undefined,
): AgentInputItem[] | undefined {
  const generatedCalls = new Map(generated.flatMap((item) => item.type === 'function_call' ? [[item.callId, item] as const] : []));
  const merged: AgentInputItem[] = [];
  const seenCalls = new Map<string, ToolCall>();
  const seenResults = new Set<string>();
  let savedIndex = 0;
  let nextIndex = 0;
  while (nextIndex < candidate.length || savedIndex < persisted.length) {
    const next = candidate[nextIndex];
    const saved = persisted[savedIndex];
    // A partially saved parallel batch may already contain a result while its
    // remaining calls exist only in the SDK snapshot. Keep every call ahead
    // of the result block so native provider replay still sees one full batch.
    if (next?.type === 'function_call' && saved?.type === 'function_call_result'
      && generatedCalls.has(next.callId)) {
      merged.push(next); seenCalls.set(next.callId, next); nextIndex++;
      continue;
    }
    if (next?.type === 'function_call_result' || saved?.type === 'function_call_result') {
      const results: ToolResult[] = [];
      while (candidate[nextIndex]?.type === 'function_call_result') {
        const result = candidate[nextIndex++];
        if (result.type === 'function_call_result') results.push(result);
      }
      const savedResults: ToolResult[] = [];
      while (persisted[savedIndex]?.type === 'function_call_result') {
        const result = persisted[savedIndex++];
        if (result.type !== 'function_call_result') continue;
        const call = seenCalls.get(result.callId);
        const generatedCall = generatedCalls.get(result.callId);
        const fromSnapshot = results.find((entry) => sameTool(entry, result));
        if (!call || !sameTool(call, result) || (!fromSnapshot && (!generatedCall || !sameTool(generatedCall, result)))
          || seenResults.has(result.callId) || savedResults.some((entry) => entry.callId === result.callId)) return undefined;
        savedResults.push(result);
      }
      for (const result of [...savedResults, ...results.filter((entry) => !savedResults.some((savedResult) => sameTool(entry, savedResult)))]) {
        const call = seenCalls.get(result.callId);
        if (!call || !sameTool(call, result) || seenResults.has(result.callId)) return undefined;
        merged.push(result); seenResults.add(result.callId);
      }
      continue;
    }
    if (!next || (saved && !sameItem(saved, next))) return undefined;
    const item = saved ?? next;
    merged.push(item);
    if (item.type === 'function_call') seenCalls.set(item.callId, item);
    nextIndex++;
    if (saved) savedIndex++;
  }
  return completeInterruptedAgentHistory(merged, receiptFor);
}

/** Close only an abandoned run. Preserve real outputs; never execute or imply success for a missing result. */
export function completeInterruptedAgentHistory(
  history: readonly AgentInputItem[],
  receiptFor: (call: ToolCall) => AgentExecutionReceipt | undefined = () => undefined,
): AgentInputItem[] {
  const items: AgentInputItem[] = [];
  let pending = new Map<string, ToolCall>();
  let receiving = false;
  const close = () => {
    for (const call of pending.values()) {
      const receipt = receiptFor(call);
      const output = receipt ? {
        receiptId: receipt.id, receiptStatus: receipt.status, result: receipt.output,
        recovery: receipt.safeRecovery, errorCode: receipt.errorCode,
        notice: 'Recovered from the existing execution receipt. Do not repeat completed or accepted work. Query the original job when the outcome is uncertain.',
      } : {
        ok: false, code: 'interrupted_without_result', outcome: 'unconfirmed',
        error: 'The previous run stopped without recording this tool result. Inspect current state before proceeding. Do not assume it succeeded or repeat a paid submission.',
      };
      items.push({ type: 'function_call_result', callId: call.callId, name: call.name, namespace: call.namespace, status: 'completed',
        output: JSON.stringify(redactSensitiveValue(output)) });
    }
    pending = new Map(); receiving = false;
  };
  for (const item of history) {
    if (item.type === 'function_call') {
      if (receiving || pending.has(item.callId)) close();
      pending.set(item.callId, item); items.push(item);
    } else if (item.type === 'function_call_result') {
      // A legacy orphan output cannot be sent as a provider tool message without its call.
      if (!pending.has(item.callId)) continue;
      pending.delete(item.callId); receiving = true; items.push(item);
    } else {
      if (pending.size) close();
      receiving = false; items.push(item);
    }
  }
  close();
  return items;
}
