import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { isPlainRecord as isRecord } from '@/features/portability/application/validation';
import { z } from 'zod';

export interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

type PatchPath = Array<string | number>;
export type CanvasHistoryPatch = {
  kind: 'value';
  path: PatchPath;
  beforeExists: boolean;
  afterExists: boolean;
  before?: unknown;
  after?: unknown;
} | {
  kind: 'splice';
  path: PatchPath;
  index: number;
  removed: unknown[];
  added: unknown[];
};

export interface CanvasHistoryEntry {
  version: 1;
  patches: CanvasHistoryPatch[];
  /** Stable Agent turn identity; only adjacent edits with the same identity may compose. */
  groupId?: string;
  /** Provenance survives ordinary undo-group boundaries and persistence. */
  agentTurnId?: string;
  /** Conservative retained-payload estimate, recomputed when loading untrusted history. */
  bytes: number;
}

export interface CanvasHistoryState {
  past: CanvasHistoryEntry[];
  future: CanvasHistoryEntry[];
}

export const MAX_HISTORY_STEPS = 200;
export const MAX_PERSISTED_HISTORY_STEPS = 50;
// Changed media can be arbitrarily large. Evict whole oldest entries, never part of a transaction.
export const MAX_HISTORY_BYTES = 32 * 1024 * 1024;

const pathSchema = z.array(z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().refine((key) => !['__proto__', 'constructor', 'prototype'].includes(key)),
])).min(1).max(100).refine((path) => path[0] === 'nodes' || path[0] === 'edges');
const entrySchema = z.object({
  version: z.literal(1),
  groupId: z.string().min(1).max(4_096).optional(),
  agentTurnId: z.string().min(1).max(4_096).optional(),
  patches: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('value'), path: pathSchema, beforeExists: z.boolean(), afterExists: z.boolean(), before: z.unknown().optional(), after: z.unknown().optional() }),
    z.object({ kind: z.literal('splice'), path: pathSchema, index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), removed: z.array(z.unknown()), added: z.array(z.unknown()) }),
  ])).min(1),
});
function estimateBytes(value: unknown): number {
  if (typeof value === 'string') return value.length * 2 + 16;
  if (Array.isArray(value)) return value.reduce<number>((size, item) => size + estimateBytes(item), 24);
  if (isRecord(value)) return Object.entries(value).reduce((size, [key, item]) => size + key.length * 2 + estimateBytes(item), 32);
  return 8;
}

function diffValue(before: unknown, after: unknown, path: PatchPath, patches: CanvasHistoryPatch[]): void {
  if (Object.is(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const sharedLength = Math.min(before.length, after.length);
    for (let index = 0; index < sharedLength; index += 1) diffValue(before[index], after[index], [...path, index], patches);
    if (before.length !== after.length) patches.push({ kind: 'splice', path, index: sharedLength, removed: before.slice(sharedLength), added: after.slice(sharedLength) });
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      // Selection remains live across undo/redo, not an editable graph property.
      if (path.length === 2 && path[0] === 'nodes' && key === 'selected') continue;
      const beforeExists = Object.hasOwn(before, key), afterExists = Object.hasOwn(after, key);
      if (beforeExists && afterExists) diffValue(before[key], after[key], [...path, key], patches);
      else patches.push({ kind: 'value', path: [...path, key], beforeExists, afterExists, before: before[key], after: after[key] });
    }
    return;
  }
  patches.push({ kind: 'value', path, beforeExists: true, afterExists: true, before, after });
}

export function createCanvasHistoryEntry(before: CanvasGraph, after: CanvasGraph): CanvasHistoryEntry | null {
  const patches: CanvasHistoryPatch[] = [];
  diffValue(before.nodes, after.nodes, ['nodes'], patches);
  diffValue(before.edges, after.edges, ['edges'], patches);
  return patches.length ? { version: 1, patches, bytes: estimateBytes(patches) } : null;
}

