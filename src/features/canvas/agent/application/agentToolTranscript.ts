import type { AgentModelInputItem } from '../domain/agentModel';
import { AgentModelProtocolError } from './agentProviderCodec';

/** Reject malformed tool batches locally, before another provider request can be charged. */
export function assertCompleteAgentToolTranscript(items: readonly AgentModelInputItem[]): void {
  let pending = new Set<string>();
  let resultsStarted = false;
  const fail = () => { throw new AgentModelProtocolError('工具调用记录不完整，未向供应商发送请求。请从已保存的执行记录继续，避免重复执行已完成的操作。'); };
  for (const item of items) {
    if (item.type === 'function_call') {
      if (resultsStarted && pending.size) fail();
      if (resultsStarted) { pending = new Set(); resultsStarted = false; }
      if (!item.callId || pending.has(item.callId)) fail();
      pending.add(item.callId);
    } else if (item.type === 'function_call_result') {
      if (!pending.delete(item.callId)) fail();
      resultsStarted = true;
    } else {
      if (pending.size) fail();
      resultsStarted = false;
    }
  }
  if (pending.size) fail();
}
