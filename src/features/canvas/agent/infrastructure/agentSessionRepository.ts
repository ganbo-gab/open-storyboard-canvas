import type {
  AgentInputItem,
  SessionHistoryRewriteArgs,
  SessionHistoryTransactionArgs,
  SessionHistoryTransactionAwareSession,
  SessionHistoryRewriteAwareSession,
} from '@openai/agents';

import {
  CANVAS_AGENT_DEFINITION_VERSION,
  CANVAS_AGENT_RUNTIME_VERSION,
  type AgentSessionMediaReference,
} from '../domain/agentModel';
import { CANVAS_COMMAND_VERSION } from '../../domain/canvasCommands';

const SESSION_STORAGE_KEY = 'storyboard-copilot:canvas-agent:sessions:v1';
const RUN_STATE_STORAGE_KEY = 'storyboard-copilot:canvas-agent:run-states:v1';
const MAX_SESSION_ITEMS = 2_000;
const MAX_SERIALIZED_BYTES = 8 * 1024 * 1024;
const MAX_COMPACTED_SUMMARY_CHARACTERS = 100_000;
const MAX_SESSION_MEDIA_REFERENCES = 256;
const MAX_RESUMABLE_RUN_STATE_AGE_MS = 30 * 60_000;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AgentSessionRecord {
  id: string;
  projectId: string;
  title: string;
  modelRef: string;
  createdAt: number;
  updatedAt: number;
  items: AgentInputItem[];
  mediaReferences?: AgentSessionMediaReference[];
  compactedSummary?: string;
  appliedTransactions: Record<string, string>;
}

export type AgentRunStateStatus =
  | 'running'
  | 'awaiting_approval'
  | 'cancelled'
  | 'failed'
  | 'completed';

