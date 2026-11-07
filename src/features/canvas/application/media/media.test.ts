import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { getCanvasHistoryAgentTurn, withCanvasHistoryAgentTurn } from '@/stores/canvasHistory';
import { useProjectStore } from '@/stores/projectStore';
import { CANVAS_NODE_TYPES, type CanvasNode } from '../../domain/canvasNodes';
import { createNodeMediaEditor, getMediaEditCapability, MediaEditError, type MediaEditPlatform } from './index';
import { audioBufferToWav, getAudioSplitSegments, type PcmAudio } from './audio';
import { getTransformedImageDimensions } from './image';
import { validateMediaEditOperation, validateMediaTimeRange, type MediaEditOperation, type ProcessedMedia } from './types';

function pcm(length = 8000, sampleRate = 8000): PcmAudio {
  const channels = [Float32Array.from({ length }, (_, frame) => frame % 2 ? 1 : -1), new Float32Array(length).fill(0.5)];
  return { length, sampleRate, numberOfChannels: 2, getChannelData: (channel) => channels[channel] };
}
function sourceNode(type: CanvasNode['type'] = CANVAS_NODE_TYPES.video): CanvasNode {
  return { id: 'source', type, position: { x: 20, y: 40 }, width: 320, height: 240, selected: true,
    data: { imageUrl: 'data:image/png;base64,AQ==', localVideoUrl: 'data:video/webm;base64,AQ==', audioUrl: 'data:audio/wav;base64,AQ==', aspectRatio: '4:3' } };
}
const separated: ProcessedMedia = { processing: 'stream-copy', outputs: [
  { kind: 'video', blob: new Blob(['video'], { type: 'video/webm' }), width: 320, height: 240, durationSeconds: 2 },
  { kind: 'audio', blob: new Blob(['audio'], { type: 'audio/webm' }), durationSeconds: 2 },
] };
function platform(process: MediaEditPlatform['process'] = async () => separated): MediaEditPlatform {
  return { process, persist: async (output) => `asset-media:${encodeURIComponent(output.blob.type)}:${'a'.repeat(64)}` };
}

describe('media edit validation', () => {
  it.each<MediaEditOperation>([
    { kind: 'video.trim', startSeconds: -1, endSeconds: 1 },
    { kind: 'video.trim', startSeconds: 1, endSeconds: 1 },
    { kind: 'audio.slice', startSeconds: 2, endSeconds: 1 },
    { kind: 'audio.slice', startSeconds: 0, endSeconds: NaN },
    { kind: 'video.captureFrame', timeSeconds: Infinity },
    { kind: 'video.captureFrame', timeSeconds: -0.1 },
    { kind: 'video.crop', rect: { x: 0.5, y: 0, width: 0.6, height: 1 } },
    { kind: 'video.crop', rect: { x: 0, y: 0, width: 0, height: 1 } },
    { kind: 'audio.split', atSeconds: [1, 1] },
    { kind: 'audio.split', atSeconds: [2, 1] },
    { kind: 'audio.split', atSeconds: [] },
    { kind: 'audio.split', atSeconds: [NaN] },
    { kind: 'audio.rate', rate: 0.49 },
    { kind: 'audio.rate', rate: 2.01 },
  ])('rejects invalid operation %# before processing', (operation) => {
    expect(() => validateMediaEditOperation(operation)).toThrow(MediaEditError);
  });
  it('rejects a range beyond the actual decoded duration', () => {
    expect(() => validateMediaTimeRange(0, 3, 2)).toThrow(MediaEditError);
    expect(() => validateMediaTimeRange(0.5, 2, 2)).not.toThrow();
  });
  it('reports missing WebCodecs instead of claiming capture/crop support', async () => {
    vi.stubGlobal('VideoDecoder', undefined);
    vi.stubGlobal('VideoEncoder', undefined);
    expect(await getMediaEditCapability('video.captureFrame')).toEqual({ supported: false, reason: 'no-webcodecs' });
    expect(await getMediaEditCapability('video.crop')).toEqual({ supported: false, reason: 'no-webcodecs' });
  });
  it('rejects bytes that are not a readable container', async () => {
    expect(await getMediaEditCapability('video.separateAudio', 'data:video/webm;base64,AQID')).toMatchObject({ supported: false, reason: 'unsupported-container' });
  });
});