/** Copy only the ancestors of modified paths; untouched graph/media branches remain shared. */
function changeAt(value: unknown, path: PatchPath, depth: number, change: (current: unknown) => unknown, remove = false): unknown {
  if (depth === path.length) return change(value);
  const key = path[depth];
  if (Array.isArray(value) && typeof key === 'number') {
    const result: unknown[] = value.slice();
    result[key] = changeAt(value[key], path, depth + 1, change, remove);
    return result;
  }
  if (!isRecord(value) || typeof key !== 'string') throw new Error('Invalid canvas history path.');
  const result = { ...value };
  if (remove && depth === path.length - 1) delete result[key];
  else result[key] = changeAt(value[key], path, depth + 1, change, remove);
  return result;
}

export function applyCanvasHistoryEntry(graph: CanvasGraph, entry: CanvasHistoryEntry, direction: 'undo' | 'redo'): CanvasGraph {
  let result: unknown = graph;
  const undo = direction === 'undo';
  const patches = undo ? entry.patches.slice().reverse() : entry.patches;
  for (const patch of patches) {
    if (patch.kind === 'splice') {
      result = changeAt(result, patch.path, 0, (current) => {
        if (!Array.isArray(current)) throw new Error('Invalid canvas history array.');
        const array: unknown[] = current.slice();
        array.splice(patch.index, undo ? patch.added.length : patch.removed.length, ...(undo ? patch.removed : patch.added));
        return array;
      });
    } else {
      result = changeAt(result, patch.path, 0, () => undo ? patch.before : patch.after, !(undo ? patch.beforeExists : patch.afterExists));
    }
  }
  return result as CanvasGraph;
}

export function trimCanvasHistory(history: CanvasHistoryState, steps = MAX_HISTORY_STEPS): CanvasHistoryState {
  const past = history.past.slice(-steps);
  const futureCapacity = Math.max(0, steps - past.length);
  const future = futureCapacity ? history.future.slice(-futureCapacity) : [];
  let bytes = past.reduce((sum, entry) => sum + entry.bytes, 0)
    + future.reduce((sum, entry) => sum + entry.bytes, 0);
  while (bytes > MAX_HISTORY_BYTES && (past.length || future.length)) {
    const removed = past.length ? past.shift()! : future.shift()!;
    bytes -= removed.bytes;
  }
  return { past, future };
}

let recordingGroupId: string | undefined;
let recordingAgentTurnId: string | undefined;

/** Read synchronously at an async boundary, then pass the captured id explicitly. */
export function getCanvasHistoryAgentTurn(): string | undefined {
  return recordingAgentTurnId;
}

/** Tags provenance only; unlike a history group this never merges undo entries. */
export function withCanvasHistoryAgentTurn<T>(agentTurnId: string | undefined, commit: () => T): T {
  const previous = recordingAgentTurnId;
  recordingAgentTurnId = agentTurnId;
  try {
    return commit();
  } finally {
    recordingAgentTurnId = previous;
  }
}

/** Scope only the synchronous graph commit, never an async tool/network/approval wait. */
export function withCanvasHistoryGroup<T>(groupId: string | undefined, commit: () => T): T {
  const previous = recordingGroupId;
  recordingGroupId = groupId;
  try {
    return withCanvasHistoryAgentTurn(groupId ?? recordingAgentTurnId, commit);
  } finally {
    recordingGroupId = previous;
  }
}

/** Non-graph side effects separate subsequent graph edits even when the run id is unchanged. */
export function closeCanvasHistoryGroup(history: CanvasHistoryState): CanvasHistoryState {
  const last = history.past[history.past.length - 1];
  if (!last?.groupId) return history;
  const { groupId: _groupId, ...closed } = last;
  return { past: [...history.past.slice(0, -1), closed], future: history.future };
}

