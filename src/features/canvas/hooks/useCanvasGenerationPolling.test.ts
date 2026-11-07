// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CanvasServicesModule from '../application/canvasServices';
import type * as ImageDataModule from '../application/imageData';
import type * as ImageCommands from '@/commands/image';
const mocks = vi.hoisted(() => ({ image: vi.fn(), video: vi.fn(), prepare: vi.fn(), embed: vi.fn(), rename: vi.fn(), persistVideo: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../application/canvasServices', async (original) => {
  const actual = await original<typeof CanvasServicesModule>();
  return { ...actual, canvasAiGateway: { ...actual.canvasAiGateway, getGenerateImageJob: mocks.image },
    canvasVideoGateway: { ...actual.canvasVideoGateway, getGenerateVideoJob: mocks.video },
    materializeProviderAwareImageResult: async (_provider: string, source: string) => source };
});
vi.mock('../application/imageData', async (original) => ({ ...await original<typeof ImageDataModule>(), prepareNodeImage: mocks.prepare }));
vi.mock('@/commands/image', async (original) => ({ ...await original<typeof ImageCommands>(),
  embedStoryboardImageMetadata: mocks.embed, renameLocalMediaFiles: mocks.rename, persistVideoSource: mocks.persistVideo }));
import { useCanvasGenerationPolling } from './useCanvasGenerationPolling';
import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { withCanvasHistoryAgentTurn } from '@/stores/canvasHistory';
import { rollbackAgentTurn } from '@/features/canvas/agent/application/agentCanvasRollback';

beforeEach(() => {
  vi.resetAllMocks();
  useCanvasStore.setState({ nodes: [], edges: [], history: { past: [], future: [] } });
  mocks.prepare.mockImplementation(async (source: string) => ({ imageUrl: source, previewImageUrl: source, aspectRatio: '16:9' }));
  mocks.embed.mockResolvedValue('/local/embedded.png');
  mocks.rename.mockResolvedValue({ primaryPath: '/local/renamed.png', fileName: 'renamed.png' });
  mocks.persistVideo.mockImplementation(async (source: string) => source);
});
afterEach(cleanup);
const keys: Record<string, string> = {};
function startPolling() {
  return renderHook(() => {
    const nodes = useCanvasStore((state) => state.nodes);
    useCanvasGenerationPolling(nodes, keys);
  });
}
describe('typed channel result polling', () => {
  it('keeps provider metadata and final preparation in the originating Agent turn for complete withdrawal', async () => {
    const previousProjectId = useProjectStore.getState().currentProjectId;
    useProjectStore.setState({ currentProjectId: 'poll-owned-project' });
    try {
      const sourceId = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }, { prompt: 'Original prompt' });
      const graph = () => ({ nodes: useCanvasStore.getState().nodes.map(({ selected: _selected, ...node }) => node), edges: useCanvasStore.getState().edges });
      const before = graph();
      const depth = useCanvasStore.getState().history.past.length;
      const owner = JSON.stringify(['poll-owned-project', 'poll-owned-run']);
      let resultId = '';
      withCanvasHistoryAgentTurn(owner, () => {
        const state = useCanvasStore.getState();
        state.updateNodeData(sourceId, { prompt: 'Agent prompt' });
        resultId = state.addNode(CANVAS_NODE_TYPES.exportImage, { x: 500, y: 0 }, {
          imageUrl: null, aspectRatio: '1:1', isGenerating: true, generationJobId: 'owned-job',
          generationStartedAt: Date.now(), generationAgentTurnId: owner,
        });
        state.addEdge(sourceId, resultId);
      });
      mocks.image.mockResolvedValue({ job_id: 'owned-job', status: 'succeeded', phase: 'done', updated_at: 42,
        network_route: 'direct', results: [{ kind: 'image', source: '/local/provider.png' }] });
      startPolling();
      await waitFor(() => expect(useCanvasStore.getState().nodes.find((node) => node.id === resultId)?.data.generatedFileName).toBe('renamed.png'));
      expect(rollbackAgentTurn({ projectId: 'poll-owned-project', runId: 'poll-owned-run' })).toMatchObject({ ok: true });
      expect(graph()).toEqual(before);
      expect(useCanvasStore.getState().history.past).toHaveLength(depth);
    } finally { useProjectStore.setState({ currentProjectId: previousProjectId }); }
  });
  it('publishes extra outputs without bypassing primary storyboard metadata and naming', async () => {
    useCanvasStore.setState({ nodes: [{ id: 'result', type: CANVAS_NODE_TYPES.exportImage, position: { x: 0, y: 0 }, data: {
      imageUrl: null, aspectRatio: '1:1', isGenerating: true, generationJobId: 'job',
      generationStoryboardMetadata: { gridRows: 1, gridCols: 2, frameNotes: ['one', 'two'] },
    } } as CanvasNode] });
    mocks.image.mockResolvedValue({ job_id: 'job', status: 'succeeded', result: '/local/primary.png', results: [
      { kind: 'image', source: '/local/primary.png' }, { kind: 'image', source: '/local/extra.png' },
    ] });
    startPolling();
    await waitFor(() => expect(useCanvasStore.getState().nodes.find((node) => node.id === 'result')?.data.imageUrl).toBe('/local/renamed.png'));
    expect(mocks.embed).toHaveBeenCalledWith('/local/primary.png', { gridRows: 1, gridCols: 2, frameNotes: ['one', 'two'] });
    expect(useCanvasStore.getState().nodes).toHaveLength(2);
    expect(useCanvasStore.getState().nodes[1].data).toMatchObject({ imageUrl: '/local/extra.png', batchIndex: 1, generationLastJobId: 'job' });
  });
  it('preserves primary video preparation while exposing its tail frame as an image node', async () => {
    useCanvasStore.setState({ nodes: [{ id: 'result', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 }, data: {
      videoUrl: null, aspectRatio: '16:9', isGenerating: true, generationJobId: 'job',
    } } as CanvasNode] });
    mocks.video.mockResolvedValue({ job_id: 'job', status: 'succeeded', result: '/local/video.mp4', results: [
      { kind: 'video', source: '/local/video.mp4' }, { kind: 'image', source: '/local/tail.png' },
    ] });
    mocks.rename.mockResolvedValue({ primaryPath: '/local/renamed.mp4', fileName: 'renamed.mp4' });
    startPolling();
    await waitFor(() => expect(useCanvasStore.getState().nodes[0].data.localVideoUrl).toBe('/local/renamed.mp4'));
    expect(useCanvasStore.getState().nodes[1]).toMatchObject({ type: CANVAS_NODE_TYPES.exportImage, data: { imageUrl: '/local/tail.png', generationLastJobId: 'job' } });
  });
});
