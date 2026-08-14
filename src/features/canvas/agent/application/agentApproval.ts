import { redactSensitiveValue } from './agentRedaction';
import { assertAgentSerializedRunStateSafe } from '../infrastructure/agentSessionRepository';
import {
  CANVAS_COMMAND_VERSION,
  type CanvasCommandExecutionResult,
  type GetGenerationStatusCommand,
} from '@/features/canvas/domain/canvasCommands';

const APPROVAL_STORAGE_KEY = 'storyboard-copilot:canvas-agent:approval-ledger:v1';
const MAX_LEDGER_RECORDS = 200;
const MAX_LEDGER_WEBKIT_BYTES = 512 * 1024;

export type AgentEffect = 'read' | 'canvas-write' | 'config-write' | 'external-submit';
export type AgentApprovalStatus =
  | 'proposed'
  | 'awaiting-approval'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'conflicted'
  | 'cancelled';

export interface AgentScope {
  projectId: string;
  runId: string;
  purpose: string;
  resourceKinds: string[];
  nodeIds?: string[];
  maxItems: number;
  expiresAt: number;
}

export type AgentScopeRequest = Pick<
  AgentScope,
  'projectId' | 'runId' | 'purpose' | 'resourceKinds' | 'nodeIds' | 'maxItems'
>;

export interface AgentImpactSummary {
  effect: AgentEffect;
  title: string;
  summary: string;
  affectedNodeCount: number;
  affectedEdgeCount: number;
  model?: string;
  estimatedCost?: { value?: number; currency?: string; confidence: 'known' | 'range' | 'unknown' };
  estimatedDurationMs?: { value?: number; confidence: 'known' | 'range' | 'unknown' };
  externalSideEffect: boolean;
}

export interface AgentApprovalRecord {
  id: string;
  runId: string;
  projectId: string;
  interruptionId: string;
  toolName?: string;
  arguments?: unknown;
  requestFingerprint: string;
  status: AgentApprovalStatus;
  scope?: AgentScope;
  impact: AgentImpactSummary;
  baseRevision: number;
  baseConfigRevision?: string;
  createdAt: number;
  expiresAt: number;
  executionId?: string;
  receiptId?: string;
  serializedRunState?: string;
  rejectionReason?: string;
}

export interface AgentExecutionReceipt<T = unknown> {
  id: string;
  executionId: string;
  approvalId: string;
  idempotencyKey: string;
  status: 'not-started' | 'sending' | 'accepted' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  output?: T;
  safeDiff?: Record<string, unknown>;
  safeRecovery?: AgentGenerationStatusRecovery;
  rollbackToken?: string;
  rolledBackAt?: number;
  errorCode?: string;
}

export interface AgentGenerationStatusRecovery {
  kind: 'generation-status';
  nodeIds: string[];
  jobIds: string[];
}

export interface AgentRecoverableGenerationSubmit extends AgentGenerationStatusRecovery {
  approvalId: string;
  receiptId: string;
  runId: string;
  projectId: string;
  receiptStatus: Extract<AgentExecutionReceipt['status'], 'sending' | 'accepted' | 'unknown'>;
}

export interface AgentRunRecovery {
  runId: string;
  projectId: string;
  sessionId: string;
  runtimeVersion: number;
  agentDefinitionVersion: number;
  commandSchemaVersion: number;
  serializedState: string;
  createdAt: number;
}

export interface AgentApprovalStore {
  get(id: string): AgentApprovalRecord | undefined;
  listByRun(runId: string): AgentApprovalRecord[];
  listByProject(projectId: string): AgentApprovalRecord[];
  put(record: AgentApprovalRecord): void;
  update(id: string, patch: Partial<AgentApprovalRecord>): AgentApprovalRecord | undefined;
  getReceipt(idempotencyKey: string): AgentExecutionReceipt | undefined;
  getReceiptById(receiptId: string): AgentExecutionReceipt | undefined;
  listReceiptsByRun(runId: string): AgentExecutionReceipt[];
  putReceipt(receipt: AgentExecutionReceipt): void;
  getRunRecovery(runId: string): AgentRunRecovery | undefined;
  putRunRecovery(records: AgentApprovalRecord[], recovery: AgentRunRecovery): void;
  deleteRunRecovery(runId: string): void;
  deleteRun(runId: string): void;
}

const APPROVAL_STATUSES = new Set<AgentApprovalStatus>([
  'proposed',
  'awaiting-approval',
  'approved',
  'rejected',
  'expired',
  'executing',
  'succeeded',
  'failed',
  'unknown',
  'conflicted',
  'cancelled',
]);
const RECEIPT_STATUSES = new Set<AgentExecutionReceipt['status']>([
  'not-started',
  'sending',
  'accepted',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
]);
const AGENT_EFFECTS = new Set<AgentEffect>(['read', 'canvas-write', 'config-write', 'external-submit']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isAgentGenerationStatusRecovery(value: unknown): value is AgentGenerationStatusRecovery {
  if (!isRecord(value) || value.kind !== 'generation-status') return false;
  return isStringArray(value.nodeIds)
    && isStringArray(value.jobIds)
    && value.nodeIds.length <= 100
    && value.jobIds.length <= 100
    && (value.nodeIds.length > 0 || value.jobIds.length > 0);
}

function isAgentScope(value: unknown): value is AgentScope {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.projectId)
    && isNonEmptyString(value.runId)
    && isNonEmptyString(value.purpose)
    && isStringArray(value.resourceKinds)
    && value.resourceKinds.length > 0
    && (value.nodeIds === undefined || isStringArray(value.nodeIds))
    && Number.isSafeInteger(value.maxItems)
    && Number(value.maxItems) >= 0
    && isTimestamp(value.expiresAt);
}

