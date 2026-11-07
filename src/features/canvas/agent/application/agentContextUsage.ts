import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { z } from 'zod';
import type { AgentModelTurnRequest, AgentModelTurnResponse } from '../domain/agentModel';

const count = z.number().finite().nonnegative();
const breakdownSchema = z.object({ system: count, tools: count, conversation: count, media: count });
const snapshotSchema = z.object({ requestId: z.string(), modelId: z.string(), measuredAt: count,
  usedTokens: count, breakdown: breakdownSchema, basis: z.enum(['estimated', 'provider']), cachedTokens: count,
  outputTokens: count, images: count });
export type AgentContextUsage = z.infer<typeof snapshotSchema>;
const stateSchema = z.object({ sessions: z.record(z.string(), snapshotSchema) });
interface State { sessions: Record<string, AgentContextUsage> }
const store = create<State>()(persist<State>(() => ({ sessions: {} }), {
  name: 'storyboard-agent-context-usage-v1', storage: createJSONStorage(() => localStorage),
  merge: (saved, current) => { const parsed = stateSchema.safeParse(saved); return parsed.success ? parsed.data : current; },
}));

/** Conservative language-aware estimate; never count base64/URLs as language tokens. */
export function estimateAgentTextTokens(text: string): number {
  if (!text) return 0;
  const wide = (text.match(/[\u2e80-\u9fff\uac00-\ud7ff\uf900-\ufaff]/g) ?? []).length;
  return Math.ceil(wide * 1.25 + (text.length - wide) / 4);
}
function measure(value: unknown): { text: number; images: number } {
  if (typeof value === 'string') return { text: /^data:(image|audio|video)\//.test(value) ? 0 : estimateAgentTextTokens(value), images: 0 };
  if (!value || typeof value !== 'object') return { text: value == null ? 0 : 1, images: 0 };
  if (!Array.isArray(value)) {
    const image = z.object({ type: z.string().optional(), inlineData: z.unknown().optional() }).safeParse(value);
    if (image.success && (['image', 'image_url', 'input_image'].includes(image.data.type ?? '') || image.data.inlineData)) return { text: 0, images: 1 };
  }
  const items = Array.isArray(value) ? value : Object.values(value);
  return items.reduce<{ text: number; images: number }>((total, item) => { const next = measure(item); return { text: total.text + next.text + 2, images: total.images + next.images }; }, { text: 0, images: 0 });
}
const envelope = z.object({ instructions: z.unknown().optional(), system: z.unknown().optional(), system_instruction: z.unknown().optional(), systemInstruction: z.unknown().optional(),
  tools: z.unknown().optional(), messages: z.array(z.unknown()).optional(), input: z.unknown().optional(), contents: z.unknown().optional() });
const roleSchema = z.object({ role: z.string().optional() });
/** Measure the emitted protocol payload, including tool results and provider continuation, once per request. */
export function estimateAgentRequestContext(body: unknown): { breakdown: AgentContextUsage['breakdown']; images: number } {
  const data = envelope.parse(body);
  const systemMessages = data.messages?.filter(item => { const r = roleSchema.safeParse(item); return r.success && ['system', 'developer'].includes(r.data.role ?? ''); }) ?? [];
  const otherMessages = data.messages?.filter(item => !systemMessages.includes(item));
  const system = measure([data.instructions, data.system, data.system_instruction, data.systemInstruction, ...systemMessages]);
  const tools = measure(data.tools);
  const conversation = measure(otherMessages ?? data.input ?? data.contents);
  const images = system.images + conversation.images;
  return { breakdown: { system: system.text, tools: tools.text, conversation: conversation.text, media: images * 1000 }, images };
}
function save(sessionId: string, snapshot: AgentContextUsage): void {
  try {
    store.setState(({ sessions }) => ({ sessions: Object.fromEntries([...Object.entries(sessions).filter(([key]) => key !== sessionId).slice(-99), [sessionId, snapshot]]) }));
  } catch { /* Optional metrics must never prevent a request or discard its successful response. */ }
}
export function recordAgentContextRequest(request: AgentModelTurnRequest, body: unknown): string | undefined {
  const sessionId = request.model.contextSessionId;
  if (!sessionId) return;
  try {
    const measured = estimateAgentRequestContext(body);
    const requestId = crypto.randomUUID();
    save(sessionId, snapshotSchema.parse({ requestId, modelId: request.model.catalogId, measuredAt: Date.now(), usedTokens: Object.values(measured.breakdown).reduce((a, b) => a + b, 0),
      ...measured, basis: 'estimated', cachedTokens: 0, outputTokens: 0 }));
    return requestId;
  } catch { return; } // Optional accounting must not reject an otherwise valid provider payload.
}
export function recordAgentContextResponse(sessionId: string | undefined, requestId: string | undefined, usage: AgentModelTurnResponse['usage']): void {
  if (!sessionId || !requestId) return;
  try {
    const current = store.getState().sessions[sessionId];
    if (!current || current.requestId !== requestId || !(usage.inputTokens > 0)) return;
    const entries = Object.entries(current.breakdown);
    let remaining = usage.inputTokens;
    const breakdown = Object.fromEntries(entries.map(([key, value], index) => { const tokens = index === entries.length - 1 ? remaining : Math.min(remaining, Math.round(value / Math.max(1, current.usedTokens) * usage.inputTokens)); remaining -= tokens; return [key, tokens]; }));
    const snapshot = snapshotSchema.safeParse({ ...current, usedTokens: usage.inputTokens, breakdown, basis: 'provider', cachedTokens: Math.min(usage.inputTokens, usage.cachedInputTokens ?? 0), outputTokens: usage.outputTokens, measuredAt: Date.now() });
    if (snapshot.success) save(sessionId, snapshot.data);
  } catch { /* Unknown provider usage or unavailable statistics storage cannot discard a successful reply. */ }
}
export function useAgentContextUsage(sessionId: string | null | undefined): AgentContextUsage | undefined {
  return store(state => sessionId ? state.sessions[sessionId] : undefined);
}
export function readAgentContextUsage(sessionId: string): AgentContextUsage | undefined { return store.getState().sessions[sessionId]; }