describe('PCM edits', () => {
  it('encodes an interleaved PCM16 WAV with correct header and duration', async () => {
    const data = await audioBufferToWav(pcm(), 2000, 6000).arrayBuffer();
    const view = new DataView(data);
    const text = (start: number, length: number) => new TextDecoder().decode(new Uint8Array(data, start, length));
    expect(text(0, 4)).toBe('RIFF'); expect(text(8, 4)).toBe('WAVE'); expect(text(36, 4)).toBe('data');
    expect(view.getUint32(4, true)).toBe(data.byteLength - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true) / view.getUint32(28, true)).toBe(0.5);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(46, true)).toBe(16383);
    expect(view.getInt16(48, true)).toBe(32767);
  });
  it('splits into ordered, sample-contiguous, non-overlapping segments', async () => {
    const buffer = pcm(1000, 1000);
    const segments = getAudioSplitSegments(buffer, [0.1234, 0.6]);
    expect(segments).toEqual([{ startFrame: 0, endFrame: 123 }, { startFrame: 123, endFrame: 600 }, { startFrame: 600, endFrame: 1000 }]);
    const sizes = await Promise.all(segments.map(async ({ startFrame, endFrame }) => (await audioBufferToWav(buffer, startFrame, endFrame).arrayBuffer()).byteLength - 44));
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(4000);
  });
  it.each([[1], [0.5, 0.50001], [-1], [0]])('rejects empty or out-of-range quantized segments %j', (...values) => {
    expect(() => getAudioSplitSegments(pcm(), values)).toThrow(MediaEditError);
  });
  it.each([90, 270] as const)('swaps image dimensions for rotation %i', (rotate) => {
    expect(getTransformedImageDimensions(640, 360, rotate)).toEqual({ width: 360, height: 640 });
  });
  it.each([0, 180] as const)('preserves image dimensions for rotation %i', (rotate) => {
    expect(getTransformedImageDimensions(640, 360, rotate)).toEqual({ width: 640, height: 360 });
  });
});

