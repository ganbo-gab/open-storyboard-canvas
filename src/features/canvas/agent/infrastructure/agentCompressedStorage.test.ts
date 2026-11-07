import { describe, expect, it } from 'vitest';
import { createAgentCompressedStorage } from './agentCompressedStorage';

function localStore(limit = Infinity) {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      const next = new Map(values); next.set(key, value);
      if ([...next].reduce((size, [name, text]) => size + 2 * (name.length + text.length), 0) > limit) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      values.set(key, value);
    }, removeItem: (key: string) => { values.delete(key); },
  };
}
const history = JSON.stringify({ version: 1, sessions: [{ id: 'session', items: Array.from({ length: 200 }, (_, index) => ({ callId: `call-${index}`, result: '原始工具结果'.repeat(100) })) }] });
describe('lossless Agent storage under the WebKit shared quota', () => {
  it('migrates legacy history only after a verified write and reads it exactly after reopening', () => {
    const store = localStore(); store.setItem('sessions', history);
    expect(createAgentCompressedStorage(store).getItem('sessions')).toBe(history);
    expect(store.values.has('sessions')).toBe(false);
    expect([...store.values.values()][0].length).toBeLessThan(history.length / 8);
    expect(createAgentCompressedStorage(store).getItem('sessions')).toBe(history);
  });
  it('keeps the original bytes when migration cannot commit', () => {
    const store = localStore(history.length * 2 + 100);
    store.setItem('sessions', history);
    const storage = createAgentCompressedStorage(store);
    expect(storage.getItem('sessions')).toBe(history);
    expect(store.values.get('sessions')).toBe(history);
    expect(store.values.size).toBe(1);
  });
  it('preserves the committed record when a later larger write fails', () => {
    const store = localStore(15000), storage = createAgentCompressedStorage(store);
    storage.setItem('sessions', history);
    const before = new Map(store.values);
    const noise = Array.from({ length: 3000 }, () => crypto.randomUUID()).join('');
    expect(() => storage.setItem('sessions', noise)).toThrow();
    expect(store.values).toEqual(before);
    expect(createAgentCompressedStorage(store).getItem('sessions')).toBe(history);
  });
  it('does not fall back to stale legacy data or overwrite a corrupted newer record', () => {
    const store = localStore(), storage = createAgentCompressedStorage(store);
    storage.setItem('sessions', history);
    store.values.set('sessions', 'older history');
    store.values.set('sessions:packed:v1', '{broken');
    expect(() => storage.getItem('sessions')).toThrow();
    expect(store.values.get('sessions:packed:v1')).toBe('{broken');
  });
});
