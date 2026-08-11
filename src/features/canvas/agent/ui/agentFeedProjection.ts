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