describe('derived canvas media edits', () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([sourceNode()], []);
    useProjectStore.setState({ currentProjectId: null, currentProject: null });
    vi.spyOn(useProjectStore.getState(), 'saveCurrentProject').mockImplementation(() => undefined);
  });
  it('adds both durable outputs, provenance edges and selection in one undoable transaction', async () => {
    const historyBefore = useCanvasStore.getState().history.past.length;
    const revisionBefore = useCanvasStore.getState().revision;
    const run = createNodeMediaEditor(platform());
    const result = await run('source', { kind: 'video.separateAudio' });
    expect(result.processing).toBe('stream-copy');
    expect(result.nodeIds).toHaveLength(2);
    const state = useCanvasStore.getState();
    expect(state.revision).toBe(revisionBefore + 1);
    expect(state.history.past).toHaveLength(historyBefore + 1);
    expect(state.nodes.filter((node) => node.selected).map((node) => node.id)).toEqual(result.nodeIds);
    expect(state.selectedNodeId).toBeNull();
    expect(state.edges.map(({ source, target }) => ({ source, target }))).toEqual(result.nodeIds.map((target) => ({ source: 'source', target })));
    for (const node of state.nodes.slice(1)) expect(node.position.x).toBeGreaterThan(340);
    expect(state.nodes[1].data.localVideoUrl).toMatch(/^asset-media:/);
    expect(state.nodes[2].data.localAudioUrl).toMatch(/^asset-media:/);
    expect(useProjectStore.getState().saveCurrentProject).toHaveBeenCalledWith(state.nodes, state.edges, state.currentViewport, state.history);
    state.undo();
    expect(useCanvasStore.getState().nodes.map((node) => node.id)).toEqual(['source']);
    expect(useCanvasStore.getState().edges).toEqual([]);
    useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().nodes.map((node) => node.id)).toEqual(['source', ...result.nodeIds]);
  });
  it('retains the originating Agent turn across processing without tagging unrelated asynchronous edits', async () => {
    const owner = JSON.stringify(['project', 'media-turn']);
    const injected = platform(async () => {
      await Promise.resolve();
      expect(getCanvasHistoryAgentTurn()).toBeUndefined();
      useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 20, y: 500 }, { text: 'manual edit' });
      return separated;
    });
    const pending = withCanvasHistoryAgentTurn(owner, () => createNodeMediaEditor(injected)('source', { kind: 'video.separateAudio' }));
    expect(getCanvasHistoryAgentTurn()).toBeUndefined();
    const result = await pending;
    expect(getCanvasHistoryAgentTurn()).toBeUndefined();
    const entries = useCanvasStore.getState().history.past;
    expect(entries.slice(-2).map((entry) => entry.agentTurnId)).toEqual([undefined, owner]);
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes.some((node) => node.type === CANVAS_NODE_TYPES.textAnnotation)).toBe(true);
    expect(useCanvasStore.getState().nodes.some((node) => result.nodeIds.includes(node.id))).toBe(false);
  });
  it('does not process an already aborted edit', async () => {
    const controller = new AbortController(); controller.abort();
    const process = vi.fn<MediaEditPlatform['process']>(async () => separated);
    await expect(createNodeMediaEditor(platform(process))('source', { kind: 'video.separateAudio' }, { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(process).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });
  it('creates no nodes or history entries when canceled during processing', async () => {
    const controller = new AbortController();
    const historyBefore = useCanvasStore.getState().history.past.length;
    const injected = platform(async () => { controller.abort(); return separated; });
    const persist = vi.spyOn(injected, 'persist');
    await expect(createNodeMediaEditor(injected)('source', { kind: 'video.separateAudio' }, { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(persist).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(useCanvasStore.getState().edges).toHaveLength(0);
    expect(useCanvasStore.getState().history.past).toHaveLength(historyBefore);
  });
  it('creates nothing if persistence fails, even after another output was persisted', async () => {
    const injected = platform();
    let calls = 0;
    injected.persist = async () => { if (++calls === 2) throw new Error('disk unavailable'); return 'asset-media:video%2Fwebm:' + 'a'.repeat(64); };
    await expect(createNodeMediaEditor(injected)('source', { kind: 'video.separateAudio' })).rejects.toMatchObject({ code: 'persistence-failed' });
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(useCanvasStore.getState().edges).toEqual([]);
  });
  it('does not apply a completed edit to a different project', async () => {
    const injected = platform(async () => { useProjectStore.setState({ currentProjectId: 'other' }); return separated; });
    await expect(createNodeMediaEditor(injected)('source', { kind: 'video.separateAudio' })).rejects.toMatchObject({ code: 'stale-source' });
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });
  it('retains unrelated concurrent canvas changes', async () => {
    const injected = platform(async () => { useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 20, y: 500 }, { text: 'new' }); return separated; });
    await createNodeMediaEditor(injected)('source', { kind: 'video.separateAudio' });
    expect(useCanvasStore.getState().nodes).toHaveLength(4);
    expect(useCanvasStore.getState().nodes.some((node) => node.type === CANVAS_NODE_TYPES.textAnnotation)).toBe(true);
  });
  it('rejects a mismatched source kind before invoking codecs', async () => {
    const process = vi.fn<MediaEditPlatform['process']>(async () => separated);
    await expect(createNodeMediaEditor(platform(process))('source', { kind: 'audio.split', atSeconds: [1] })).rejects.toMatchObject({ code: 'wrong-node-kind' });
    expect(process).not.toHaveBeenCalled();
  });
  it('persists transformed dimensions as the derived image aspect ratio', async () => {
    useCanvasStore.getState().setCanvasData([sourceNode(CANVAS_NODE_TYPES.upload)], []);
    const injected = platform(async () => ({ processing: 'image-transform', outputs: [{ kind: 'image', blob: new Blob(['png']), width: 360, height: 640 }] }));
    const result = await createNodeMediaEditor(injected)('source', { kind: 'image.transform', rotate: 90 });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === result.nodeIds[0])?.data.aspectRatio).toBe('360:640');
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
