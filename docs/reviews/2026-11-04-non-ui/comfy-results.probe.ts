// Audit-only: real loopback HTTP + isolated IndexedDB; no supplier requests.
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createJSONStorage } from 'zustand/middleware';
import { useCustomProvidersStore, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { submitComfyChannelJob, recoverComfyChannelJob, getComfyChannelJob } from '@/features/channels/runtime/comfyExecution';

afterEach(() => vi.unstubAllGlobals());
it('publishes both outputs of one ComfyUI batch to the consumer', async () => {
  const values = new Map<string, string>();
  const storage: Storage = {
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); }, clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null, get length() { return values.size; },
  };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('indexedDB', new IDBFactory());
  useCustomProvidersStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
  let submits = 0;
  const downloads: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/prompt') {
      submits += 1; response.end('{"prompt_id":"audit-batch"}'); return;
    }
    if (url.pathname === '/history/audit-batch') {
      response.end(JSON.stringify({ 'audit-batch': { status: { completed: true }, outputs: { '9': {
        images: ['first.png', 'second.png'].map((filename) => ({ filename, subfolder: '', type: 'output' })),
      } } } })); return;
    }
    if (url.pathname === '/view') {
      downloads.push(url.searchParams.get('filename') ?? '');
      response.setHeader('content-type', 'image/png'); response.end(png); return;
    }
    response.statusCode = 404; response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback address');
    const cfg: CustomProviderConfig = {
      id: 'audit-comfy-batch', label: 'Audit only', baseUrl: `http://127.0.0.1:${address.port}`,
      apiStyle: 'comfyui', apiKey: '', models: ['workflow'], supportsWebSearch: false,
      extraParams: { auth: { mode: 'none' }, comfyui: {
        workflow: { '6': { class_type: 'CLIPTextEncode', inputs: { text: '' } }, '9': { class_type: 'SaveImage', inputs: { images: ['6', 0] } } },
        bindings: { prompt: { nodeId: '6', input: 'text' } }, outputNodeIds: ['9'], pollIntervalMs: 500, pollTimeoutMs: 5000,
      } },
    };
    await useCustomProvidersStore.getState().replaceAll([cfg]);
    const id = await submitComfyChannelJob(cfg, 'workflow', { model: 'workflow', prompt: 'test', size: 'auto', aspect_ratio: 'auto' });
    await recoverComfyChannelJob(id);
    const result = getComfyChannelJob(id);
    expect(submits).toBe(1);
    expect(downloads).toEqual(['first.png', 'second.png']);
    expect(result.status).toBe('succeeded');
    console.log('comfy batch probe', JSON.stringify({ submits, downloads, publicResults: result.results, result: result.result }));
    expect(result.results ?? (result.result ? [{ source: result.result }] : [])).toHaveLength(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