export interface AgentRunStateRecord {
  id: string;
  sessionId: string;
  projectId: string;
  status: AgentRunStateStatus;
  runtimeVersion: typeof CANVAS_AGENT_RUNTIME_VERSION;
  agentDefinitionVersion: typeof CANVAS_AGENT_DEFINITION_VERSION;
  commandSchemaVersion: typeof CANVAS_COMMAND_VERSION;
  serializedState: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionEnvelope {
  version: 1;
  sessions: AgentSessionRecord[];
}

interface RunStateEnvelope {
  version: 1;
  runStates: AgentRunStateRecord[];
}

export class AgentRunStateCompatibilityError extends Error {
  constructor(readonly reasons: string[]) {
    super(`Agent RunState cannot be resumed: ${reasons.join('; ')}`);
    this.name = 'AgentRunStateCompatibilityError';
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isSensitiveKey(key: string): boolean {
  return /(?:^|_)(?:api_?key|authorization|cookie|secret|password|credential|access_?token|refresh_?token|private_?key)(?:$|_)/i.test(key);
}

function unsafeStringReason(value: string): string | null {
  const trimmed = value.trim();
  if (/^(?:data|blob|file):/i.test(trimmed)) return 'inline or local media URL';
  if (
    /^(?:~(?:\/|$)|\\\\|\/(?:Users|home|Volumes|private|var|tmp|opt|etc|Library|Applications|System|dev|mnt)(?:\/|$)|[A-Za-z]:\\)/i.test(trimmed)
  ) return 'absolute local path';
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(value)) return 'Bearer credential';
  if (/(?:api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;]{8,}/i.test(value)) return 'credential assignment';
  if (/[?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|signature|sig|auth|authorization|credential|x-amz-signature)=[^&#]+/i.test(value)) return 'credential query value';
  if (/(?:^|[^A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{512,}={0,2}(?:$|[^A-Za-z0-9+/_=-])/.test(trimmed)) return 'long base64 payload';
  return null;
}

function assertPersistenceSafe(value: unknown, path = '$', seen = new WeakSet<object>()): void {
  if (typeof value === 'string') {
    const reason = unsafeStringReason(value);
    if (reason) throw new Error(`Agent persistence rejected ${reason} at ${path}.`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`Agent persistence rejected cyclic value at ${path}.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPersistenceSafe(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key) && item !== undefined && item !== null && item !== '') {
      throw new Error(`Agent persistence rejected sensitive field ${path}.${key}.`);
    }
    assertPersistenceSafe(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function serializeBounded(value: unknown): string {
  assertPersistenceSafe(value);
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_SERIALIZED_BYTES) {
    throw new Error('Agent persistence payload exceeds the 8 MB safety limit.');
  }
  return serialized;
}

export function assertAgentSerializedRunStateSafe(serializedState: string): void {
  if (new TextEncoder().encode(serializedState).byteLength > MAX_SERIALIZED_BYTES) {
    throw new Error('Agent RunState exceeds the 8 MB safety limit.');
  }
  let parsedState: unknown;
  try {
    parsedState = JSON.parse(serializedState);
  } catch {
    throw new Error('Agent RunState must be valid serialized JSON.');
  }
  assertPersistenceSafe(parsedState, '$.serializedState');
}

function parseSessionEnvelope(raw: string | null): SessionEnvelope {
  if (!raw) return { version: 1, sessions: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<SessionEnvelope>;
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error('unsupported session schema');
    assertPersistenceSafe(parsed);
    const sessions = parsed.sessions.filter(isAgentSessionRecord);
    if (sessions.length !== parsed.sessions.length) throw new Error('invalid session record');
    return { version: 1, sessions };
  } catch {
    return { version: 1, sessions: [] };
  }
}

function parseRunStateEnvelope(raw: string | null, now = Date.now()): RunStateEnvelope {
  if (!raw) return { version: 1, runStates: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<RunStateEnvelope>;
    if (parsed.version !== 1 || !Array.isArray(parsed.runStates)) throw new Error('unsupported run-state schema');
    const runStates = parsed.runStates.filter(isAgentRunStateRecord).map((record) => {
      const resumable = record.status === 'running' || record.status === 'awaiting_approval';
      const stale = resumable
        && now >= record.updatedAt
        && now - record.updatedAt > MAX_RESUMABLE_RUN_STATE_AGE_MS;
      const terminal = stale
        || record.status === 'completed'
        || record.status === 'failed'
        || record.status === 'cancelled';
      const normalized = terminal
        ? { ...record, ...(stale ? { status: 'cancelled' as const } : {}), serializedState: '{}' }
        : record;
      assertPersistenceSafe({ ...normalized, serializedState: '{}' });
      assertAgentSerializedRunStateSafe(normalized.serializedState);
      return normalized;
    });
    if (runStates.length !== parsed.runStates.length) throw new Error('invalid run-state record');
    return { version: 1, runStates };
  } catch {
    return { version: 1, runStates: [] };
  }
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isAgentSessionRecord(value: unknown): value is AgentSessionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<AgentSessionRecord>;
  return typeof record.id === 'string'
    && typeof record.projectId === 'string'
    && typeof record.title === 'string'
    && typeof record.modelRef === 'string'
    && isFiniteTimestamp(record.createdAt)
    && isFiniteTimestamp(record.updatedAt)
    && Array.isArray(record.items)
    && record.items.length <= MAX_SESSION_ITEMS
    && (record.mediaReferences === undefined
      || (Array.isArray(record.mediaReferences)
        && record.mediaReferences.length <= MAX_SESSION_MEDIA_REFERENCES
        && record.mediaReferences.every(isAgentSessionMediaReference)))
    && Boolean(record.appliedTransactions)
    && typeof record.appliedTransactions === 'object'
    && !Array.isArray(record.appliedTransactions);
}

function isAgentSessionMediaReference(value: unknown): value is AgentSessionMediaReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<AgentSessionMediaReference>;
  return typeof record.referenceId === 'string'
    && record.referenceId.length > 0
    && record.referenceId.length <= 512
    && typeof record.runId === 'string'
    && record.runId.length > 0
    && record.runId.length <= 256
    && typeof record.assetId === 'string'
    && record.assetId.length > 0
    && record.assetId.length <= 512
    && (record.nodeId === undefined || (typeof record.nodeId === 'string' && record.nodeId.length <= 512))
    && typeof record.title === 'string'
    && record.title.length <= 240
    && (record.origin === 'canvas-asset' || record.origin === 'upload')
    && (record.mimeType === undefined || (typeof record.mimeType === 'string' && record.mimeType.length <= 120))
    && isFiniteTimestamp(record.createdAt);
}

function isAgentRunStateRecord(value: unknown): value is AgentRunStateRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<AgentRunStateRecord>;
  return typeof record.id === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.projectId === 'string'
    && typeof record.status === 'string'
    && typeof record.runtimeVersion === 'number'
    && typeof record.agentDefinitionVersion === 'number'
    && typeof record.commandSchemaVersion === 'number'
    && typeof record.serializedState === 'string'
    && isFiniteTimestamp(record.createdAt)
    && isFiniteTimestamp(record.updatedAt);
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    // Reading remains available when WebKit has reached its localStorage
    // quota. A write-probe incorrectly turned a full-but-readable store into
    // an empty in-memory repository, hiding all existing Agent history.
    void window.localStorage.length;
    return window.localStorage;
  } catch {
    return null;
  }
}

export class AgentSessionRepository {
  private sessionMemory: SessionEnvelope = { version: 1, sessions: [] };
  private runStateMemory: RunStateEnvelope = { version: 1, runStates: [] };

  constructor(
    private storage: StorageLike | null = defaultStorage(),
    private readonly now: () => number = () => Date.now(),
    private readonly nextId: () => string = () => globalThis.crypto?.randomUUID?.()
      ?? `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  ) {
    this.compactPersistedTerminalRunStates();
  }

  listSessions(projectId: string): AgentSessionRecord[] {
    return this.readSessions().sessions
      .filter((session) => session.projectId === projectId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(cloneJson);
  }

  getSession(sessionId: string): AgentSessionRecord | null {
    const session = this.readSessions().sessions.find((candidate) => candidate.id === sessionId);
    return session ? cloneJson(session) : null;
  }

  createSession(input: { projectId: string; title?: string; modelRef: string }): AgentSessionRecord {
    const now = this.now();
    const record: AgentSessionRecord = {
      id: this.nextId(),
      projectId: input.projectId,
      title: input.title?.trim() || '新对话',
      modelRef: input.modelRef,
      createdAt: now,
      updatedAt: now,
      items: [],
      mediaReferences: [],
      appliedTransactions: {},
    };
    const envelope = this.readSessions();
    envelope.sessions.push(record);
    this.writeSessions(envelope);
    return cloneJson(record);
  }

  updateSessionMetadata(
    sessionId: string,
    patch: Partial<Pick<AgentSessionRecord, 'title' | 'modelRef' | 'compactedSummary'>>,
  ): AgentSessionRecord {
    if (
      patch.compactedSummary !== undefined
      && patch.compactedSummary.length > MAX_COMPACTED_SUMMARY_CHARACTERS
    ) {
      throw new Error('Agent compacted summary exceeds 100000 characters.');
    }
    const envelope = this.readSessions();
    const index = envelope.sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) throw new Error(`Agent session ${sessionId} does not exist.`);
    const current = envelope.sessions[index];
    const next = {
      ...current,
      ...patch,
      title: patch.title === undefined ? current.title : patch.title.trim() || '新对话',
      updatedAt: this.now(),
    };
    envelope.sessions[index] = next;
    this.writeSessions(envelope);
    return cloneJson(next);
  }

  replaceItems(sessionId: string, items: AgentInputItem[]): void {
    if (items.length > MAX_SESSION_ITEMS) throw new Error('Agent session exceeds 2000 history items.');
    assertPersistenceSafe(items);
    this.mutateSession(sessionId, (session) => ({ ...session, items: cloneJson(items) }));
  }

  recordMediaReferences(
    sessionId: string,
    references: AgentSessionMediaReference[],
  ): AgentSessionRecord {
    if (!references.length) {
      const session = this.getSession(sessionId);
      if (!session) throw new Error(`Agent session ${sessionId} does not exist.`);
      return session;
    }
    if (!references.every(isAgentSessionMediaReference)) {
      throw new Error('Agent session media metadata is invalid or exceeds its field limits.');
    }
    return this.mutateSession(sessionId, (session) => {
      const byId = new Map((session.mediaReferences ?? []).map((reference) => [reference.referenceId, reference]));
      for (const reference of references) byId.set(reference.referenceId, cloneJson(reference));
      const mediaReferences = Array.from(byId.values())
        .sort((left, right) => left.createdAt - right.createdAt || left.referenceId.localeCompare(right.referenceId))
        .slice(-MAX_SESSION_MEDIA_REFERENCES);
      return { ...session, mediaReferences };
    });
  }

  getMediaReferences(sessionId: string): AgentSessionMediaReference[] {
    return this.getSession(sessionId)?.mediaReferences?.map(cloneJson) ?? [];
  }

  compactSession(
    sessionId: string,
    input: { summary: string; replacementItems: AgentInputItem[] },
  ): AgentSessionRecord {
    const summary = input.summary.trim();
    if (!summary) throw new Error('Agent compaction summary cannot be empty.');
    if (summary.length > MAX_COMPACTED_SUMMARY_CHARACTERS) {
      throw new Error('Agent compacted summary exceeds 100000 characters.');
    }
    if (input.replacementItems.length > MAX_SESSION_ITEMS) {
      throw new Error('Agent session exceeds 2000 history items.');
    }
    assertPersistenceSafe(input.replacementItems);
    return this.mutateSession(sessionId, (session) => ({
      ...session,
      compactedSummary: summary,
      items: cloneJson(input.replacementItems),
    }));
  }

  deleteSession(sessionId: string): void {
    const sessions = this.readSessions();
    sessions.sessions = sessions.sessions.filter((session) => session.id !== sessionId);
    this.writeSessions(sessions);
    const runStates = this.readRunStates();
    runStates.runStates = runStates.runStates.filter((runState) => runState.sessionId !== sessionId);
    this.writeRunStates(runStates);
  }

  saveRunState(
    input: Omit<AgentRunStateRecord, 'runtimeVersion' | 'agentDefinitionVersion' | 'commandSchemaVersion' | 'createdAt' | 'updatedAt'>,
  ): AgentRunStateRecord {
    const session = this.getSession(input.sessionId);
    if (!session) throw new Error(`Agent session ${input.sessionId} does not exist.`);
    if (session.projectId !== input.projectId) {
      throw new Error('Agent RunState project does not match its session project.');
    }
    const serializedState = input.status === 'awaiting_approval' || input.status === 'running'
      ? input.serializedState
      : '{}';
    assertAgentSerializedRunStateSafe(serializedState);
    const envelope = this.readRunStates();
    const existingIndex = envelope.runStates.findIndex((record) => record.id === input.id);
    const now = this.now();
    const record: AgentRunStateRecord = {
      ...input,
      serializedState,
      runtimeVersion: CANVAS_AGENT_RUNTIME_VERSION,
      agentDefinitionVersion: CANVAS_AGENT_DEFINITION_VERSION,
      commandSchemaVersion: CANVAS_COMMAND_VERSION,
      createdAt: existingIndex >= 0 ? envelope.runStates[existingIndex].createdAt : now,
      updatedAt: now,
    };
    if (existingIndex >= 0) envelope.runStates[existingIndex] = record;
    else envelope.runStates.push(record);
    this.writeRunStates(envelope);
    return cloneJson(record);
  }

  getRunState(runStateId: string): AgentRunStateRecord | null {
    const envelope = this.readRunStates();
    const index = envelope.runStates.findIndex((candidate) => candidate.id === runStateId);
    const record = index >= 0 ? envelope.runStates[index] : undefined;
    if (record && (record.status === 'running' || record.status === 'awaiting_approval')) {
      const now = this.now();
      if (now >= record.updatedAt && now - record.updatedAt > MAX_RESUMABLE_RUN_STATE_AGE_MS) {
        const cancelled = { ...record, status: 'cancelled' as const, serializedState: '{}', updatedAt: now };
        envelope.runStates[index] = cancelled;
        this.writeRunStates(envelope);
        return cloneJson(cancelled);
      }
    }
    return record ? cloneJson(record) : null;
  }

  getRunStateForResume(runStateId: string): AgentRunStateRecord {
    const record = this.getRunState(runStateId);
    if (!record) throw new Error(`Agent RunState ${runStateId} does not exist.`);
    const reasons: string[] = [];
    if (record.status !== 'awaiting_approval') {
      reasons.push(`run status ${record.status} is not resumable`);
    }
    if (record.runtimeVersion !== CANVAS_AGENT_RUNTIME_VERSION) {
      reasons.push(`runtime version ${record.runtimeVersion} is not supported`);
    }
    if (record.agentDefinitionVersion !== CANVAS_AGENT_DEFINITION_VERSION) {
      reasons.push(`agent definition version ${record.agentDefinitionVersion} is not supported`);
    }
    if (record.commandSchemaVersion !== CANVAS_COMMAND_VERSION) {
      reasons.push(`canvas command version ${record.commandSchemaVersion} is not supported`);
    }
    const session = this.getSession(record.sessionId);
    if (!session || session.projectId !== record.projectId) {
      reasons.push('session/project ownership changed');
    }
    if (reasons.length) throw new AgentRunStateCompatibilityError(reasons);
    return record;
  }

  updateRunStateStatus(runStateId: string, status: AgentRunStateStatus): AgentRunStateRecord {
    const envelope = this.readRunStates();
    const index = envelope.runStates.findIndex((record) => record.id === runStateId);
    if (index < 0) throw new Error(`Agent RunState ${runStateId} does not exist.`);
    const record = {
      ...envelope.runStates[index],
      status,
      ...((status === 'completed' || status === 'failed' || status === 'cancelled')
        ? { serializedState: '{}' }
        : {}),
      updatedAt: this.now(),
    };
    envelope.runStates[index] = record;
    this.writeRunStates(envelope);
    return cloneJson(record);
  }

  listRunStates(sessionId: string): AgentRunStateRecord[] {
    return this.readRunStates().runStates
      .filter((record) => record.sessionId === sessionId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(cloneJson);
  }

  deleteRunState(runStateId: string): void {
    const envelope = this.readRunStates();
    envelope.runStates = envelope.runStates.filter((record) => record.id !== runStateId);
    this.writeRunStates(envelope);
  }

  pruneTerminalRunStates(sessionId: string, keep = 20): number {
    const envelope = this.readRunStates();
    const terminal = envelope.runStates
      .filter((record) => (
        record.sessionId === sessionId
        && (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled')
      ))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const remove = new Set(terminal.slice(Math.max(0, keep)).map((record) => record.id));
    if (!remove.size) return 0;
    envelope.runStates = envelope.runStates.filter((record) => !remove.has(record.id));
    this.writeRunStates(envelope);
    return remove.size;
  }

  estimateSessionBytes(sessionId: string): number {
    const session = this.getSession(sessionId);
    if (!session) return 0;
    return new TextEncoder().encode(JSON.stringify(session)).byteLength;
  }

  createSdkSession(sessionId: string): PersistentAgentSession {
    if (!this.getSession(sessionId)) throw new Error(`Agent session ${sessionId} does not exist.`);
    return new PersistentAgentSession(this, sessionId);
  }

  private mutateSession(
    sessionId: string,
    mutate: (session: AgentSessionRecord) => AgentSessionRecord,
  ): AgentSessionRecord {
    const envelope = this.readSessions();
    const index = envelope.sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) throw new Error(`Agent session ${sessionId} does not exist.`);
    const next = { ...mutate(cloneJson(envelope.sessions[index])), updatedAt: this.now() };
    assertPersistenceSafe(next);
    envelope.sessions[index] = next;
    this.writeSessions(envelope);
    return cloneJson(next);
  }

  private readSessions(): SessionEnvelope {
    if (!this.storage) return cloneJson(this.sessionMemory);
    try {
      return parseSessionEnvelope(this.storage.getItem(SESSION_STORAGE_KEY));
    } catch {
      this.switchToMemory();
      return cloneJson(this.sessionMemory);
    }
  }

  private writeSessions(envelope: SessionEnvelope): void {
    const serialized = serializeBounded(envelope);
    if (!this.storage) this.sessionMemory = cloneJson(envelope);
    else {
      try {
        this.storage.setItem(SESSION_STORAGE_KEY, serialized);
      } catch {
        this.compactPersistedTerminalRunStates();
        if (!this.storage) {
          this.sessionMemory = cloneJson(envelope);
          return;
        }
        try {
          this.storage.setItem(SESSION_STORAGE_KEY, serialized);
        } catch {
          this.switchToMemory({ sessions: envelope });
        }
      }
    }
  }

  private readRunStates(): RunStateEnvelope {
    if (!this.storage) return cloneJson(this.runStateMemory);
    try {
      return parseRunStateEnvelope(this.storage.getItem(RUN_STATE_STORAGE_KEY), this.now());
    } catch {
      this.switchToMemory();
      return cloneJson(this.runStateMemory);
    }
  }

  private writeRunStates(envelope: RunStateEnvelope): void {
    const serialized = serializeBounded(envelope);
    if (!this.storage) this.runStateMemory = cloneJson(envelope);
    else {
      try {
        this.storage.setItem(RUN_STATE_STORAGE_KEY, serialized);
      } catch {
        this.switchToMemory({ runStates: envelope });
      }
    }
  }

  private compactPersistedTerminalRunStates(): void {
    if (!this.storage) return;
    let raw: string | null;
    let envelope: RunStateEnvelope;
    try {
      raw = this.storage.getItem(RUN_STATE_STORAGE_KEY);
      envelope = parseRunStateEnvelope(raw, this.now());
    } catch {
      this.switchToMemory();
      return;
    }
    const serialized = serializeBounded(envelope);
    if (raw === serialized) return;
    try {
      this.storage.setItem(RUN_STATE_STORAGE_KEY, serialized);
    } catch {
      this.switchToMemory({ runStates: envelope });
    }
  }

  private switchToMemory(overrides: {
    sessions?: SessionEnvelope;
    runStates?: RunStateEnvelope;
  } = {}): void {
    const storage = this.storage;
    if (storage) {
      if (!overrides.sessions) {
        try {
          this.sessionMemory = parseSessionEnvelope(storage.getItem(SESSION_STORAGE_KEY));
        } catch {
          // Keep the last valid memory snapshot.
        }
      }
      if (!overrides.runStates) {
        try {
          this.runStateMemory = parseRunStateEnvelope(storage.getItem(RUN_STATE_STORAGE_KEY), this.now());
        } catch {
          // Keep the last valid memory snapshot.
        }
      }
    }
    if (overrides.sessions) this.sessionMemory = cloneJson(overrides.sessions);
    if (overrides.runStates) this.runStateMemory = cloneJson(overrides.runStates);
    this.storage = null;
  }

  async applyHistoryMutation(sessionId: string, args: SessionHistoryRewriteArgs): Promise<void> {
    this.mutateSession(sessionId, (session) => {
      const items = cloneJson(session.items);
      for (const mutation of args.mutations) {
        if (mutation.type !== 'replace_function_call') continue;
        const index = items.findIndex((item) => (
          item.type === 'function_call' && item.callId === mutation.callId
        ));
        if (index >= 0) items[index] = cloneJson(mutation.replacement);
      }
      return { ...session, items };
    });
  }

  async applyHistoryTransaction(sessionId: string, args: SessionHistoryTransactionArgs): Promise<void> {
    const fingerprint = stableStringify(args.transaction);
    this.mutateSession(sessionId, (session) => {
      const prior = session.appliedTransactions[args.operationId];
      if (prior) {
        if (prior !== fingerprint) throw new Error('Agent session operation id was reused with different input.');
        return session;
      }
      let items = cloneJson(session.items);
      if (args.transaction.type === 'append_items') {
        items.push(...cloneJson(args.transaction.items));
      } else {
        const suffixLength = args.transaction.expectedSuffix.length;
        const currentSuffix = suffixLength === 0 ? [] : items.slice(-suffixLength);
        if (stableStringify(currentSuffix) !== stableStringify(args.transaction.expectedSuffix)) {
          throw new Error('Agent session history suffix changed before replacement.');
        }
        items = [
          ...items.slice(0, Math.max(0, items.length - suffixLength)),
          ...cloneJson(args.transaction.replacement),
        ];
      }
      if (items.length > MAX_SESSION_ITEMS) throw new Error('Agent session exceeds 2000 history items.');
      assertPersistenceSafe(items);
      return {
        ...session,
        items,
        appliedTransactions: { ...session.appliedTransactions, [args.operationId]: fingerprint },
      };
    });
  }
}

export class PersistentAgentSession
implements SessionHistoryRewriteAwareSession, SessionHistoryTransactionAwareSession {
  constructor(
    private readonly repository: AgentSessionRepository,
    private readonly sessionId: string,
  ) {}

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const items = this.repository.getSession(this.sessionId)?.items ?? [];
    return cloneJson(typeof limit === 'number' ? items.slice(-Math.max(0, limit)) : items);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    await this.repository.applyHistoryTransaction(this.sessionId, {
      operationId: `append-${this.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      transaction: { type: 'append_items', items },
    });
  }

  async replaceHistoryWithCompaction(items: AgentInputItem[]): Promise<void> {
    this.repository.replaceItems(this.sessionId, items);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const current = this.repository.getSession(this.sessionId)?.items ?? [];
    const item = current[current.length - 1];
    this.repository.replaceItems(this.sessionId, current.slice(0, -1));
    return item ? cloneJson(item) : undefined;
  }

  async clearSession(): Promise<void> {
    this.repository.replaceItems(this.sessionId, []);
  }

  async applyHistoryMutations(args: SessionHistoryRewriteArgs): Promise<void> {
    await this.repository.applyHistoryMutation(this.sessionId, args);
  }

  async applyHistoryTransaction(args: SessionHistoryTransactionArgs): Promise<void> {
    await this.repository.applyHistoryTransaction(this.sessionId, args);
  }
}
