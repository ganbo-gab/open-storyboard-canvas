import { z } from 'zod';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

const option = z.object({ label: z.string().min(1).max(160), value: z.string().min(1).max(300), description: z.string().max(500) });
export const requestUserInputSchema = z.object({
  questions: z.array(z.object({
    id: z.string().min(1).max(80), title: z.string().min(1).max(600),
    options: z.array(option).max(20), allowCustom: z.boolean(),
  })).min(1).max(3),
}).superRefine(({ questions }, ctx) => {
  if (new Set(questions.map(q => q.id)).size !== questions.length) ctx.addIssue({ code: 'custom', message: 'Question IDs must be unique' });
  for (const q of questions) {
    if (!q.allowCustom && !q.options.length) ctx.addIssue({ code: 'custom', message: 'A question needs choices or custom input' });
    if (new Set(q.options.map(o => o.value)).size !== q.options.length) ctx.addIssue({ code: 'custom', message: 'Choice values must be unique' });
  }
});
export type AgentUserInputRequest = z.infer<typeof requestUserInputSchema>;
export interface AgentQuestionBinding { projectId: string; runId: string; callId: string }
const savedAnswerSchema = z.object({ projectId: z.string(), runId: z.string(), callId: z.string(), request: requestUserInputSchema,
  answers: z.record(z.string(), z.string().max(4000)), answeredAt: z.number() });
const persistedSchema = z.object({ entries: z.array(savedAnswerSchema).max(100) });
type SavedAnswer = z.infer<typeof savedAnswerSchema>;
const store = create<{ entries: SavedAnswer[] }>()(persist<{ entries: SavedAnswer[] }>(() => ({ entries: [] }), {
  name: 'storyboard-agent-user-input-v1', storage: createJSONStorage(() => localStorage),
  merge: (saved, current) => { const parsed = persistedSchema.safeParse(saved); return parsed.success ? parsed.data : current; },
}));
function matches(a: AgentQuestionBinding, b: AgentQuestionBinding): boolean { return a.projectId === b.projectId && a.runId === b.runId && a.callId === b.callId; }
export function validateAgentUserAnswers(request: AgentUserInputRequest, answers: Record<string, string>): Record<string, string> {
  const validated: Record<string, string> = {};
  for (const q of requestUserInputSchema.parse(request).questions) {
    const value = answers[q.id]?.trim();
    if (!value || value.length > 4000 || (!q.allowCustom && !q.options.some(o => o.value === value))) throw new Error('请回答每个问题后继续。');
    validated[q.id] = value;
  }
  return validated;
}
export function answerAgentUserInput(binding: AgentQuestionBinding, request: AgentUserInputRequest, answers: Record<string, string>): void {
  const entry = savedAnswerSchema.parse({ ...binding, request, answers: validateAgentUserAnswers(request, answers), answeredAt: Date.now() });
  store.setState(({ entries }) => ({ entries: [...entries.filter(row => !matches(row, binding)).slice(-99), entry] }));
}
export function readAgentUserInputAnswer(binding: AgentQuestionBinding, request: AgentUserInputRequest): Record<string, string> | null {
  const entry = store.getState().entries.find(row => matches(row, binding));
  if (!entry || JSON.stringify(entry.request) !== JSON.stringify(request) || Date.now() - entry.answeredAt > 30 * 60_000) return null;
  return validateAgentUserAnswers(request, entry.answers);
}
