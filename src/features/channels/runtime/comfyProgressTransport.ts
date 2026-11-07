import { resolveSecretTokens } from '@/features/secrets/secretStore';
import type { ComfyUIDependencies } from '../adapters/comfyui/adapter';

/** WebView WebSockets cannot attach custom headers or honor explicit HTTP proxy routes.
 * Callers retain HTTP polling for those connections; credentials are never moved to a URL.
 */
export const openComfyProgressSocket: NonNullable<ComfyUIDependencies['ws']> = async (source, callbacks, headers) => {
  if (Object.keys(headers).length || typeof WebSocket === 'undefined') throw new Error('WebSocket transport unavailable');
  const url = await resolveSecretTokens(source, true);
  return new Promise<{ close(): void }>((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; socket.close(); reject(new Error('WebSocket connection timeout'));
    }, 1500);
    socket.onopen = () => { settled = true; clearTimeout(timer); resolve({ close: () => socket.close() }); };
    socket.onmessage = (event) => { if (typeof event.data === 'string') callbacks.message(event.data); };
    socket.onerror = () => {
      clearTimeout(timer);
      if (!settled) { settled = true; socket.close(); reject(new Error('WebSocket connection unavailable')); }
      else callbacks.error();
    };
    socket.onclose = () => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new Error('WebSocket closed before connection')); }
      callbacks.close();
    };
  });
};