export function appendCanvasHistory(history: CanvasHistoryState, before: CanvasGraph, after: CanvasGraph): CanvasHistoryState {
  const previous = history.past[history.past.length - 1];
  const joinsPrevious = recordingGroupId !== undefined && previous?.groupId === recordingGroupId && history.future.length === 0;
  const start = joinsPrevious ? applyCanvasHistoryEntry(before, previous, 'undo') : before;
  const entry = createCanvasHistoryEntry(start, after);
  if (!entry) return joinsPrevious ? { past: history.past.slice(0, -1), future: [] } : history;
  if (recordingGroupId) entry.groupId = recordingGroupId;
  if (recordingAgentTurnId) entry.agentTurnId = recordingAgentTurnId;
  // An over-budget transaction remains applied but cannot leave an older, disconnected undo chain.
  if (entry.bytes > MAX_HISTORY_BYTES) return { past: [], future: [] };
  return trimCanvasHistory({ past: [...(joinsPrevious ? history.past.slice(0, -1) : history.past), entry], future: [] });
}

function readEntry(value: unknown): CanvasHistoryEntry | null {
  const parsed = entrySchema.safeParse(value);
  if (!parsed.success) return null;
  return { ...parsed.data, bytes: estimateBytes(parsed.data.patches) };
}

/** Load current patches or migrate legacy snapshots. A corrupt link drops only that older chain. */
export function normalizeCanvasHistory(history: unknown, current: CanvasGraph, normalizeGraph: (graph: CanvasGraph) => CanvasGraph = (graph) => graph): CanvasHistoryState {
  if (!isRecord(history)) return { past: [], future: [] };
  const normalizeStack = (raw: unknown, direction: 'undo' | 'redo'): CanvasHistoryEntry[] => {
    if (!Array.isArray(raw)) return [];
    let cursor = current;
    const entries: CanvasHistoryEntry[] = [];
    for (const value of raw.slice(-MAX_HISTORY_STEPS).reverse()) {
      try {
        const entry = readEntry(value);
        if (entry) {
          if (entry.bytes > MAX_HISTORY_BYTES) break;
          cursor = applyCanvasHistoryEntry(cursor, entry, direction);
          entries.push(entry);
        } else if (isRecord(value) && Array.isArray(value.nodes) && Array.isArray(value.edges)) {
          const target = normalizeGraph({ nodes: value.nodes as CanvasNode[], edges: value.edges as CanvasEdge[] });
          const migrated = direction === 'undo' ? createCanvasHistoryEntry(target, cursor) : createCanvasHistoryEntry(cursor, target);
          if (migrated) {
            const groupId = entrySchema.shape.groupId.safeParse(value.historyGroupId);
            if (groupId.success && groupId.data) migrated.groupId = groupId.data;
            const agentTurnId = entrySchema.shape.agentTurnId.safeParse(value.historyAgentTurnId);
            if (agentTurnId.success && agentTurnId.data) migrated.agentTurnId = agentTurnId.data;
            entries.push(migrated);
          }
          cursor = target;
        } else break;
      } catch {
        break;
      }
    }
    return entries.reverse();
  };
  return trimCanvasHistory({ past: normalizeStack(history.past, 'undo'), future: normalizeStack(history.future, 'redo') });
}

/** Media pooling/decoding must also reach leaf values and inserted graph fragments in patches. */
export function mapCanvasHistoryValues(history: CanvasHistoryState, map: (value: unknown, path: PatchPath) => unknown): CanvasHistoryState {
  const mapEntry = (entry: CanvasHistoryEntry): CanvasHistoryEntry => {
    const patches = entry.patches.map((patch): CanvasHistoryPatch => patch.kind === 'value'
      ? { ...patch, before: map(patch.before, patch.path), after: map(patch.after, patch.path) }
      : { ...patch, removed: patch.removed.map((value, index) => map(value, [...patch.path, patch.index + index])), added: patch.added.map((value, index) => map(value, [...patch.path, patch.index + index])) });
    return { ...entry, patches, bytes: estimateBytes(patches) };
  };
  return { past: history.past.map(mapEntry), future: history.future.map(mapEntry) };
}