function isAgentImpactSummary(value: unknown): value is AgentImpactSummary {
  if (!isRecord(value)) return false;
  return AGENT_EFFECTS.has(value.effect as AgentEffect)
    && isNonEmptyString(value.title)
    && typeof value.summary === 'string'
    && Number.isSafeInteger(value.affectedNodeCount)
    && Number(value.affectedNodeCount) >= 0
    && Number.isSafeInteger(value.affectedEdgeCount)
    && Number(value.affectedEdgeCount) >= 0
    && typeof value.externalSideEffect === 'boolean';
}

function isAgentApprovalRecord(value: unknown): value is AgentApprovalRecord {
  if (!isRecord(value) || !isAgentImpactSummary(value.impact)) return false;
  if (!APPROVAL_STATUSES.has(value.status as AgentApprovalStatus)) return false;
  if (!isNonEmptyString(value.id)
    || !isNonEmptyString(value.runId)
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.interruptionId)
    || !/^sha256:[a-f0-9]{64}$/.test(String(value.requestFingerprint))
    || !Number.isSafeInteger(value.baseRevision)
    || Number(value.baseRevision) < 0
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.expiresAt)
    || Number(value.expiresAt) < Number(value.createdAt)) return false;
  if (value.scope !== undefined) {
    if (!isAgentScope(value.scope)) return false;
    if (value.scope.runId !== value.runId || value.scope.projectId !== value.projectId) return false;
  }
  return (value.toolName === undefined || isNonEmptyString(value.toolName))
    && (value.executionId === undefined || isNonEmptyString(value.executionId))
    && (value.baseConfigRevision === undefined || isNonEmptyString(value.baseConfigRevision))
    && (value.receiptId === undefined || isNonEmptyString(value.receiptId))
    && (value.serializedRunState === undefined || typeof value.serializedRunState === 'string')
    && (value.rejectionReason === undefined || typeof value.rejectionReason === 'string');
}

function isAgentExecutionReceipt(value: unknown): value is AgentExecutionReceipt {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.executionId)
    && isNonEmptyString(value.approvalId)
    && isNonEmptyString(value.idempotencyKey)
    && RECEIPT_STATUSES.has(value.status as AgentExecutionReceipt['status'])
    && isTimestamp(value.createdAt)
    && isTimestamp(value.updatedAt)
    && Number(value.updatedAt) >= Number(value.createdAt)
    && (value.safeDiff === undefined || isRecord(value.safeDiff))
    && (value.safeRecovery === undefined || isAgentGenerationStatusRecovery(value.safeRecovery))
    && (value.rollbackToken === undefined || isNonEmptyString(value.rollbackToken))
    && (value.rolledBackAt === undefined || isTimestamp(value.rolledBackAt))
    && (value.errorCode === undefined || isNonEmptyString(value.errorCode));
}

function isAgentRunRecovery(value: unknown): value is AgentRunRecovery {
  if (!isRecord(value)
    || !isNonEmptyString(value.runId)
    || !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.sessionId)
    || !Number.isSafeInteger(value.runtimeVersion)
    || !Number.isSafeInteger(value.agentDefinitionVersion)
    || !Number.isSafeInteger(value.commandSchemaVersion)
    || typeof value.serializedState !== 'string'
    || !isTimestamp(value.createdAt)) return false;
  try {
    assertAgentSerializedRunStateSafe(value.serializedState);
    return true;
  } catch {
    return false;
  }
}

function assertValidRunRecovery(recovery: AgentRunRecovery): void {
  if (!isAgentRunRecovery(recovery)) throw new Error('Invalid Agent run recovery record.');
}

function assertRecoveryBindings(records: AgentApprovalRecord[], recovery: AgentRunRecovery): void {
  if (!records.length) throw new Error('Agent run recovery requires at least one approval.');
  if (records.some((record) => record.runId !== recovery.runId || record.projectId !== recovery.projectId)) {
    throw new Error('Agent run recovery does not match its approval records.');
  }
}

function assertValidApproval(record: AgentApprovalRecord): void {
  if (!isAgentApprovalRecord(record)) throw new Error('Invalid Agent approval record.');
}

function assertValidReceipt(receipt: AgentExecutionReceipt): void {
  if (!isAgentExecutionReceipt(receipt)) throw new Error('Invalid Agent execution receipt.');
}

function assertSameReceiptIdentity(
  current: AgentExecutionReceipt | undefined,
  next: AgentExecutionReceipt,
): void {
  if (!current) return;
  if (current.id !== next.id
    || current.executionId !== next.executionId
    || current.approvalId !== next.approvalId) {
    throw new Error('Agent execution receipt identity cannot be replaced.');
  }
}

export class InMemoryAgentApprovalStore implements AgentApprovalStore {
  private readonly approvals = new Map<string, AgentApprovalRecord>();
  private readonly receipts = new Map<string, AgentExecutionReceipt>();
  private readonly runRecoveries = new Map<string, AgentRunRecovery>();

