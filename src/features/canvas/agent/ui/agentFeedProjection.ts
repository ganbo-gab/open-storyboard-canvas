export function nodeIdsFromAgentOutput(output: unknown): string[] {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
  const record = output as Record<string, unknown>;
  const nested = record.output && typeof record.output === 'object' && !Array.isArray(record.output)
    ? record.output as Record<string, unknown>
    : record;
  const references = nested.references
    && typeof nested.references === 'object'
    && !Array.isArray(nested.references)
    ? nested.references as Record<string, unknown>
    : undefined;
  if (!references) return [];
  const ids = [
    ...(Array.isArray(references.nodeIds) ? references.nodeIds : []),
    ...(typeof references.nodeId === 'string' ? [references.nodeId] : []),
  ];
  return Array.from(new Set(ids.filter(
    (id): id is string => typeof id === 'string' && id.trim().length > 0,
  )));
}

export function generationLocateTargetsFromAgentOutput(output: unknown): {
  inputNodeIds: string[];
  resultNodeIds: string[];
} {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { inputNodeIds: [], resultNodeIds: [] };
  }
  const record = output as Record<string, unknown>;
  const followThrough = record.followThrough
    && typeof record.followThrough === 'object'
    && !Array.isArray(record.followThrough)
    ? record.followThrough as Record<string, unknown>
    : undefined;
  const inputNodeIds = Array.isArray(followThrough?.inputNodeIds)
    ? followThrough.inputNodeIds
    : [];
  const resultNodeIds = Array.isArray(followThrough?.resultNodeIds)
    ? followThrough.resultNodeIds
    : [];
  return {
    inputNodeIds: Array.from(new Set(inputNodeIds.filter(
      (nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.trim().length > 0,
    ))),
    resultNodeIds: Array.from(new Set(resultNodeIds.filter(
      (nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.trim().length > 0,
    ))),
  };
}

export interface AgentGenerationProgress {
  phase: 'accepted' | 'polling';
  attempt: number;
  maxAttempts: number;
  statuses: string[];
}

export function generationProgressFromAgentOutput(output: unknown): AgentGenerationProgress | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const record = output as Record<string, unknown>;
  const followThrough = record.followThrough
    && typeof record.followThrough === 'object'
    && !Array.isArray(record.followThrough)
    ? record.followThrough as Record<string, unknown>
    : null;
  if (!followThrough) return null;
  if (followThrough.phase === 'accepted') {
    return { phase: 'accepted', attempt: 0, maxAttempts: 0, statuses: [] };
  }
  if (followThrough.phase !== 'generation-follow-through') return null;
  const attempt = typeof followThrough.attempt === 'number' && Number.isFinite(followThrough.attempt)
    ? Math.max(1, Math.floor(followThrough.attempt))
    : 1;
  const maxAttempts = typeof followThrough.maxAttempts === 'number' && Number.isFinite(followThrough.maxAttempts)
    ? Math.max(attempt, Math.floor(followThrough.maxAttempts))
    : attempt;
  const statuses = Array.isArray(followThrough.statuses)
    ? followThrough.statuses.filter((status): status is string => typeof status === 'string')
    : [];
  return { phase: 'polling', attempt, maxAttempts, statuses };
}

export function executionReceiptFromAgentOutput(
  output: unknown,
): { receiptId?: string; rollbackToken?: string } {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return {};
  const record = output as Record<string, unknown>;
  const nested = record.output && typeof record.output === 'object' && !Array.isArray(record.output)
    ? record.output as Record<string, unknown>
    : undefined;
  const execution = record.execution && typeof record.execution === 'object' && !Array.isArray(record.execution)
    ? record.execution as Record<string, unknown>
    : undefined;
  const nestedExecution = nested?.execution
    && typeof nested.execution === 'object'
    && !Array.isArray(nested.execution)
    ? nested.execution as Record<string, unknown>
    : undefined;
  const receiptId = [execution?.receiptId, nestedExecution?.receiptId, record.receiptId]
    .find((value): value is string => typeof value === 'string' && Boolean(value));
  const rollbackToken = [record.rollbackToken, nested?.rollbackToken]
    .find((value): value is string => typeof value === 'string' && Boolean(value));
  return {
    ...(receiptId ? { receiptId } : {}),
    ...(rollbackToken ? { rollbackToken } : {}),
  };
}
