import { create } from 'zustand';
import { z } from 'zod';
import type { GenerationJobState } from '@/commands/ai';
import { externalizeAssetMedia } from '@/features/assets/application/assetMediaStorage';
import { createWorkspaceDocument } from '@/features/workbench/application/workspaceDocument';
import type { LocalDocument, LocalStorageStatus } from '@/features/workbench/application/workbenchPersistence';
import { useWorkbenchStore } from '@/features/workbench/store/workbenchStore';
import type { WorkbenchTask } from '@/features/workbench/domain/types';
import { CANVAS_NODE_TYPES, type CanvasNodeData } from '@/features/canvas/domain/canvasNodes';
import { filterGenerationHistory, projectWorkbenchHistory, type GenerationHistoryRecord, type HistoryAssetReference, type HistoryQuery } from './history';

export type HistoryEvent = { type: 'record'; record: GenerationHistoryRecord }
  | { type: 'status'; id: string; status: GenerationJobState; outputs: HistoryAssetReference[]; error?: string; jobIds?: string[]; resultNodeIds?: string[] }
  | { type: 'agent-task'; taskId: string };
export interface HistoryData { events: HistoryEvent[] }
const statusSchema = z.enum(['queued', 'submitting', 'running', 'recoverable_wait', 'materializing', 'succeeded', 'failed', 'not_found', 'unknown', 'canceled']);
const referenceSchema = z.object({ kind: z.enum(['image', 'video', 'audio', 'text']), source: z.string(), id: z.string(), name: z.string().optional() });
const outputSchema = z.object({ kind: z.enum(['image', 'video', 'audio', 'text', 'model']), source: z.string(), assetId: z.string().optional(), importedModelId: z.string().optional() });
const recordSchema: z.ZodType<GenerationHistoryRecord> = z.object({
  id: z.string().min(1), createdAt: z.number().finite(), surface: z.enum(['canvas', 'workbench', 'agent']),
  projectId: z.string().optional(), projectAttribution: z.enum(['submission', 'current-conversation']).optional(), currentProjectId: z.string().nullable().optional(), nodeId: z.string().optional(), conversationId: z.string().optional(), taskId: z.string().optional(),
  jobIds: z.array(z.string()).optional(), resultNodeIds: z.array(z.string()).optional(),
  modelRef: z.string(), modeId: z.string().optional(), prompt: z.string(), upstreamPrompt: z.string().optional(), status: statusSchema,
  outputs: z.array(outputSchema), error: z.string().optional(), references: z.array(referenceSchema),
  params: z.object({
    kind: z.enum(['image', 'video', 'audio', 'chat']).optional(),
    config: z.object({ size: z.string().optional(), aspectRatio: z.string().optional(), seconds: z.number().finite().optional(), extraParams: z.record(z.string(), z.unknown()).optional() }).optional(),
    referenceSlots: z.record(z.string(), z.array(z.string())).optional(),
    nodeType: z.enum(Object.values(CANVAS_NODE_TYPES)).optional(),
    nodeData: z.custom<CanvasNodeData>(value => !!value && typeof value === 'object' && !Array.isArray(value)).optional(),
    tool: z.object({ id: z.string(), prompt: z.string().optional(), params: z.record(z.string(), z.unknown()).optional() }).optional(),
    count: z.number().int().positive().optional(),
  }).catchall(z.unknown()),
});
const dataSchema = z.object({ events: z.array(z.discriminatedUnion('type', [z.object({ type: z.literal('record'), record: recordSchema }), z.object({ type: z.literal('status'), id: z.string(), status: statusSchema, outputs: z.array(outputSchema), error: z.string().optional(), jobIds: z.array(z.string()).optional(), resultNodeIds: z.array(z.string()).optional() }), z.object({ type: z.literal('agent-task'), taskId: z.string() })])) });
export function indexHistoryEvents(events: HistoryEvent[]): GenerationHistoryRecord[] {
  const records = new Map<string, GenerationHistoryRecord>();
  for (const event of events) {
    if (event.type === 'record') { if (!records.has(event.record.id)) records.set(event.record.id, event.record); }
    else if (event.type === 'status') {
      const record = records.get(event.id);
      if (record) records.set(event.id, { ...record, status: event.status, outputs: event.outputs, error: event.error,
        jobIds: event.jobIds ?? record.jobIds, resultNodeIds: event.resultNodeIds ?? record.resultNodeIds });
    }
  }
  return [...records.values()];
}
export interface GenerationHistoryState extends HistoryData {
  records: GenerationHistoryRecord[];
  initialized: boolean;
  storageStatus: LocalStorageStatus;
  error: string | null;
  initialize(): Promise<void>;
  record(record: GenerationHistoryRecord): Promise<void>;
  update(event: Omit<Extract<HistoryEvent, { type: 'status' }>, 'type'>): Promise<void>;
  markAgentTask(taskId: string): Promise<void>;
  query(query?: HistoryQuery): GenerationHistoryRecord[];
  dispose(): void;
}
export function createGenerationHistoryStore(document: LocalDocument<HistoryData>, workbench: { tasks(): Record<string, WorkbenchTask>; projectId?(conversationId: string): string | null | undefined; initialize?(): Promise<void>; subscribe(listener: () => void): () => void }, externalize: typeof externalizeAssetMedia = externalizeAssetMedia) {
  let initialized: Promise<void> | undefined;
  let pending = Promise.resolve();
  let stop = () => {};
  const store = create<GenerationHistoryState>((set, get) => {
    const refresh = () => {
      const agents = new Set(get().events.flatMap(event => event.type === 'agent-task' ? [event.taskId] : []));
      set({ records: filterGenerationHistory([...indexHistoryEvents(get().events), ...Object.values(workbench.tasks()).map(task => projectWorkbenchHistory(task, agents.has(task.id), workbench.projectId?.(task.conversationId)))]) });
    };
    const append = async (event: HistoryEvent) => {
      const operation = pending.then(async () => {
        await get().initialize();
        const persisted = await externalize(event);
        const events = [...get().events, persisted];
        document.save({ events }); set({ events }); refresh();
        await document.flush?.();
        set({ storageStatus: document.status(), error: null });
      });
      pending = operation.catch(error => { set({ error: error instanceof Error ? error.message : String(error), storageStatus: document.status() }); });
      return await operation;
    };
    return {
      events: [], records: [], initialized: false, storageStatus: document.status(), error: null,
      initialize() {
        if (!initialized) initialized = (async () => {
          await Promise.all([document.initialize?.(), workbench.initialize?.()]);
          set({ ...document.load(), initialized: true, storageStatus: document.status() }); refresh();
        })();
        return initialized;
      },
      async record(record) { await append({ type: 'record', record: recordSchema.parse(record) }); },
      async update(event) { await append({ type: 'status', ...event }); },
      async markAgentTask(taskId) { await append({ type: 'agent-task', taskId }); },
      query: query => filterGenerationHistory(get().records, query),
      dispose: () => stop(),
    };
  });
  stop = workbench.subscribe(() => {
    const state = store.getState();
    const agents = new Set(state.events.flatMap(event => event.type === 'agent-task' ? [event.taskId] : []));
    store.setState({ records: filterGenerationHistory([...indexHistoryEvents(state.events), ...Object.values(workbench.tasks()).map(task => projectWorkbenchHistory(task, agents.has(task.id), workbench.projectId?.(task.conversationId)))]) });
  });
  return store;
}
export const useGenerationHistoryStore = createGenerationHistoryStore(
  createWorkspaceDocument<HistoryData>('storyboard-copilot:generation-history:v1', () => ({ events: [] }), value => dataSchema.parse(value)),
  { tasks: () => useWorkbenchStore.getState().tasks, projectId: (id) => useWorkbenchStore.getState().conversations[id]?.projectId, initialize: () => useWorkbenchStore.getState().initialize(), subscribe: listener => useWorkbenchStore.subscribe(listener) },
);
export async function recordCanvasGeneration(input: Omit<GenerationHistoryRecord, 'surface' | 'createdAt' | 'references' | 'outputs'> & Partial<Pick<GenerationHistoryRecord, 'surface' | 'createdAt' | 'references' | 'outputs'>>): Promise<void> {
  await useGenerationHistoryStore.getState().record({ ...input, surface: input.surface ?? 'canvas', createdAt: input.createdAt ?? Date.now(), references: input.references ?? [], outputs: input.outputs ?? [] });
}
