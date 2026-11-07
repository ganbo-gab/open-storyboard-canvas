import { RunContext } from '@openai/agents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as assetStorage from '@/features/assets/application/assetMediaStorage';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { canvasCommandRegistry } from './canvasCommandService';
import { buildCanvasAssetCatalog } from './canvasAssetCatalog';
import { CANVAS_NODE_TYPES } from '../domain/canvasNodes';
import { canvasAgentApprovalExecution, canvasAgentApprovalStore } from '../agent/application/agentApproval';
import { prepareCanvasAgentToolApproval } from '../agent/application/canvasAgentController';
import { createCanvasSdkTools } from '../agent/infrastructure/canvasSdkTools';
import type { CanvasAgentContext } from '../agent/infrastructure/sdkRuntime';

const projectId = 'media-command-cancellation-project';
const runId = 'media-command-cancellation-run';
const callId = 'media-edit';
const input = { type: 'node.media.edit', input: { nodeId: 'source', operation: { kind: 'image.transform', rotate: 90 } } };

function deferred<T>() {
  // The application typechecks against ES2020, before Promise.withResolvers.
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(() => {
  canvasAgentApprovalStore.deleteRun(runId);
  useProjectStore.setState({ currentProjectId: projectId });
  useCanvasStore.setState({
    nodes: [{ id: 'source', type: CANVAS_NODE_TYPES.upload, position: { x: 0, y: 0 }, selected: true,
      data: { imageUrl: 'data:image/png;base64,AQID', aspectRatio: '2:1' } }],
    edges: [], revision: 0, selectedNodeId: 'source', history: { past: [], future: [] }, dragHistorySnapshot: null,
  });
});

afterEach(() => {
  canvasAgentApprovalStore.deleteRun(runId);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SDK local media command cancellation', () => {
  it.each(
    (['decode', 'encode'] as const).flatMap((phase) => (
      (['context', 'active SDK invocation'] as const).flatMap((signalSource) => (
        [false, true].map((injected) => ({ phase, signalSource, injected }))
      ))
    )),
  )('stops pending $phase using $signalSource cancellation (injected executor: $injected) without late mutations', async ({ phase, signalSource, injected }) => {
    const controller = new AbortController();
    const started = deferred<void>();
    const decoding = deferred<Pick<ImageBitmap, 'width' | 'height' | 'close'>>();
    const encoding = deferred<Blob>();
    const close = vi.fn();
    const bitmap = { width: 2, height: 1, close };
    vi.stubGlobal('createImageBitmap', () => {
      if (phase === 'decode') { started.resolve(); return decoding.promise; }
      return Promise.resolve(bitmap);
    });
    const canvases: Array<{ width: number; height: number }> = [];
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) { canvases.push(this); }
      getContext() { return { translate() {}, scale() {}, rotate() {}, drawImage() {} }; }
      convertToBlob() {
        if (phase === 'encode') { started.resolve(); return encoding.promise; }
        return Promise.resolve(new Blob(['encoded'], { type: 'image/png' }));
      }
    });
    const persistAsset = vi.spyOn(assetStorage, 'persistAssetMedia').mockResolvedValue(`asset-media:${'a'.repeat(64)}.png`);
    const save = vi.spyOn(useProjectStore.getState(), 'saveCurrentProject').mockImplementation(() => undefined);
    const checkpoint = vi.fn(async () => undefined);
    const context: CanvasAgentContext = { projectId, runId,
      signal: signalSource === 'context' ? controller.signal : new AbortController().signal, persistCanvasCheckpoint: checkpoint,
      executeCanvasCommand: injected
        ? (command, expectedRevision, options) => canvasCommandRegistry.executeApproved(command, expectedRevision, 'agent', undefined, options)
        : undefined };
    const tools = createCanvasSdkTools({ context, toolPolicy: { mode: 'minimal', toolKinds: ['canvas'], deferredToolKinds: [], reason: 'Local media behavior regression' } });
    const canvasTool = tools.find((candidate) => candidate.name === 'canvas_command');
    if (!canvasTool) throw new Error('Missing registered canvas SDK tool.');
    const approval = await prepareCanvasAgentToolApproval({ projectId, runId, callId, toolName: 'canvas_command', arguments: input });
    canvasAgentApprovalExecution.decide(approval.record.id, true);
    const before = useCanvasStore.getState();
    const assets = buildCanvasAssetCatalog(before.nodes);
    const pending = canvasTool.invoke(new RunContext(context), JSON.stringify(input), {
      toolCall: { type: 'function_call', name: 'canvas_command', callId, arguments: JSON.stringify(input) },
      signal: signalSource === 'active SDK invocation' ? controller.signal : undefined,
    });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await started.promise;
      controller.abort();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 300, interval: 5 });
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'execution_failed' } });
      expect(useCanvasStore.getState().nodes).toBe(before.nodes);
      expect(useCanvasStore.getState().edges).toBe(before.edges);
      expect(useCanvasStore.getState().history).toBe(before.history);
      expect(useCanvasStore.getState().revision).toBe(before.revision);
      expect(persistAsset).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
    } finally {
      decoding.resolve(bitmap);
      encoding.resolve(new Blob(['late encoded'], { type: 'image/png' }));
      await pending;
    }
    expect(close).toHaveBeenCalledOnce();
    expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
    expect(buildCanvasAssetCatalog(useCanvasStore.getState().nodes)).toEqual(assets);
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().edges).toBe(before.edges);
    expect(useCanvasStore.getState().history).toBe(before.history);
    expect(useCanvasStore.getState().revision).toBe(before.revision);
    expect(persistAsset).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
  });
});