  get(id: string): AgentApprovalRecord | undefined {
    const record = this.approvals.get(id);
    return record ? clone(record) : undefined;
  }
  listByRun(runId: string): AgentApprovalRecord[] {
    return Array.from(this.approvals.values()).filter((record) => record.runId === runId).map(clone);
  }
  listByProject(projectId: string): AgentApprovalRecord[] {
    return Array.from(this.approvals.values()).filter((record) => record.projectId === projectId).map(clone);
  }
  put(record: AgentApprovalRecord): void {
    assertValidApproval(record);
    this.approvals.set(record.id, sanitizeApproval(record));
  }
  update(id: string, patch: Partial<AgentApprovalRecord>): AgentApprovalRecord | undefined {
    const current = this.approvals.get(id);
    if (!current) return undefined;
    const next = sanitizeApproval({ ...current, ...patch });
    assertValidApproval(next);
    this.approvals.set(id, next);
    return next;
  }
  getReceipt(idempotencyKey: string): AgentExecutionReceipt | undefined {
    const receipt = this.receipts.get(idempotencyKey);
    return receipt ? clone(receipt) : undefined;
  }
  getReceiptById(receiptId: string): AgentExecutionReceipt | undefined {
    const receipt = Array.from(this.receipts.values()).find((candidate) => candidate.id === receiptId);
    return receipt ? clone(receipt) : undefined;
  }
  listReceiptsByRun(runId: string): AgentExecutionReceipt[] {
    const approvalIds = new Set(this.listByRun(runId).map((record) => record.id));
    return Array.from(this.receipts.values()).filter((receipt) => approvalIds.has(receipt.approvalId)).map(clone);
  }
  putReceipt(receipt: AgentExecutionReceipt): void {
    assertValidReceipt(receipt);
    assertSameReceiptIdentity(this.receipts.get(receipt.idempotencyKey), receipt);
    this.receipts.set(receipt.idempotencyKey, sanitizeReceipt(receipt));
  }
  getRunRecovery(runId: string): AgentRunRecovery | undefined {
    const recovery = this.runRecoveries.get(runId);
    return recovery ? clone(recovery) : undefined;
  }
  putRunRecovery(records: AgentApprovalRecord[], recovery: AgentRunRecovery): void {
    records.forEach(assertValidApproval);
    assertValidRunRecovery(recovery);
    assertRecoveryBindings(records, recovery);
    for (const record of records) this.approvals.set(record.id, sanitizeApproval(record));
    this.runRecoveries.set(recovery.runId, clone(recovery));
  }
  deleteRunRecovery(runId: string): void {
    this.runRecoveries.delete(runId);
  }
  deleteRun(runId: string): void {
    const approvalIds = new Set(this.listByRun(runId).map((record) => record.id));
    for (const [id, record] of this.approvals) if (record.runId === runId) this.approvals.delete(id);
    for (const [key, receipt] of this.receipts) if (approvalIds.has(receipt.approvalId)) this.receipts.delete(key);
    this.runRecoveries.delete(runId);
  }
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface AgentApprovalEnvelopeV1 {
  version: 1;
  approvals: AgentApprovalRecord[];
  receipts: AgentExecutionReceipt[];
  runRecoveries: AgentRunRecovery[];
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptyEnvelope(): AgentApprovalEnvelopeV1 {
  return { version: 1, approvals: [], receipts: [], runRecoveries: [] };
}

function parseEnvelope(raw: string | null): AgentApprovalEnvelopeV1 {
  if (!raw) return emptyEnvelope();
  try {
    const parsed = JSON.parse(raw) as Partial<AgentApprovalEnvelopeV1>;
    if (parsed.version !== 1 || !Array.isArray(parsed.approvals) || !Array.isArray(parsed.receipts)) {
      return emptyEnvelope();
    }
    const approvals = parsed.approvals
      .filter(isAgentApprovalRecord)
      .map((record) => sanitizeApproval(record))
      .slice(-MAX_LEDGER_RECORDS);
    const approvalIds = new Set(approvals.map((record) => record.id));
    return {
      version: 1,
      approvals,
      receipts: parsed.receipts
        .filter((receipt) => isAgentExecutionReceipt(receipt) && approvalIds.has(receipt.approvalId))
        .map((receipt) => sanitizeReceipt(receipt))
        .slice(-MAX_LEDGER_RECORDS),
      runRecoveries: (Array.isArray(parsed.runRecoveries) ? parsed.runRecoveries : [])
        .filter((recovery) => isAgentRunRecovery(recovery) && approvalIds.has(
          approvals.find((record) => record.runId === recovery.runId)?.id ?? '',
        ))
        .slice(-MAX_LEDGER_RECORDS),
    };
  } catch {
    return emptyEnvelope();
  }
}

function webKitStorageBytes(serialized: string): number {
  // WebKit stores localStorage values as UTF-16. Counting JavaScript
  // characters underestimates the actual quota cost by roughly 2x.
  return serialized.length * 2;
}

function compactEnvelopeForStorage(
  envelope: AgentApprovalEnvelopeV1,
  now = Date.now(),
  pruneExpired = false,
): AgentApprovalEnvelopeV1 {
  const safe = parseEnvelope(JSON.stringify(envelope));
  const resumableStatuses = new Set<AgentApprovalStatus>([
    'proposed',
    'awaiting-approval',
    'approved',
    'executing',
  ]);
  const activeRecoveryRuns = new Set(safe.approvals
    .filter((approval) => resumableStatuses.has(approval.status) && approval.expiresAt > now)
    .map((approval) => approval.runId));
  if (pruneExpired) {
    safe.runRecoveries = safe.runRecoveries.filter((recovery) => activeRecoveryRuns.has(recovery.runId));
  }
  const isRemovable = (approval: AgentApprovalRecord) => (
    approval.expiresAt <= now
    && (approval.status === 'proposed'
      || approval.status === 'awaiting-approval'
      || approval.status === 'executing')
  ) && !activeRecoveryRuns.has(approval.runId);
  if (pruneExpired) {
    safe.approvals = safe.approvals.filter((approval) => {
      if (!isRemovable(approval)) return true;
      safe.receipts = safe.receipts.filter((receipt) => receipt.approvalId !== approval.id);
      return false;
    });
  }
  let serialized = JSON.stringify(safe);
  while (webKitStorageBytes(serialized) > MAX_LEDGER_WEBKIT_BYTES) {
    const index = safe.approvals.findIndex((approval) => (
      !activeRecoveryRuns.has(approval.runId)
    ));
    if (index < 0) break;
    const [removed] = safe.approvals.splice(index, 1);
    safe.receipts = safe.receipts.filter((receipt) => receipt.approvalId !== removed.id);
    serialized = JSON.stringify(safe);
  }
  return safe;
}

function sanitizeReceipt<T>(receipt: AgentExecutionReceipt<T>): AgentExecutionReceipt<T> {
  return {
    ...receipt,
    output: receipt.output === undefined ? undefined : redactSensitiveValue(receipt.output),
    safeDiff: receipt.safeDiff === undefined ? undefined : redactSensitiveValue(receipt.safeDiff),
    safeRecovery: receipt.safeRecovery === undefined ? undefined : {
      kind: 'generation-status',
      nodeIds: Array.from(new Set(receipt.safeRecovery.nodeIds)).slice(0, 100),
      jobIds: Array.from(new Set(receipt.safeRecovery.jobIds)).slice(0, 100),
    },
  };
}

function receiptReferences(output: unknown): { nodeIds: string[]; jobIds: string[] } {
  if (!isRecord(output)) return { nodeIds: [], jobIds: [] };
  const commandOutput = isRecord(output.output) ? output.output : output;
  const references = isRecord(commandOutput.references) ? commandOutput.references : undefined;
  if (!references) return { nodeIds: [], jobIds: [] };
  const nodeIds = [
    ...(Array.isArray(references.nodeIds) ? references.nodeIds : []),
    ...(isNonEmptyString(references.nodeId) ? [references.nodeId] : []),
  ].filter(isNonEmptyString);
  const jobIds = [
    ...(Array.isArray(references.jobIds) ? references.jobIds : []),
    ...(isNonEmptyString(references.jobId) ? [references.jobId] : []),
  ].filter(isNonEmptyString);
  return {
    nodeIds: Array.from(new Set(nodeIds)).slice(0, 100),
    jobIds: Array.from(new Set(jobIds)).slice(0, 100),
  };
}

function mergeSafeRecovery(
  recovery: AgentGenerationStatusRecovery | undefined,
  output: unknown,
): AgentGenerationStatusRecovery | undefined {
  if (!recovery) return undefined;
  const references = receiptReferences(output);
  return {
    kind: 'generation-status',
    nodeIds: Array.from(new Set([...recovery.nodeIds, ...references.nodeIds])).slice(0, 100),
    jobIds: Array.from(new Set([...recovery.jobIds, ...references.jobIds])).slice(0, 100),
  };
}

function receiptExecutionMetadata(output: unknown): Pick<AgentExecutionReceipt, 'safeDiff' | 'rollbackToken'> {
  if (!isRecord(output)) return {};
  const rollbackToken = typeof output.rollbackToken === 'string' && output.rollbackToken
    ? output.rollbackToken
    : undefined;
  const safeDiff: Record<string, unknown> = {};
  for (const key of ['revisionBefore', 'revisionAfter', 'impact', 'diff']) {
    if (output[key] !== undefined) safeDiff[key] = output[key];
  }
  if (isRecord(output.output) && output.output.references !== undefined) {
    safeDiff.references = output.output.references;
  }
  return {
    ...(Object.keys(safeDiff).length > 0 ? { safeDiff: redactSensitiveValue(safeDiff) } : {}),
    ...(rollbackToken ? { rollbackToken } : {}),
  };
}

export class PersistentAgentApprovalStore implements AgentApprovalStore {
  private memory = emptyEnvelope();

  constructor(
    private storage: StorageLike | null = defaultStorage(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.compactPersistedEnvelope();
  }

  get(id: string): AgentApprovalRecord | undefined {
    const record = this.read().approvals.find((item) => item.id === id);
    return record ? clone(record) : undefined;
  }

  listByRun(runId: string): AgentApprovalRecord[] {
    return this.read().approvals.filter((record) => record.runId === runId).map(clone);
  }

  listByProject(projectId: string): AgentApprovalRecord[] {
    return this.read().approvals.filter((record) => record.projectId === projectId).map(clone);
  }

  put(record: AgentApprovalRecord): void {
    assertValidApproval(record);
    const envelope = this.read();
    const safe = sanitizeApproval(record);
    const index = envelope.approvals.findIndex((item) => item.id === safe.id);
    if (index >= 0) envelope.approvals[index] = safe;
    else envelope.approvals.push(safe);
    envelope.approvals = envelope.approvals.slice(-MAX_LEDGER_RECORDS);
    this.write(envelope);
  }

  update(id: string, patch: Partial<AgentApprovalRecord>): AgentApprovalRecord | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = sanitizeApproval({ ...current, ...patch });
    this.put(next);
    return next;
  }

  getReceipt(idempotencyKey: string): AgentExecutionReceipt | undefined {
    const receipt = this.read().receipts.find((item) => item.idempotencyKey === idempotencyKey);
    return receipt ? clone(receipt) : undefined;
  }

  getReceiptById(receiptId: string): AgentExecutionReceipt | undefined {
    const receipt = this.read().receipts.find((item) => item.id === receiptId);
    return receipt ? clone(receipt) : undefined;
  }

  listReceiptsByRun(runId: string): AgentExecutionReceipt[] {
    const envelope = this.read();
    const approvalIds = new Set(envelope.approvals.filter((record) => record.runId === runId).map((record) => record.id));
    return envelope.receipts.filter((receipt) => approvalIds.has(receipt.approvalId)).map(clone);
  }

  putReceipt(receipt: AgentExecutionReceipt): void {
    assertValidReceipt(receipt);
    const envelope = this.read();
    const safe = sanitizeReceipt(receipt);
    const index = envelope.receipts.findIndex((item) => item.idempotencyKey === safe.idempotencyKey);
    if (index >= 0) {
      assertSameReceiptIdentity(envelope.receipts[index], safe);
      envelope.receipts[index] = safe;
    }
    else envelope.receipts.push(safe);
    envelope.receipts = envelope.receipts.slice(-MAX_LEDGER_RECORDS);
    this.write(envelope);
  }

  getRunRecovery(runId: string): AgentRunRecovery | undefined {
    const envelope = this.read();
    const recovery = envelope.runRecoveries.find((item) => item.runId === runId);
    const activeApproval = envelope.approvals.some((approval) => (
      approval.runId === runId && isApprovalActive(approval, this.now())
    ));
    if (recovery && !activeApproval) {
      this.deleteRunRecovery(runId);
      return undefined;
    }
    return recovery ? clone(recovery) : undefined;
  }

  putRunRecovery(records: AgentApprovalRecord[], recovery: AgentRunRecovery): void {
    records.forEach(assertValidApproval);
    assertValidRunRecovery(recovery);
    assertRecoveryBindings(records, recovery);
    const envelope = this.read();
    for (const record of records) {
      const safe = sanitizeApproval(record);
      const index = envelope.approvals.findIndex((item) => item.id === safe.id);
      if (index >= 0) envelope.approvals[index] = safe;
      else envelope.approvals.push(safe);
    }
    const recoveryIndex = envelope.runRecoveries.findIndex((item) => item.runId === recovery.runId);
    if (recoveryIndex >= 0) envelope.runRecoveries[recoveryIndex] = clone(recovery);
    else envelope.runRecoveries.push(clone(recovery));
    envelope.approvals = envelope.approvals.slice(-MAX_LEDGER_RECORDS);
    envelope.runRecoveries = envelope.runRecoveries.slice(-MAX_LEDGER_RECORDS);
    this.write(envelope);
  }

  deleteRunRecovery(runId: string): void {
    const envelope = this.read();
    envelope.runRecoveries = envelope.runRecoveries.filter((recovery) => recovery.runId !== runId);
    this.write(envelope);
  }

  deleteRun(runId: string): void {
    const envelope = this.read();
    const approvalIds = new Set(envelope.approvals.filter((record) => record.runId === runId).map((record) => record.id));
    envelope.approvals = envelope.approvals.filter((record) => record.runId !== runId);
    envelope.receipts = envelope.receipts.filter((receipt) => !approvalIds.has(receipt.approvalId));
    envelope.runRecoveries = envelope.runRecoveries.filter((recovery) => recovery.runId !== runId);
    this.write(envelope);
  }

  private read(): AgentApprovalEnvelopeV1 {
    if (!this.storage) return clone(this.memory);
    try {
      return parseEnvelope(this.storage.getItem(APPROVAL_STORAGE_KEY));
    } catch {
      this.storage = null;
      return clone(this.memory);
    }
  }

  private write(envelope: AgentApprovalEnvelopeV1): void {
    const safe = compactEnvelopeForStorage(envelope, this.now());
    if (!this.storage) {
      this.memory = clone(safe);
      return;
    }
    try {
      this.storage.setItem(APPROVAL_STORAGE_KEY, JSON.stringify(safe));
    } catch {
      this.memory = clone(safe);
      this.storage = null;
    }
  }

  private compactPersistedEnvelope(): void {
    if (!this.storage) return;
    let raw: string | null;
    let safe: AgentApprovalEnvelopeV1;
    try {
      raw = this.storage.getItem(APPROVAL_STORAGE_KEY);
      if (raw === null) return;
      safe = compactEnvelopeForStorage(parseEnvelope(raw), this.now(), true);
    } catch {
      this.storage = null;
      return;
    }
    const serialized = JSON.stringify(safe);
    if (raw === serialized) return;
    try {
      this.storage.setItem(APPROVAL_STORAGE_KEY, serialized);
    } catch {
      this.memory = clone(safe);
      this.storage = null;
    }
  }
}

function sanitizeApproval(record: AgentApprovalRecord): AgentApprovalRecord {
  return {
    ...record,
    arguments: record.arguments === undefined ? undefined : redactSensitiveValue(record.arguments),
    impact: redactSensitiveValue(record.impact),
    scope: record.scope ? redactSensitiveValue(record.scope) : undefined,
    serializedRunState: undefined,
  };
}

export function createApprovalId(runId: string, toolName: string, callId: string): string {
  return createIdempotencyKey(runId, toolName, callId);
}

function stableFingerprintInput(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(stableFingerprintInput).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableFingerprintInput(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

export async function createAgentRequestFingerprint(toolName: string, input: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure request fingerprinting is unavailable; approval was refused.');
  }
  const bytes = new TextEncoder().encode(stableFingerprintInput({ toolName, input }));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createApprovalRecord(input: Omit<AgentApprovalRecord, 'status' | 'createdAt' | 'expiresAt'> & { ttlMs?: number }): AgentApprovalRecord {
  const now = Date.now();
  const { ttlMs, ...record } = input;
  return {
    ...record,
    status: 'awaiting-approval',
    createdAt: now,
    expiresAt: now + Math.min(Math.max(ttlMs ?? 5 * 60_000, 30_000), 30 * 60_000),
  };
}

export function isApprovalActive(record: AgentApprovalRecord, now = Date.now()): boolean {
  return record.status === 'awaiting-approval' && record.expiresAt > now;
}

export function assertScopedRead(scope: AgentScope, requested: AgentScopeRequest, now = Date.now()): void {
  if (scope.expiresAt <= now) throw new Error('只读授权已过期，需要重新确认。');
  if (
    scope.projectId !== requested.projectId
    || scope.runId !== requested.runId
    || scope.purpose !== requested.purpose
  ) {
    throw new Error('只读授权范围与当前请求不一致。');
  }
  if (requested.maxItems > scope.maxItems) throw new Error('当前请求超出已批准的读取数量。');
  if (requested.resourceKinds.some((kind) => !scope.resourceKinds.includes(kind))) {
    throw new Error('当前请求扩大了读取资源范围。');
  }
  if (scope.nodeIds) {
    if (!requested.nodeIds || requested.nodeIds.some((id) => !scope.nodeIds?.includes(id))) {
      throw new Error('当前请求扩大了读取节点范围。');
    }
  }
}

export function findScopedReadGrant(
  store: AgentApprovalStore,
  requested: AgentScopeRequest,
  now = Date.now(),
): AgentApprovalRecord | undefined {
  return store.listByRun(requested.runId).find((record) => {
    if (record.status !== 'succeeded' || record.projectId !== requested.projectId || !record.scope) return false;
    try {
      assertScopedRead(record.scope, requested, now);
      return true;
    } catch {
      return false;
    }
  });
}

export function listRecoverableGenerationSubmits(
  store: AgentApprovalStore,
  input: { projectId: string; runId?: string },
): AgentRecoverableGenerationSubmit[] {
  const approvals = input.runId
    ? store.listByRun(input.runId)
    : store.listByProject(input.projectId);
  const approvalById = new Map(approvals.map((approval) => [approval.id, approval] as const));
  const runIds = Array.from(new Set(approvals.map((approval) => approval.runId)));
  return runIds.flatMap((runId) => store.listReceiptsByRun(runId)).flatMap((receipt) => {
    const approval = approvalById.get(receipt.approvalId);
    if (!approval
      || approval.projectId !== input.projectId
      || (input.runId !== undefined && approval.runId !== input.runId)
      || approval.impact.effect !== 'external-submit'
      || !receipt.safeRecovery
      || !['sending', 'accepted', 'unknown'].includes(receipt.status)) return [];
    return [{
      ...receipt.safeRecovery,
      approvalId: approval.id,
      receiptId: receipt.id,
      runId: approval.runId,
      projectId: approval.projectId,
      receiptStatus: receipt.status as AgentRecoverableGenerationSubmit['receiptStatus'],
    }];
  });
}

export function findRecoverableGenerationSubmit(
  store: AgentApprovalStore,
  input: { projectId: string; runId: string; nodeId?: string; jobId?: string },
): AgentRecoverableGenerationSubmit | undefined {
  if (!input.nodeId && !input.jobId) return undefined;
  return listRecoverableGenerationSubmits(store, input).find((recovery) => (
    (!input.nodeId || recovery.nodeIds.includes(input.nodeId))
    && (!input.jobId || recovery.jobIds.includes(input.jobId))
  ));
}

export function buildUnknownGenerationRecoveryCommand(
  recovery: AgentGenerationStatusRecovery,
  target: { nodeId?: string; jobId?: string } = {},
): GetGenerationStatusCommand {
  const nodeId = target.nodeId ?? recovery.nodeIds[0];
  const jobId = target.jobId ?? (!nodeId ? recovery.jobIds[0] : undefined);
  if ((!nodeId && !jobId)
    || (nodeId !== undefined && !recovery.nodeIds.includes(nodeId))
    || (jobId !== undefined && !recovery.jobIds.includes(jobId))) {
    throw new AgentApprovalError('状态查询目标不在未知提交的安全恢复范围内。', 'invalid-binding');
  }
  return {
    type: 'generation.status',
    version: CANVAS_COMMAND_VERSION,
    input: {
      ...(nodeId ? { nodeId } : {}),
      ...(jobId ? { jobId } : {}),
    },
  };
}

function recoveredReceiptStatus(
  current: AgentExecutionReceipt['status'],
  result: CanvasCommandExecutionResult,
): AgentExecutionReceipt['status'] {
  if (!result.ok || !isRecord(result.output.value)) return current === 'sending' ? 'unknown' : current;
  switch (result.output.value.status) {
    case 'queued':
    case 'running':
      return 'accepted';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    default:
      return current === 'sending' ? 'unknown' : current;
  }
}

export async function recoverUnknownGenerationSubmit(input: {
  store: AgentApprovalStore;
  receiptId: string;
  projectId: string;
  runId: string;
  target?: { nodeId?: string; jobId?: string };
  executeStatus: (command: GetGenerationStatusCommand) => Promise<CanvasCommandExecutionResult>;
  now?: () => number;
}): Promise<{ command: GetGenerationStatusCommand; result: CanvasCommandExecutionResult; receipt: AgentExecutionReceipt }> {
  const receipt = input.store.getReceiptById(input.receiptId);
  const approval = receipt ? input.store.get(receipt.approvalId) : undefined;
  if (!receipt
    || !approval
    || approval.runId !== input.runId
    || approval.projectId !== input.projectId
    || approval.impact.effect !== 'external-submit'
    || !receipt.safeRecovery
    || !['sending', 'accepted', 'unknown'].includes(receipt.status)) {
    throw new AgentApprovalError('没有可安全查询的未知生成提交。', 'invalid-binding');
  }
  const command = buildUnknownGenerationRecoveryCommand(receipt.safeRecovery, input.target);
  const now = input.now ?? (() => Date.now());
  if (receipt.status === 'sending') {
    input.store.putReceipt({ ...receipt, status: 'unknown', updatedAt: now() });
    input.store.update(approval.id, { status: 'unknown', receiptId: receipt.id });
  }
  const result = await input.executeStatus(command);
  const current = input.store.getReceiptById(receipt.id) ?? receipt;
  const status = recoveredReceiptStatus(current.status, result);
  const nextReceipt: AgentExecutionReceipt = {
    ...current,
    status,
    updatedAt: now(),
    safeRecovery: mergeSafeRecovery(current.safeRecovery, result),
  };
  input.store.putReceipt(nextReceipt);
  input.store.update(approval.id, {
    status: status === 'failed' ? 'failed' : status === 'unknown' ? 'unknown' : 'succeeded',
    receiptId: receipt.id,
  });
  return { command, result, receipt: nextReceipt };
}

export function cancelPendingApprovals(
  store: AgentApprovalStore,
  runId: string,
): void {
  for (const record of store.listByRun(runId)) {
    if (record.status === 'proposed' || record.status === 'awaiting-approval' || record.status === 'approved') {
      store.update(record.id, { status: 'cancelled' });
    }
  }
}

export function createIdempotencyKey(runId: string, toolName: string, callId: string): string {
  return `agent-execution:v1:${JSON.stringify([runId, toolName, callId])}`;
}

export class AgentApprovalError extends Error {
  constructor(
    message: string,
    readonly code: 'missing' | 'expired' | 'rejected' | 'conflict' | 'already-failed' | 'unknown-outcome' | 'invalid-binding',
  ) {
    super(message);
    this.name = 'AgentApprovalError';
  }
}

export interface AgentApprovedExecutionInput<T> {
  approvalId: string;
  runId: string;
  projectId: string;
  toolName: string;
  callId: string;
  requestFingerprint: string;
  activeProjectId?: string | null;
  currentRevision?: number;
  currentConfigRevision?: string | null;
  safeRecovery?: AgentGenerationStatusRecovery;
  execute: () => Promise<T>;
  isConflict?: (output: T) => boolean;
  isSuccess?: (output: T) => boolean;
  isAccepted?: (output: T) => boolean;
  isUnknownOutcome?: (output: T) => boolean;
}

export interface AgentApprovedExecutionResult<T> {
  output: T;
  receipt: AgentExecutionReceipt<T>;
  replayed: boolean;
}

export class AgentApprovalExecutionService {
  private readonly inFlight = new Map<string, Promise<AgentApprovedExecutionResult<unknown>>>();

  constructor(
    private readonly store: AgentApprovalStore,
    private readonly now: () => number = () => Date.now(),
    private readonly nextId: () => string = () => globalThis.crypto?.randomUUID?.() ?? `execution-${Date.now().toString(36)}`,
  ) {}

  decide(approvalId: string, approved: boolean): AgentApprovalRecord {
    const record = this.store.get(approvalId);
    if (!record) throw new AgentApprovalError('该审批不存在或已被清理。', 'missing');
    if (record.status === 'approved' || record.status === 'rejected') {
      if ((record.status === 'approved') !== approved) throw new AgentApprovalError('该审批已经作出相反决定。', 'rejected');
      return record;
    }
    if (record.status !== 'awaiting-approval') {
      if (record.status === 'expired') throw new AgentApprovalError('该审批已过期，需要重新预览。', 'expired');
      throw new AgentApprovalError('该审批已经终止，不能再次作出决定。', 'already-failed');
    }
    if (!isApprovalActive(record, this.now())) {
      this.store.update(approvalId, { status: 'expired' });
      throw new AgentApprovalError('该审批已过期，需要重新预览。', 'expired');
    }
    return this.store.update(approvalId, { status: approved ? 'approved' : 'rejected' })!;
  }

  async executeOnce<T>(input: AgentApprovedExecutionInput<T>): Promise<AgentApprovedExecutionResult<T>> {
    const approval = this.store.get(input.approvalId);
    if (!approval) throw new AgentApprovalError('工具调用缺少持久审批记录。', 'missing');
    const expectedApprovalId = createApprovalId(input.runId, input.toolName, input.callId);
    if (
      input.approvalId !== expectedApprovalId
      || approval.id !== expectedApprovalId
      || approval.runId !== input.runId
      || approval.projectId !== input.projectId
      || approval.interruptionId !== input.callId
      || approval.requestFingerprint !== input.requestFingerprint
    ) {
      throw new AgentApprovalError('审批与当前项目、运行或工具中断不匹配。', 'invalid-binding');
    }
    if (input.activeProjectId !== undefined && input.activeProjectId !== approval.projectId) {
      this.store.update(approval.id, { status: 'conflicted' });
      throw new AgentApprovalError('当前项目已切换，原审批已失效。', 'invalid-binding');
    }
    if (approval.status === 'rejected') throw new AgentApprovalError('用户拒绝了这次工具调用。', 'rejected');
    const idempotencyKey = createIdempotencyKey(input.runId, input.toolName, input.callId);
    const pending = this.inFlight.get(idempotencyKey);
    if (pending) return pending as Promise<AgentApprovedExecutionResult<T>>;
    const existing = this.store.getReceipt(idempotencyKey) as AgentExecutionReceipt<T> | undefined;
    if (existing?.approvalId !== undefined && existing.approvalId !== approval.id) {
      throw new AgentApprovalError('执行回执与当前审批不匹配。', 'invalid-binding');
    }
    if (existing?.status === 'succeeded' || existing?.status === 'accepted') {
      if (!['executing', 'succeeded'].includes(approval.status)) {
        throw new AgentApprovalError('审批状态与已完成回执不一致。', 'invalid-binding');
      }
      return { output: clone(existing.output) as T, receipt: existing, replayed: true };
    }
    if (existing && ['sending', 'unknown'].includes(existing.status)) {
      this.store.putReceipt({ ...existing, status: 'unknown', updatedAt: this.now() });
      this.store.update(approval.id, { status: 'unknown', receiptId: existing.id });
      throw new AgentApprovalError('上次执行结果未知；为避免重复修改或扣费，本次没有重放。', 'unknown-outcome');
    }
    if (existing?.status === 'failed' || existing?.status === 'cancelled') {
      throw new AgentApprovalError('该批准事务已经结束，需要生成新的审批后重试。', 'already-failed');
    }

    if (approval.status === 'expired' || approval.expiresAt <= this.now()) {
      this.store.update(approval.id, { status: 'expired' });
      throw new AgentApprovalError('审批已过期，工具没有执行。', 'expired');
    }
    if (approval.status === 'executing' || approval.status === 'unknown') {
      this.store.update(approval.id, { status: 'unknown' });
      throw new AgentApprovalError('执行状态不完整；为避免重复副作用，本次没有重放。', 'unknown-outcome');
    }
    if (approval.status === 'succeeded' || approval.status === 'failed' || approval.status === 'cancelled' || approval.status === 'conflicted') {
      throw new AgentApprovalError('审批已终止但缺少可重放回执，本次没有执行。', 'already-failed');
    }
    if (approval.status !== 'approved') {
      throw new AgentApprovalError('工具尚未获得有效批准。', 'missing');
    }
    if (input.safeRecovery && approval.impact.effect !== 'external-submit') {
      throw new AgentApprovalError('只有外部提交可以记录状态恢复目标。', 'invalid-binding');
    }
    if (
      input.currentRevision !== undefined
      && approval.impact.effect !== 'read'
      && input.currentRevision !== approval.baseRevision
    ) {
      this.store.update(approval.id, { status: 'conflicted' });
      throw new AgentApprovalError('画布或配置在审批后发生变化，需要重新预览。', 'conflict');
    }
    if (
      approval.impact.effect === 'config-write'
      && approval.baseConfigRevision !== undefined
      && input.currentConfigRevision !== approval.baseConfigRevision
    ) {
      this.store.update(approval.id, { status: 'conflicted' });
      throw new AgentApprovalError('配置在审批后发生变化，需要重新预览。', 'conflict');
    }

    const task = this.performExecution(approval, idempotencyKey, input, existing);
    this.inFlight.set(idempotencyKey, task as Promise<AgentApprovedExecutionResult<unknown>>);
    try {
      return await task;
    } finally {
      this.inFlight.delete(idempotencyKey);
    }
  }

  private async performExecution<T>(
    approval: AgentApprovalRecord,
    idempotencyKey: string,
    input: AgentApprovedExecutionInput<T>,
    existing?: AgentExecutionReceipt<T>,
  ): Promise<AgentApprovedExecutionResult<T>> {
    const now = this.now();
    const receipt: AgentExecutionReceipt<T> = existing
      ? { ...existing, status: 'sending', updatedAt: now, safeRecovery: existing.safeRecovery ?? input.safeRecovery }
      : {
          id: this.nextId(),
          executionId: approval.executionId ?? this.nextId(),
          approvalId: approval.id,
          idempotencyKey,
          status: 'sending',
          createdAt: now,
          updatedAt: now,
          safeRecovery: input.safeRecovery,
        };
    this.store.putReceipt(receipt);
    this.store.update(approval.id, { status: 'executing', executionId: receipt.executionId, receiptId: receipt.id });
    try {
      const output = await input.execute();
      const conflict = input.isConflict?.(output) ?? false;
      const success = input.isSuccess?.(output) ?? !conflict;
      const accepted = success && (input.isAccepted?.(output) ?? false);
      const unknown = !conflict && !success && (input.isUnknownOutcome?.(output) ?? false);
      const finalReceipt: AgentExecutionReceipt<T> = {
        ...receipt,
        status: unknown ? 'unknown' : accepted ? 'accepted' : success ? 'succeeded' : 'failed',
        updatedAt: this.now(),
        output: redactSensitiveValue(output),
        safeRecovery: mergeSafeRecovery(receipt.safeRecovery, output),
        ...receiptExecutionMetadata(output),
      };
      this.store.putReceipt(finalReceipt);
      this.store.update(approval.id, { status: conflict ? 'conflicted' : unknown ? 'unknown' : success ? 'succeeded' : 'failed' });
      if (conflict) throw new AgentApprovalError('审批后的 revision 已冲突，事务没有执行。', 'conflict');
      return { output, receipt: finalReceipt, replayed: false };
    } catch (error) {
      if (error instanceof AgentApprovalError) throw error;
      const status = approval.impact.effect === 'external-submit' ? 'unknown' : 'failed';
      this.store.putReceipt({ ...receipt, status, updatedAt: this.now(), errorCode: error instanceof Error ? error.name : 'execution-error' });
      this.store.update(approval.id, { status: status === 'unknown' ? 'unknown' : 'failed' });
      throw error;
    }
  }
}

export const canvasAgentApprovalStore = new PersistentAgentApprovalStore();
export const canvasAgentApprovalExecution = new AgentApprovalExecutionService(canvasAgentApprovalStore);
