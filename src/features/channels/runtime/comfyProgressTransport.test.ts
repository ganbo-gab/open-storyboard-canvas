import { afterEach, expect, it, vi } from 'vitest';
import { openComfyProgressSocket } from './comfyProgressTransport';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('does not attempt a WebSocket when it would require custom headers', async () => {
  const ctor = vi.fn(); vi.stubGlobal('WebSocket', ctor);
  await expect(openComfyProgressSocket('wss://example.invalid/ws', { message: vi.fn(), close: vi.fn(), error: vi.fn() }, { Authorization: 'Bearer fixture' })).rejects.toThrow(/unavailable/);
  expect(ctor).not.toHaveBeenCalled();
});

it('bounds connection setup and closes an unresponsive socket', async () => {
  vi.useFakeTimers(); const close = vi.fn();
  vi.stubGlobal('WebSocket', class { onopen = null; onmessage = null; onclose = null; onerror = null; close = close; });
  const opened = openComfyProgressSocket('ws://127.0.0.1/ws', { message: vi.fn(), close: vi.fn(), error: vi.fn() }, {});
  const rejected = expect(opened).rejects.toThrow(/timeout/);
  await vi.advanceTimersByTimeAsync(1500); await rejected;
  expect(close).toHaveBeenCalledOnce();
});
