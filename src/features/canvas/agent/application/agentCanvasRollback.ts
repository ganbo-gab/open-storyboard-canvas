import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { canvasAgentApprovalStore } from './agentApproval';

const ROLLBACK_STORAGE_KEY = 'storyboard-copilot:canvas-agent:canvas-rollbacks:v1';
const MAX_ROLLBACKS = 1_000;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface AgentCanvasRollbackRecord {
  token: string;
  projectId: string;
  runId: string;
  revisionBefore: number;
  revisionAfter?: number;
  historyDepthBefore: number;
  status: 'prepared' | 'ready' | 'rolled-back' | 'discarded';
  createdAt: number;
  rolledBackAt?: number;
}

interface RollbackEnvelope {
  version: 1;
  records: AgentCanvasRollbackRecord[];
}

export interface AgentCanvasRollbackResult {
  ok: boolean;
  code?: 'not-found' | 'not-available' | 'project-changed' | 'revision-conflict' | 'history-conflict' | 'undo-failed';
  message: string;
  revisionBefore?: number;
  revisionAfter?: number;
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function normalizeRecord(value: unknown): AgentCanvasRollbackRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<AgentCanvasRollbackRecord>;
  if (typeof record.token !== 'string' || !record.token
    || typeof record.projectId !== 'string' || !record.projectId
    || typeof record.runId !== 'string' || !record.runId
    || !isNonNegativeInteger(record.revisionBefore)
    || !isNonNegativeInteger(record.historyDepthBefore)
    || !['prepared', 'ready', 'rolled-back', 'discarded'].includes(String(record.status))
    || typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return null;
  if (record.revisionAfter !== undefined && !isNonNegativeInteger(record.revisionAfter)) return null;
  return record as AgentCanvasRollbackRecord;
}

function parseEnvelope(raw: string | null): RollbackEnvelope {
  if (!raw) return { version: 1, records: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<RollbackEnvelope>;
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) return { version: 1, records: [] };
    return {
      version: 1,
      records: parsed.records.flatMap((record) => {
        const normalized = normalizeRecord(record);
        return normalized ? [normalized] : [];
      }).slice(-MAX_ROLLBACKS),
    };
  } catch {
    return { version: 1, records: [] };
  }
}

export class AgentCanvasRollbackStore {
  private memory: RollbackEnvelope = { version: 1, records: [] };

  constructor(
    private readonly storage: StorageLike | null = defaultStorage(),
    private readonly now: () => number = () => Date.now(),
    private readonly nextToken: () => string = () => globalThis.crypto?.randomUUID?.()
      ?? `rollback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
  ) {}

  begin(projectId: string, runId: string, revisionBefore: number, historyDepthBefore: number): string {
    const envelope = this.read();
    const token = this.nextToken();
    envelope.records.push({
      token,
      projectId,
      runId,
      revisionBefore,
      historyDepthBefore,
      status: 'prepared',
      createdAt: this.now(),
    });
    this.write(envelope);
    return token;
  }

  complete(token: string, revisionAfter: number): void {
    this.patch(token, (record) => ({ ...record, revisionAfter, status: 'ready' }));
  }

  discard(token: string): void {
    this.patch(token, (record) => ({ ...record, status: 'discarded' }));
  }

  get(token: string): AgentCanvasRollbackRecord | undefined {
    const record = this.read().records.find((candidate) => candidate.token === token);
    return record ? structuredClone(record) : undefined;
  }

  markRolledBack(token: string): void {
    this.patch(token, (record) => ({ ...record, status: 'rolled-back', rolledBackAt: this.now() }));
  }

  private patch(token: string, update: (record: AgentCanvasRollbackRecord) => AgentCanvasRollbackRecord): void {
    const envelope = this.read();
    const index = envelope.records.findIndex((record) => record.token === token);
    if (index < 0) throw new Error('Agent canvas rollback checkpoint does not exist.');
    envelope.records[index] = update(envelope.records[index]);
    this.write(envelope);
  }

  private read(): RollbackEnvelope {
    return this.storage ? parseEnvelope(this.storage.getItem(ROLLBACK_STORAGE_KEY)) : structuredClone(this.memory);
  }

  private write(envelope: RollbackEnvelope): void {
    const safe = parseEnvelope(JSON.stringify(envelope));
    if (this.storage) this.storage.setItem(ROLLBACK_STORAGE_KEY, JSON.stringify(safe));
    else this.memory = structuredClone(safe);
  }
}

export const canvasAgentRollbackStore = new AgentCanvasRollbackStore();

export async function rollbackAgentCanvasReceipt(
  receiptId: string,
  projectId: string,
  store: AgentCanvasRollbackStore = canvasAgentRollbackStore,
): Promise<AgentCanvasRollbackResult> {
  const receipt = canvasAgentApprovalStore.getReceiptById(receiptId);
  if (!receipt) return { ok: false, code: 'not-found', message: '执行回执已不存在。' };
  if (!receipt.rollbackToken || receipt.rolledBackAt) {
    return { ok: false, code: 'not-available', message: receipt.rolledBackAt ? '该事务已经撤销。' : '该事务不支持画布回滚。' };
  }
  const checkpoint = store.get(receipt.rollbackToken);
  if (!checkpoint || checkpoint.status !== 'ready' || checkpoint.revisionAfter === undefined) {
    return { ok: false, code: 'not-available', message: '回滚检查点不可用。' };
  }
  const projectStore = useProjectStore.getState();
  if (checkpoint.projectId !== projectId || projectStore.currentProjectId !== projectId) {
    return { ok: false, code: 'project-changed', message: '当前项目与执行回执不一致。' };
  }
  const canvas = useCanvasStore.getState();
  if (canvas.revision !== checkpoint.revisionAfter) {
    return {
      ok: false,
      code: 'revision-conflict',
      message: '执行后画布已经发生新的变化，为避免覆盖后续编辑，本次没有撤销。',
      revisionBefore: canvas.revision,
      revisionAfter: canvas.revision,
    };
  }
  if (canvas.history.past.length !== checkpoint.historyDepthBefore + 1) {
    return { ok: false, code: 'history-conflict', message: '画布历史栈与执行回执不一致，本次没有撤销。' };
  }
  const revisionBefore = canvas.revision;
  if (!canvas.undo()) return { ok: false, code: 'undo-failed', message: '画布没有可撤销的事务。' };
  const restored = useCanvasStore.getState();
  projectStore.saveCurrentProject(restored.nodes, restored.edges, restored.currentViewport, restored.history);
  await projectStore.waitForProjectPersistence(projectId);
  store.markRolledBack(receipt.rollbackToken);
  canvasAgentApprovalStore.putReceipt({ ...receipt, rolledBackAt: Date.now(), updatedAt: Date.now() });
  return {
    ok: true,
    message: 'Agent 事务已整笔撤销。',
    revisionBefore,
    revisionAfter: restored.revision,
  };
}
