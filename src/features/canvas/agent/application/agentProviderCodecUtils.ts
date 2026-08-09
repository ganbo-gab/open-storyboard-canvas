import type {
  AgentModelToolCall,
  AgentModelToolDefinition,
} from '../domain/agentModel';

export type JsonRecord = Record<string, unknown>;

export class AgentModelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentModelProtocolError';
  }
}

export function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function getPath(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function jsonString(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    throw new AgentModelProtocolError('Provider returned non-serializable tool arguments.');
  }
}

export function safeResponseId(value: unknown): string {
  return stringValue(value)
    ?? globalThis.crypto?.randomUUID?.()
    ?? `agent-response-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function wireToolName(
  tool: Pick<AgentModelToolDefinition, 'name' | 'namespace'>,
): string {
  return tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
}

export function decodeToolName(
  value: string,
  tools: readonly AgentModelToolDefinition[],
): Pick<AgentModelToolCall, 'name' | 'namespace'> {
  const match = tools.find((tool) => wireToolName(tool) === value);
  return match ? { name: match.name, namespace: match.namespace } : { name: value };
}

export function parseToolArguments(value: string): JsonRecord {
  try {
    const parsed = JSON.parse(value) as unknown;
    const record = asRecord(parsed);
    if (!record) throw new Error('not an object');
    return record;
  } catch {
    throw new AgentModelProtocolError('Tool arguments must be a JSON object.');
  }
}
