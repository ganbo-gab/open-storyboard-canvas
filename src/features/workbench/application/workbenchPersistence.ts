import { z } from 'zod';
import { emptyWorkbenchData, type WorkbenchData } from '../domain/types';
import { createWorkspaceDocument } from './workspaceDocument';

export type LocalStorageStatus = { mode: 'persistent' } | { mode: 'memory'; reason: string };
export interface LocalDocument<T> {
  load(): T;
  save(value: T): void;
  status(): LocalStorageStatus;
  initialize?(): Promise<void>;
  flush?(): Promise<void>;
}
/** Guarded, versioned persistence. Corrupt/future data is never overwritten. */
export function createLocalDocument<T>(key: string, initial: () => T, validate: (input: unknown) => T,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined = undefined): LocalDocument<T> {
  let value = initial();
  let status: LocalStorageStatus = { mode: 'persistent' };
  let loaded = false;
  let backend = storage;
  return {
    load() {
      if (loaded) return value;
      loaded = true;
      try {
        if (backend === undefined) backend = globalThis.localStorage ?? null;
        if (!backend) throw new Error('Local storage unavailable; changes survive only this session.');
        const raw = backend.getItem(key);
        if (raw) {
          const envelope = JSON.parse(raw);
          if (envelope.version !== 1) throw new Error('Unsupported stored version; existing data preserved.');
          value = validate(envelope.data);
        }
      } catch (error) {
        status = { mode: 'memory', reason: error instanceof Error ? error.message : 'Storage unavailable' };
      }
      return value;
    },
    save(next) {
      if (!loaded) this.load();
      value = next;
      if (status.mode === 'memory') return;
      try { backend!.setItem(key, JSON.stringify({ version: 1, data: next })); }
      catch { status = { mode: 'memory', reason: 'Storage write failed; changes survive only this session.' }; }
    },
    status: () => status,
  };
}

const kind = z.enum(['image', 'video', 'audio', 'chat']);
const reference = z.object({ id: z.string(), kind: z.enum(['image', 'video', 'audio', 'text']), source: z.string(), name: z.string().optional() });
const config = z.object({ size: z.string().optional(), aspectRatio: z.string().optional(), seconds: z.number().finite().optional(), extraParams: z.record(z.string(), z.unknown()).optional() });
const input = z.object({ conversationId: z.string().optional(), kind, prompt: z.string(), model: z.string(), config: config.optional(), references: z.array(reference).optional() });
const persistedSchema = z.object({
  selectedConversationId: z.string().nullable(),
  draft: input.omit({ conversationId: true }),
  conversations: z.record(z.string(), z.object({ id: z.string(), title: z.string(), createdAt: z.number(), updatedAt: z.number() })),
  messages: z.record(z.string(), z.object({ id: z.string(), conversationId: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), taskId: z.string(), createdAt: z.number() })),
  tasks: z.record(z.string(), z.object({
    id: z.string(), conversationId: z.string(), input,
    status: z.enum(['queued', 'submitting', 'running', 'recoverable_wait', 'materializing', 'succeeded', 'failed', 'not_found', 'unknown', 'canceled']),
    jobId: z.string().optional(), job: z.object({
      job_id: z.string(), status: z.enum(['queued', 'submitting', 'running', 'recoverable_wait', 'materializing', 'succeeded', 'failed', 'not_found', 'unknown', 'canceled']),
      result: z.string().nullable().optional(), error: z.string().nullable().optional(), warning: z.string().nullable().optional(), phase: z.string().optional(),
      external_task_id: z.string().nullable().optional(), result_url: z.string().nullable().optional(), error_category: z.string().nullable().optional(),
      network_route: z.enum(['system', 'direct', 'custom-proxy']).optional(), resumable: z.boolean().optional(), created_at: z.number().optional(), updated_at: z.number().optional(),
    }).optional(),
    results: z.array(z.object({ kind: z.enum(['image', 'video', 'audio', 'text']), source: z.string(), assetId: z.string().optional() })),
    failure: z.object({ kind: z.enum(['storage', 'configuration', 'authentication', 'quota', 'rate-limit', 'network', 'provider', 'unknown-submit', 'interrupted']), message: z.string() }).optional(),
    waitingCanceled: z.boolean(), createdAt: z.number(), updatedAt: z.number(),
  })),
});
export function createWorkbenchDocument(key = 'storyboard-copilot:workbench:v1'): LocalDocument<WorkbenchData> {
  return createWorkspaceDocument<WorkbenchData>(key, emptyWorkbenchData, (value) => persistedSchema.parse(value));
}
export const workbenchDocument = createWorkbenchDocument();
