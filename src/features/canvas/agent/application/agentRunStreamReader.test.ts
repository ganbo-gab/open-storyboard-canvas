import { describe, expect, it, vi } from 'vitest';

import { consumeAgentRunStream, type AgentRunReadableStream } from './agentRunStreamReader';

function readerOnlyStream<T>(values: T[], options?: { readError?: Error }) {
  let index = 0;
  const releaseLock = vi.fn();
  const stream: AgentRunReadableStream<T> & { [Symbol.asyncIterator]?: never } = {
    getReader: () => ({
      read: async () => {
        if (options?.readError) throw options.readError;
        if (index >= values.length) return { done: true, value: undefined };
        const value = values[index];
        index += 1;
        return { done: false, value };
      },
      releaseLock,
    }),
  };
  return { stream, releaseLock };
}

describe('consumeAgentRunStream', () => {
  it('consumes a WebKit-style stream that has getReader but no async iterator', async () => {
    const { stream, releaseLock } = readerOnlyStream(['你', '好']);
    expect(stream[Symbol.asyncIterator]).toBeUndefined();
    const events: string[] = [];

    await consumeAgentRunStream<string>(
      { toStream: () => stream, completed: Promise.resolve() },
      (event) => { events.push(event); },
    );

    expect(events).toEqual(['你', '好']);
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('waits for SDK completion after the readable stream closes', async () => {
    const { stream, releaseLock } = readerOnlyStream(['delta']);
    let resolveCompleted: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    const onEvent = vi.fn();
    let settled = false;
    const pending = consumeAgentRunStream<string>({ toStream: () => stream, completed }, onEvent)
      .then(() => { settled = true; });

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    resolveCompleted?.();
    await pending;

    expect(settled).toBe(true);
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('releases the reader when reading, handling, or completion fails', async () => {
    const readFailure = readerOnlyStream<string>([], { readError: new Error('read failed') });
    await expect(consumeAgentRunStream(
      { toStream: () => readFailure.stream, completed: Promise.resolve() },
      () => undefined,
    )).rejects.toThrow('read failed');
    expect(readFailure.releaseLock).toHaveBeenCalledOnce();

    const handlerFailure = readerOnlyStream(['delta']);
    await expect(consumeAgentRunStream(
      { toStream: () => handlerFailure.stream, completed: Promise.resolve() },
      () => { throw new Error('handler failed'); },
    )).rejects.toThrow('handler failed');
    expect(handlerFailure.releaseLock).toHaveBeenCalledOnce();

    const completionFailure = readerOnlyStream<string>([]);
    await expect(consumeAgentRunStream(
      { toStream: () => completionFailure.stream, completed: Promise.reject(new Error('completion failed')) },
      () => undefined,
    )).rejects.toThrow('completion failed');
    expect(completionFailure.releaseLock).toHaveBeenCalledOnce();
  });

  it('fails clearly when the SDK does not provide the Web Streams reader contract', async () => {
    await expect(consumeAgentRunStream(
      { toStream: () => ({}), completed: Promise.resolve() },
      () => undefined,
    )).rejects.toThrow('readable Web Stream');
  });
});
