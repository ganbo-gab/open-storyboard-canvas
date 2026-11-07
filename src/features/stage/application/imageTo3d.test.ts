import 'fake-indexeddb/auto';
import { createServer, type Server } from 'node:http';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
import type * as AssetCatalog from '@/features/assets/application/assetCatalog';
import type { BlueprintNodeData } from '@/features/canvas/domain/canvasNodes';
import type { WorkbenchTransport } from '@/features/workbench/application/workbenchTransport';

// Fresh imports intentionally exercise module-local execution/cache loss across simulated reloads.

vi.mock('@/commands/projectState', () => ({ getProjectRecord: vi.fn(), upsertProjectRecord: vi.fn(async () => undefined), listProjectSummaries: vi.fn(async () => []) }));

function fixtureGlb(): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 1]);
  const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: positions.byteLength }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 2, 1] }] });
  const encoded = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const bytes = new ArrayBuffer(28 + encoded.byteLength + positions.byteLength); const view = new DataView(bytes);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, encoded.byteLength, true); view.setUint32(16, 0x4e4f534a, true); new Uint8Array(bytes, 20, encoded.length).set(encoded);
  view.setUint32(20 + encoded.length, positions.byteLength, true); view.setUint32(24 + encoded.length, 0x004e4942, true);
  new Uint8Array(bytes, 28 + encoded.length).set(new Uint8Array(positions.buffer)); return bytes;
}
function declaration(baseUrl: string): ChannelProfileV2 {
  return { version: 2, id: 'image-to-model', name: 'User configured model channel', baseUrl, auth: { type: 'none' }, operations: {}, models: [
    { id: 'user-specified-model', operations: [], params: [], modes: [{ id: 'image-to-3d', label: 'Image to model', operation: 'model.generate',
      slots: [{ key: 'images', label: 'Images', kind: 'image', min: 1, max: 3 }], params: [{ key: 'texture', label: 'Texture', type: 'boolean' }], endpoint: {
        method: 'POST', path: '/submit', body: 'json', imageEncoding: 'url', template: { model: '{{model}}', mode: '{{mode}}', images: '{{slot.images}}', texture: '{{param.texture}}' },
        response: { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/poll/{{taskId}}', intervalSec: 0.01, timeoutMin: 1,
          statusPath: 'status', success: ['done'], failure: ['failed'], outputs: [{ path: 'model', as: 'url', kind: 'model' }] } },
      } }] },
  ] };
}
let server: Server; let baseUrl: string; let ready: boolean; let invalid: boolean; let expired: boolean; let synchronous: boolean; let refuseSuccess: boolean;
let submitted: unknown[]; let polls: number; let downloads: number;
const storageValues = new Map<string, string>();
const storage: Storage = { getItem: (key) => storageValues.get(key) ?? null, setItem: (key, value) => {
  if (refuseSuccess && key === 'channel-generation-jobs-v2' && Object.values(JSON.parse(value) as Record<string, { status: string }>).some((job) => job.status === 'succeeded')) {
    refuseSuccess = false; throw new Error('Simulated interrupted job checkpoint');
  }
  storageValues.set(key, value); },
  removeItem: (key) => { storageValues.delete(key); }, clear: () => storageValues.clear(), key: (index) => [...storageValues.keys()][index] ?? null,
  get length() { return storageValues.size; } };
beforeEach(async () => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('localStorage', storage); storage.clear();
  ready = true; invalid = false; expired = false; synchronous = false; refuseSuccess = false; submitted = []; polls = 0; downloads = 0;
  const listening = Promise.withResolvers<void>();
  server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/submit') {
      const body: Buffer[] = []; request.on('data', (chunk: Buffer) => body.push(chunk)); request.on('end', () => {
        submitted.push(JSON.parse(Buffer.concat(body).toString())); response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(synchronous ? { model: `${baseUrl}/model`, preview: `${baseUrl}/preview` } : { id: 'accepted-once' }));
      }); return;
    }
    if (request.url === '/poll/accepted-once') { polls += 1; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(ready ? { status: 'done', model: `${baseUrl}/model` } : { status: 'pending' })); return; }
    if (request.url === '/model') { downloads += 1; response.statusCode = expired ? 403 : 200; response.setHeader('content-type', 'model/gltf-binary'); response.end(invalid ? Buffer.from('not glTF') : Buffer.from(fixtureGlb())); return; }
    if (request.url === '/preview') { response.setHeader('content-type', 'image/png'); response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64')); return; }
    response.statusCode = 404; response.end();
  });
  server.listen(0, '127.0.0.1', listening.resolve); await listening.promise;
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const { createChannel } = await import('@/features/channels/application/channelService'); await createChannel(declaration(baseUrl));
  const { saveAsset } = await import('@/features/assets/application/assetCatalog');
  await saveAsset({ id: 'reference', kind: 'image', source: 'https://references.example/scene.png', name: 'Reference', origin: 'uploaded', metadata: {} });
});
afterEach(async () => {
  server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise;
  const { importedModelParseCache } = await import('./importedModelLoader'); importedModelParseCache.clear(); vi.unstubAllGlobals();
});
const input = () => ({ channelModelRef: { profileId: 'image-to-model', modelId: 'user-specified-model' }, modeId: 'image-to-3d', imageRefs: ['reference'], params: { texture: true } });

