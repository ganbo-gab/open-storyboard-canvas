// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { createLocalDocument } from '@/features/workbench/application/workbenchPersistence';
import type { WorkbenchTask } from '@/features/workbench/domain/types';
import { useCanvasStore } from '@/stores/canvasStore';
import { filterGenerationHistory, jumpToHistorySource, projectWorkbenchHistory, reuseParams, type GenerationHistoryRecord } from './history';
import { createGenerationHistoryStore, useGenerationHistoryStore, type HistoryData } from './historyStore';
import { captureCanvasGeneration, projectCanvasHistoryStatus } from './canvasHistoryCapture';

const task: WorkbenchTask = { id: 'task', conversationId: 'conversation', createdAt: 100, updatedAt: 200, waitingCanceled: false, status: 'succeeded', jobId: 'job', results: [{ kind: 'video', source: '/result.mp4', assetId: 'asset' }], input: { kind: 'video', model: 'configured-model', prompt: '雨夜追踪镜头', channelModeId: 'first-last', config: { size: '1080p', aspectRatio: '16:9', seconds: 5, extraParams: { seed: 42 } }, referenceSlots: { first_frame: ['/first.png'], last_frame: ['/last.png'] }, references: [{ id: 'first', kind: 'image', source: '/first.png', name: '首帧' }] } };
function canvasRecord(): GenerationHistoryRecord {
  return { id: 'canvas-record', createdAt: 300, surface: 'canvas', projectId: 'project', nodeId: 'source', modelRef: 'image-model', modeId: 'image-mode', prompt: '金色逆光人物', params: { nodeType: CANVAS_NODE_TYPES.imageEdit, nodeData: { imageUrl: null, aspectRatio: '16:9', resolution: '2K', prompt: 'old', modelId: 'image-model', channelModeId: 'image-mode', generationJobId: 'old', isGenerating: true, resultNodeId: 'old-result' } }, references: [{ id: 'ref', kind: 'image', source: '/ref.png' }], status: 'running', outputs: [], jobIds: ['canvas-job'], resultNodeIds: ['result'] };
}
describe('generation history', () => {
  it('applies all surface/model/status/date/project/text filters with inclusive boundaries', () => {
    const workbench = projectWorkbenchHistory(task); const canvas = canvasRecord(); const agent = { ...canvas, id: 'agent-record', surface: 'agent' as const, status: 'failed' as const, createdAt: 400, error: 'quota exhausted' };
    const records = [canvas, workbench, agent];
    expect(filterGenerationHistory(records).map(record => record.id)).toEqual(['agent-record', 'canvas-record', 'workbench:task']);
    expect(filterGenerationHistory(records, { surface: 'canvas', model: 'image-model', status: 'running', projectId: 'project', from: 300, to: 300, text: '逆光' })).toEqual([canvas]);
    expect(filterGenerationHistory(records, { surface: 'agent', text: 'QUOTA' })).toEqual([agent]);
    expect(filterGenerationHistory(records, { from: 301, to: 399 })).toEqual([]);
    expect(filterGenerationHistory(records, { projectId: 'missing' })).toEqual([]);
    expect(filterGenerationHistory(records, { model: 'missing' })).toEqual([]);
  });
  it('keeps submitted project attribution while project filtering follows a changed conversation association', () => {
    const historical = { ...task, input: { ...task.input, projectId: 'at-submit' } };
    const record = projectWorkbenchHistory(historical, false, 'associated-now');
    expect(record).toMatchObject({ projectId: 'at-submit', projectAttribution: 'submission', currentProjectId: 'associated-now' });
    expect(filterGenerationHistory([record], { projectId: 'associated-now' })).toHaveLength(1);
    expect(filterGenerationHistory([record], { projectId: 'at-submit' })).toHaveLength(0);
    const unassigned = projectWorkbenchHistory(historical, false, null);
    expect(unassigned.projectId).toBe('at-submit');
    expect(filterGenerationHistory([unassigned], { projectId: 'at-submit' })).toHaveLength(0);
    expect(projectWorkbenchHistory(task, false, 'associated-now')).toMatchObject({ projectId: 'associated-now', projectAttribution: 'current-conversation' });
    expect(projectWorkbenchHistory(task).projectId).toBeUndefined();
  });
  it('refreshes projected history when only the conversation project association changes', async () => {
    let projectId: string | null = 'first';
    const listeners = new Set<() => void>();
    const document = createLocalDocument<HistoryData>('project-projection', () => ({ events: [] }), (value) => value as HistoryData, { getItem: () => null, setItem: () => {} });
    const store = createGenerationHistoryStore(document, { tasks: () => ({ task }), projectId: () => projectId, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } });
    await store.getState().initialize();
    expect(store.getState().query({ projectId: 'first' })).toHaveLength(1);
    projectId = 'second'; listeners.forEach((listener) => listener());
    expect(store.getState().query({ projectId: 'first' })).toHaveLength(0);
    expect(store.getState().query({ projectId: 'second' })).toHaveLength(1);
    expect(store.getState().events).toEqual([]);
    store.getState().dispose();
  });
  it('round-trips workbench drafts including declared modes, params, slots and references', () => {
    const record = projectWorkbenchHistory(task); const reused = reuseParams(record);
    expect(reused).toEqual({ surface: 'workbench', draft: task.input });
    if (reused.surface === 'workbench') reused.draft.config!.extraParams!.seed = 1;
    expect(record.params.config?.extraParams?.seed).toBe(42);
    expect(jumpToHistorySource(record)).toEqual({ surface: 'workbench', conversationId: 'conversation', taskId: 'task' });
  });
  it('reuses immutable canvas params but never restores running state or old job handles', () => {
    const record = canvasRecord(); const reused = reuseParams(record);
    expect(reused).toMatchObject({ surface: 'canvas', nodeType: CANVAS_NODE_TYPES.imageEdit, data: { prompt: 'old', modelId: 'image-model', channelModeId: 'image-mode', resolution: '2K', isGenerating: false }, references: record.references });
    if (reused.surface !== 'canvas') throw new Error('Expected canvas draft');
    expect(reused.data).not.toHaveProperty('generationJobId'); expect(reused.data).not.toHaveProperty('resultNodeId');
    expect(record.params.nodeData?.generationJobId).toBe('old');
    expect(jumpToHistorySource(record)).toEqual({ surface: 'canvas', projectId: 'project', nodeId: 'source' });
  });
  it('indexes the append-only log, hydrates safely and derives live workbench tasks without duplicating them', async () => {
    const storage = new Map<string, string>();
    const document = createLocalDocument<HistoryData>('history-test', () => ({ events: [] }), value => value as HistoryData,
      { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } });
    let tasks: Record<string, WorkbenchTask> = { task: structuredClone(task) }; const listeners = new Set<() => void>();
    const source = { tasks: () => tasks, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    const store = createGenerationHistoryStore(document, source, async value => value);
    await Promise.all([store.getState().record(canvasRecord()), store.getState().markAgentTask('task')]);
    await store.getState().update({ id: 'canvas-record', status: 'succeeded', outputs: [{ kind: 'image', source: '/out.png' }] });
    expect(document.load().events).toHaveLength(3);
    expect(document.load().events[0]).toMatchObject({ type: 'record', record: { status: 'running', outputs: [] } });
    expect(store.getState().query({ surface: 'agent' })).toHaveLength(1);
    expect(store.getState().query({ surface: 'canvas', status: 'succeeded' })[0].outputs).toEqual([{ kind: 'image', source: '/out.png' }]);
    tasks = { task: { ...tasks.task, status: 'failed', failure: { kind: 'provider', message: '真实失败' } } }; listeners.forEach(listener => listener());
    expect(store.getState().query({ surface: 'agent', status: 'failed' })[0].error).toBe('真实失败');
    const restored = createGenerationHistoryStore(document, source, async value => value); await restored.getState().initialize();
    expect(restored.getState().records).toEqual(store.getState().records);
    store.getState().dispose(); restored.getState().dispose();
  });
  it('projects every mixed-media output for a job while keeping recoverable errors distinct from success', () => {
    const record = canvasRecord();
    const nodes: CanvasNode[] = [
      { id: 'result', type: CANVAS_NODE_TYPES.exportImage, position: { x: 0, y: 0 }, data: { imageUrl: '/image.png', aspectRatio: '1:1', generationLastJobId: 'canvas-job', generationJobState: 'succeeded', isGenerating: false } },
      { id: 'extra-video', type: CANVAS_NODE_TYPES.video, position: { x: 10, y: 0 }, data: { videoUrl: '/video.mp4', aspectRatio: '16:9', generationLastJobId: 'canvas-job', generationJobState: 'succeeded', isGenerating: false } },
      { id: 'extra-text', type: CANVAS_NODE_TYPES.jsonCard, position: { x: 20, y: 0 }, data: { rawContent: '{"shot":1}', parsedJson: null, parseError: null, generationLastJobId: 'canvas-job', generationJobState: 'succeeded', isGenerating: false } },
    ];
    expect(projectCanvasHistoryStatus(record, nodes)).toMatchObject({ status: 'succeeded', outputs: [{ kind: 'image', source: '/image.png' }, { kind: 'video', source: '/video.mp4' }, { kind: 'text', source: '{"shot":1}' }], resultNodeIds: ['result', 'extra-video', 'extra-text'] });
    const waiting = { ...nodes[0], data: { ...nodes[0].data, imageUrl: null, generationJobState: 'recoverable_wait', generationError: 'download unavailable' } } as CanvasNode;
    expect(projectCanvasHistoryStatus(record, [waiting])).toMatchObject({ status: 'recoverable_wait', error: 'download unavailable', outputs: [] });
  });
  it.each(['failed', 'canceled'] as const)('does not rewrite a %s attempt from a reused panorama node and a new job', (status) => {
    const record = { ...canvasRecord(), status, resultNodeIds: ['panorama'], jobIds: ['original-job'] };
    const node: CanvasNode = { id: 'panorama', type: CANVAS_NODE_TYPES.panorama, position: { x: 0, y: 0 }, data: { imageUrl: '/new.png', aspectRatio: '2:1', sourceMode: 'text', sourcePrompt: 'New attempt', generationJobId: 'new-job', generationLastJobId: 'original-job', isGenerating: true, generationJobState: 'running' } };
    expect(projectCanvasHistoryStatus(record, [node])).toBeNull();
    node.data = { ...node.data, generationJobId: null, generationLastJobId: 'new-job', isGenerating: false, generationJobState: 'succeeded' };
    expect(projectCanvasHistoryStatus(record, [node])).toBeNull();
    node.data = { ...node.data, generationLastJobId: 'original-job' };
    expect(projectCanvasHistoryStatus(record, [node])).toMatchObject({ status: 'succeeded', outputs: [{ kind: 'image', source: '/new.png' }] });
  });
  it('does not infer original-task success from a result node that has lost its job identity', () => {
    const record = canvasRecord();
    const node: CanvasNode = { id: 'result', type: CANVAS_NODE_TYPES.exportImage, position: { x: 0, y: 0 }, data: { imageUrl: '/unrelated.png', aspectRatio: '1:1', generationJobState: 'succeeded' } };
    expect(projectCanvasHistoryStatus(record, [node])).toBeNull();
  });
  it('captures immutable submit inputs and retains completed outputs after source edits or deletion', async () => {
    const original = useCanvasStore.getState();
    try {
      const source: CanvasNode = { id: 'capture-source', type: CANVAS_NODE_TYPES.imageEdit, position: { x: 0, y: 0 }, data: { prompt: '原始草稿', modelId: 'configured-model', imageUrl: null, aspectRatio: '16:9', resolution: '2K' } };
      const result: CanvasNode = { id: 'capture-output', type: CANVAS_NODE_TYPES.exportImage, position: { x: 20, y: 0 }, data: { imageUrl: null, aspectRatio: '16:9', isGenerating: true, generationJobId: 'capture-job' } };
      useCanvasStore.setState({ nodes: [source, result], edges: [] });
      const capture = captureCanvasGeneration(source, [source], [], 700, { historySurface: 'agent', count: 2 });
      source.data.prompt = '提交后编辑';
      capture({ context: { sourceType: 'imageEdit', providerId: 'test-provider', requestModel: 'configured-model', prompt: '原始草稿，编译后的摄像机描述' }, resultNodeIds: [result.id], jobIds: ['capture-job'] });
      await expect.poll(() => useGenerationHistoryStore.getState().records.find(record => record.nodeId === source.id)).toBeDefined();
      const record = useGenerationHistoryStore.getState().records.find(item => item.nodeId === source.id)!;
      expect(record).toMatchObject({ surface: 'agent', prompt: '原始草稿，编译后的摄像机描述', upstreamPrompt: '原始草稿，编译后的摄像机描述', params: { nodeData: { prompt: '原始草稿' }, count: 2 } });
      useCanvasStore.getState().updateNodeData(result.id, { imageUrl: '/completed.png', isGenerating: false, generationJobId: null, generationLastJobId: 'capture-job', generationJobState: 'succeeded' });
      await expect.poll(() => useGenerationHistoryStore.getState().records.find(item => item.id === record.id)?.status).toBe('succeeded');
      useCanvasStore.setState({ nodes: [], edges: [] });
      await Promise.resolve();
      expect(useGenerationHistoryStore.getState().records.find(item => item.id === record.id)?.outputs).toEqual([{ kind: 'image', source: '/completed.png' }]);
    } finally { useCanvasStore.setState(original, true); }
  });
  it('records and reuses the actual automatic image mode and effective parameters without changing the source snapshot', async () => {
    const original = useCanvasStore.getState();
    try {
      const source: CanvasNode = { id: 'capture-auto-image-source', type: CANVAS_NODE_TYPES.imageEdit, position: { x: 0, y: 0 },
        data: { prompt: 'Automatic edit', imageUrl: null, aspectRatio: '1:1', modelConfig: { entryId: 'custom:fixture:image', ratio: 'auto', extraParams: { size: '1024x1024', textOnly: 'old' } } } };
      const before = structuredClone(source);
      useCanvasStore.setState({ nodes: [source], edges: [] });
      const capture = captureCanvasGeneration(source, [source], [], 800, {});
      capture({ context: { sourceType: 'imageEdit', providerId: 'fixture', requestModel: 'custom:fixture:image', channelModeId: 'edit',
        prompt: 'Automatic edit', extraParams: { size: '1536x1024', n: 2 } }, resultNodeIds: [], jobIds: ['original-auto-edit-job'] });
      await expect.poll(() => useGenerationHistoryStore.getState().records.find(record => record.nodeId === source.id)).toBeDefined();
      const record = useGenerationHistoryStore.getState().records.find(item => item.nodeId === source.id)!;
      expect(record).toMatchObject({ modeId: 'edit', jobIds: ['original-auto-edit-job'], params: {
        nodeData: { channelModeId: 'edit', modelConfig: { entryId: 'custom:fixture:image', extraParams: { size: '1536x1024', n: 2 } } },
        request: { extraParams: { size: '1536x1024', n: 2 } },
      } });
      expect(record.params.nodeData?.modelConfig).toEqual({ entryId: 'custom:fixture:image', ratio: 'auto', extraParams: { size: '1536x1024', n: 2 } });
      const reused = reuseParams(record);
      expect(reused).toMatchObject({ surface: 'canvas', nodeType: CANVAS_NODE_TYPES.imageEdit, data: { channelModeId: 'edit',
        modelConfig: { entryId: 'custom:fixture:image', extraParams: { size: '1536x1024', n: 2 } } } });
      expect(source).toEqual(before);
      expect(source.data).not.toHaveProperty('channelModeId');
    } finally { useCanvasStore.setState(original, true); }
  });
  it('records the assembled request model despite stale aliases and later source selection changes', async () => {
    const original = useCanvasStore.getState();
    try {
      const source: CanvasNode = { id: 'capture-conflicting-models', type: CANVAS_NODE_TYPES.imageEdit, position: { x: 0, y: 0 }, data: {
        prompt: 'Saved prompt', model: 'kie/legacy-default', modelId: 'stale-model-alias', size: '2K', aspectRatio: '1:1',
        modelConfig: { entryId: 'custom:fixture:selected-at-capture', ratio: 'auto', extraParams: { size: '1024x576' } },
      } };
      const frozen = structuredClone(source.data);
      useCanvasStore.setState({ nodes: [source], edges: [] });
      const capture = captureCanvasGeneration(source, [source], [], 900, {});
      source.data.modelConfig = { entryId: 'custom:fixture:later-selection', ratio: '1:1' };
      capture({ context: { sourceType: 'imageEdit', requestModel: 'custom:fixture:actually-submitted' }, resultNodeIds: [], jobIds: ['captured-original-job'] });
      await expect.poll(() => useGenerationHistoryStore.getState().records.find(item => item.nodeId === source.id)).toBeDefined();
      const saved = useGenerationHistoryStore.getState().records.find(item => item.nodeId === source.id)!;
      expect(saved.modelRef).toBe('custom:fixture:actually-submitted');
      expect(saved.params.nodeData).toEqual(frozen);
      expect(saved.params.request).toMatchObject({ model: 'custom:fixture:actually-submitted' });

      const fallback = { ...source, id: 'capture-configuration-fallback', data: frozen };
      captureCanvasGeneration(fallback, [fallback], [], 901, {})({ context: { sourceType: 'imageEdit' }, resultNodeIds: [], jobIds: [] });
      await expect.poll(() => useGenerationHistoryStore.getState().records.find(item => item.nodeId === fallback.id)?.modelRef).toBe('custom:fixture:selected-at-capture');
      expect(saved.modelRef).toBe('custom:fixture:actually-submitted');
    } finally { useCanvasStore.setState(original, true); }
  });
});
