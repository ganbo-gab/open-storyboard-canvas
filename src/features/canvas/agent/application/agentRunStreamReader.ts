export interface AgentRunReadableStream<TEvent> {
  getReader(): {
    read(): Promise<ReadableStreamReadResult<TEvent>>;
    releaseLock(): void;
  };
}

export interface AgentRunStreamSource {
  toStream(): object;
  completed: Promise<void>;
}

function isAgentRunReadableStream<TEvent>(value: unknown): value is AgentRunReadableStream<TEvent> {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as { getReader?: unknown }).getReader === 'function';
}

/**
 * Consume an Agents SDK run through the Web Streams reader contract.
 *
 * WebKit versions used by some macOS Tauri releases implement getReader()
 * without implementing the optional ReadableStream async iterator. Keeping
 * this boundary independent from Symbol.asyncIterator makes every provider
 * using the shared SDK runtime behave consistently in those WebViews.
 */
export async function consumeAgentRunStream<TEvent>(
  source: AgentRunStreamSource,
  onEvent: (event: TEvent) => void | Promise<void>,
): Promise<void> {
  const stream = source.toStream();
  if (!isAgentRunReadableStream<TEvent>(stream)) {
    throw new TypeError('The Agent SDK did not provide a readable Web Stream.');
  }
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      await onEvent(next.value);
    }
    await source.completed;
  } finally {
    reader.releaseLock();
  }
}