describe('declaration-driven image to 3D pipeline', () => {
  it('submits, polls, downloads real fixture geometry and imports once into the durable model library', async () => {
    const { generateModelFromImage, recoverModelFromImage } = await import('./imageTo3d');
    const { getImportedModel, listImportedModels } = await import('./importedModelLibrary');
    const { getChannelJobAsync } = await import('@/features/channels/runtime/channelExecution');
    const phases: string[] = [];
    const result = await generateModelFromImage(input(), { onProgress: (progress) => phases.push(progress.phase) });
    expect(submitted).toEqual([{ model: 'user-specified-model', mode: 'image-to-3d', images: ['https://references.example/scene.png'], texture: true }]);
    expect(polls).toBe(1); expect(downloads).toBe(1); expect(new Set(phases)).toEqual(new Set(['submit', 'poll', 'download', 'import']));
    expect(await getImportedModel(result.importedModelId)).toMatchObject({ bounds: { x: 2, y: 2, z: 1 }, storage: { kind: 'asset-media' } });
    expect(await getChannelJobAsync(result.jobId)).toMatchObject({ status: 'succeeded', media_type: 'model', results: [{ kind: 'model', source: result.importedModelId, importedModelId: result.importedModelId }] });
    expect(await recoverModelFromImage(result.jobId)).toEqual(result); expect(downloads).toBe(1); expect(await listImportedModels()).toHaveLength(1);
    expect(storageValues.get('channel-generation-jobs-v2')).not.toContain('references.example');
  });
  it('supports synchronous model output with a separately persisted preview asset', async () => {
    synchronous = true; const profile = declaration(baseUrl);
    profile.models[0].modes![0].endpoint!.response = { mode: 'sync', outputs: [{ path: 'preview', as: 'url', kind: 'image' }, { path: 'model', as: 'url' }] };
    const { updateChannel } = await import('@/features/channels/application/channelService'); updateChannel(profile.id, profile);
    const { generateModelFromImage } = await import('./imageTo3d'); const result = await generateModelFromImage(input());
    expect(result.previewAssetId).toBe(`model-preview:${result.jobId}`); expect(polls).toBe(0); expect(downloads).toBe(1);
    const { readWorkspaceRecord } = await import('@/features/assets/application/assetMediaStorage');
    const record = await readWorkspaceRecord<{ data: { saved: Record<string, { kind: string; source: string }> } }>('documents', 'storyboard-copilot:asset-catalog:v1');
    expect(record?.data.saved[result.previewAssetId!]).toMatchObject({ kind: 'image', source: expect.stringMatching(/^asset-media:/) });
    const { getChannelJobAsync } = await import('@/features/channels/runtime/channelExecution');
    expect((await getChannelJobAsync(result.jobId)).result).toBe(result.importedModelId);
    vi.resetModules(); const reloaded = await import('@/features/channels/runtime/channelExecution');
    expect(await reloaded.getChannelJobAsync(result.jobId)).toMatchObject({ result: result.importedModelId, results: [{ kind: 'image' }, { kind: 'model', importedModelId: result.importedModelId }] });
  });
  it('does not mark a preview-only upstream response as successful model generation', async () => {
    synchronous = true; const profile = declaration(baseUrl);
    profile.models[0].modes![0].endpoint!.response = { mode: 'sync', outputs: [{ path: 'missing_model', as: 'url', kind: 'model' }, { path: 'preview', as: 'url', kind: 'image' }] };
    const { updateChannel } = await import('@/features/channels/application/channelService'); updateChannel(profile.id, profile);
    const { generateModelFromImage } = await import('./imageTo3d');
    const error = await generateModelFromImage(input()).catch((value: unknown) => value); expect(error).toMatchObject({ code: 'invalid_model' });
    const { listImportedModels } = await import('./importedModelLibrary'); expect(await listImportedModels()).toEqual([]);
  });
  it('reuses a committed model when reload happens between model-library and job-result checkpoints', async () => {
    refuseSuccess = true; const { generateModelFromImage } = await import('./imageTo3d');
    const error = await generateModelFromImage(input()).catch((value: unknown) => value);
    if (!(error instanceof Error) || !('jobId' in error) || typeof error.jobId !== 'string') throw error;
    const { listImportedModels } = await import('./importedModelLibrary'); const first = await listImportedModels(); expect(first).toHaveLength(1);
    vi.resetModules(); const { recoverModelFromImage } = await import('./imageTo3d'); const result = await recoverModelFromImage(error.jobId);
    expect(result.importedModelId).toBe(first[0].id); expect(downloads).toBe(1); expect(submitted).toHaveLength(1);
  });
  it('persists typed model results in workbench and adopts them as model-backed stage items without media fallbacks', async () => {
    const { generateModelFromImage } = await import('./imageTo3d'); const generated = await generateModelFromImage(input());
    const result = { kind: 'model' as const, source: generated.importedModelId, importedModelId: generated.importedModelId };
    const { createWorkbenchStore } = await import('@/features/workbench/store/workbenchStore');
    const { createWorkbenchDocument } = await import('@/features/workbench/application/workbenchPersistence');
    const transport: WorkbenchTransport = { submit: vi.fn(async () => ({ results: [result] })), poll: vi.fn(), recover: vi.fn() };
    const saveResult = vi.fn<typeof AssetCatalog.saveAsset>();
    const store = createWorkbenchStore({ document: createWorkbenchDocument('test:model-results'), transport, saveResult });
    const taskId = await store.getState().submit({ kind: 'image', model: 'explicit-test-model', prompt: 'Generated prop' });
    expect(store.getState().tasks[taskId]).toMatchObject({ status: 'succeeded', results: [result] }); expect(saveResult).not.toHaveBeenCalled();
    const restored = createWorkbenchStore({ document: createWorkbenchDocument('test:model-results'), transport, saveResult });
    await restored.getState().initialize(); expect(restored.getState().tasks[taskId].results).toEqual([result]);
    const { getProjectRecord, upsertProjectRecord } = await import('@/commands/projectState');
    vi.mocked(getProjectRecord).mockResolvedValue({ id: 'model-target', name: 'Target', createdAt: 1, updatedAt: 2, nodeCount: 0,
      nodesJson: '[]', imagePoolJson: '[]', edgesJson: '[]', viewportJson: '{\"x\":0,\"y\":0,\"zoom\":1}', historyJson: '{\"past\":[],\"future\":[]}' });
    const { useProjectStore } = await import('@/stores/projectStore'); useProjectStore.setState({ currentProjectId: 'other', currentProject: null });
    const adoptedId = await store.getState().importResult(taskId, 'model-target');
    const saved = vi.mocked(upsertProjectRecord).mock.calls.at(-1)![0]; const nodes = JSON.parse(saved.nodesJson) as { id: string; type: string; data: BlueprintNodeData }[];
    expect(nodes.find((node) => node.id === adoptedId)).toMatchObject({ type: 'blueprintNode', data: { items: [{ importedModelId: generated.importedModelId }] } });
    expect(saved.imagePoolJson).toBe('[]');
    const { useCanvasStore } = await import('@/stores/canvasStore');
    const { CANVAS_NODE_TYPES } = await import('@/features/canvas/domain/canvasNodes');
    const { publishGenerationJobResults } = await import('@/features/canvas/application/generation/publishJobResults');
    useCanvasStore.getState().setCanvasData([], []);
    const anchorId = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.exportImage, { x: 0, y: 0 }, { generationJobId: generated.jobId });
    const job = { job_id: generated.jobId, status: 'succeeded' as const, results: [result] };
    const ids = publishGenerationJobResults(anchorId, job); expect(ids).toEqual([anchorId]);
    const stage = useCanvasStore.getState().nodes.find((node) => node.id === anchorId)!.data as BlueprintNodeData;
    expect(stage.items[0].importedModelId).toBe(generated.importedModelId);
    useCanvasStore.getState().updateNodeData(anchorId, { items: [{ ...stage.items[0], x: 9 }] });
    publishGenerationJobResults(anchorId, job);
    expect((useCanvasStore.getState().nodes.find((node) => node.id === anchorId)!.data as BlueprintNodeData).items[0].x).toBe(9);
    useCanvasStore.getState().setCanvasData([], []);
  });
  it('rejects malformed declaration output kinds, missing model outputs and invalid slots before submission', async () => {
    const { channelProfileSchema } = await import('@/features/channels/domain/profile');
    const profile = declaration(baseUrl); expect(channelProfileSchema.safeParse(profile).success).toBe(true);
    const raw = JSON.parse(JSON.stringify(profile)); raw.models[0].modes[0].endpoint.response.poll.outputs[0].kind = 'mesh';
    expect(channelProfileSchema.safeParse(raw).success).toBe(false);
    raw.models[0].modes[0].endpoint.response.poll.outputs[0].kind = 'image'; expect(channelProfileSchema.safeParse(raw).success).toBe(false);
    const { generateModelFromImage } = await import('./imageTo3d');
    await expect(generateModelFromImage({ ...input(), imageRefs: [{ assetId: 'reference', slot: 'undeclared' }] })).rejects.toThrow('槽位'); expect(submitted).toEqual([]);
  });
  it('rejects bad magic without importing and recovers only the original result download after an expired URL', async () => {
    invalid = true; const { generateModelFromImage, recoverModelFromImage } = await import('./imageTo3d');
    const error = await generateModelFromImage(input()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'invalid_model', jobId: expect.any(String) });
    const { listImportedModels } = await import('./importedModelLibrary'); expect(await listImportedModels()).toEqual([]);
    if (!(error instanceof Error) || !('jobId' in error) || typeof error.jobId !== 'string') throw error;
    invalid = false; expired = true;
    await expect(recoverModelFromImage(error.jobId)).rejects.toMatchObject({ code: 'network' });
    expired = false; const result = await recoverModelFromImage(error.jobId);
    expect(result.importedModelId).toBeTruthy(); expect(submitted).toHaveLength(1); expect(polls).toBe(1); expect(downloads).toBe(3);
  });
  it('cancels pending polling, restores after module reload, and never resubmits accepted work', async () => {
    ready = false; const controller = new AbortController();
    const { generateModelFromImage } = await import('./imageTo3d');
    const error = await generateModelFromImage(input(), { signal: controller.signal, onProgress: ({ phase }) => { if (phase === 'poll') controller.abort(); } }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'canceled', jobId: expect.any(String) });
    if (!(error instanceof Error) || !('jobId' in error) || typeof error.jobId !== 'string') throw error;
    const runtime = await import('@/features/channels/runtime/channelExecution'); await runtime.waitForChannelJob(error.jobId);
    ready = true; vi.resetModules();
    const { recoverModelFromImage } = await import('./imageTo3d'); const result = await recoverModelFromImage(error.jobId);
    expect(result.jobId).toBe(error.jobId); expect(submitted).toHaveLength(1); expect(downloads).toBe(1);
    expect(await recoverModelFromImage(error.jobId)).toEqual(result); expect(downloads).toBe(1);
  });
  it('blocks an already canceled request without issuing a paid submit', async () => {
    const { generateModelFromImage } = await import('./imageTo3d'); const controller = new AbortController(); controller.abort();
    await expect(generateModelFromImage(input(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(submitted).toEqual([]);
  });
  it('enforces 100 MiB declared and streaming caps, cancels readers, and sniffs embedded-only GLTF', async () => {
    const { readModelDownload, sniffGeneratedModel } = await import('./imageTo3dMaterialization');
    const { MAX_IMPORTED_MODEL_BYTES } = await import('../domain/importedModel');
    const declaredCancel = vi.fn();
    await expect(readModelDownload(new Response(new ReadableStream({ cancel: declaredCancel }), { headers: { 'content-length': String(MAX_IMPORTED_MODEL_BYTES + 1) } }))).rejects.toMatchObject({ code: 'too_large' });
    expect(declaredCancel).toHaveBeenCalledOnce();
    let count = 0; const streamingCancel = vi.fn(); const chunk = new Uint8Array(1024 * 1024);
    await expect(readModelDownload(new Response(new ReadableStream({ pull(controller) { count += 1; controller.enqueue(chunk); }, cancel: streamingCancel })))).rejects.toMatchObject({ code: 'too_large' });
    expect(count).toBeLessThanOrEqual(102); expect(streamingCancel).toHaveBeenCalledOnce();
    const embedded = new TextEncoder().encode('{"asset":{"version":"2.0"},"buffers":[{"uri":"data:application/octet-stream;base64,AAAA"}]}').buffer;
    expect(sniffGeneratedModel(embedded, 'model/gltf+json')).toBe('gltf');
    const external = new TextEncoder().encode('{"asset":{"version":"2.0"},"buffers":[{"uri":"mesh.bin"}]}').buffer;
    expect(() => sniffGeneratedModel(external, 'application/json')).toThrow('外部');
    expect(() => sniffGeneratedModel(fixtureGlb(), 'text/html')).toThrow('GLB / GLTF');
  });
  it('cancels a hanging browser model download reader immediately', async () => {
    const { readModelDownload } = await import('./imageTo3dMaterialization'); const controller = new AbortController(); const canceled = vi.fn();
    const reading = readModelDownload(new Response(new ReadableStream({ cancel: canceled })), controller.signal);
    controller.abort(); await expect(reading).rejects.toMatchObject({ name: 'AbortError' }); expect(canceled).toHaveBeenCalledOnce();
  });
});
