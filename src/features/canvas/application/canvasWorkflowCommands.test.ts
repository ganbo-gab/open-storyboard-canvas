import { beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_COMMAND_VERSION } from '../domain/canvasCommands';
import { CANVAS_NODE_TYPES } from '../domain/canvasNodes';
import { canvasCommandRegistry } from './canvasCommandService';
import { canvasEventBus } from './canvasServices';

function resetCanvas(): void {
  useCanvasStore.setState({
    nodes: [],
    edges: [],
    revision: 0,
    selectedNodeId: null,
    activeDirectorStudioNodeId: null,
    activeToolDialog: null,
    history: { past: [], future: [] },
    dragHistorySnapshot: null,
  });
}

describe('specialized Canvas workflow commands', () => {
  beforeEach(resetCanvas);

  it('creates and configures a panorama through one typed transaction boundary', () => {
    const create = canvasCommandRegistry.executeTransaction({
      id: 'panorama-create-configure',
      origin: 'agent',
      expectedRevision: 0,
      commands: [
        {
          type: 'node.create',
          version: CANVAS_COMMAND_VERSION,
          input: {
            nodeType: CANVAS_NODE_TYPES.panorama,
            nodeId: 'panorama-1',
            position: { x: 20, y: 30 },
          },
        },
        {
          type: 'panorama.update',
          version: CANVAS_COMMAND_VERSION,
          input: {
            nodeId: 'panorama-1',
            sourceMode: 'text',
            sourcePrompt: 'A continuous night market environment',
            projection: 'spherical',
            smartBase: true,
            initialFov: 60,
          },
        },
      ],
    });

    expect(create).toMatchObject({ ok: true, revisionBefore: 0, revisionAfter: 1 });
    expect(useCanvasStore.getState().nodes[0]).toMatchObject({
      id: 'panorama-1',
      data: {
        sourcePrompt: 'A continuous night market environment',
        projection: 'spherical',
        smartBase: true,
        initialFov: 60,
      },
    });
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
  });

  it('updates Director Studio only from stable asset references', async () => {
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {
      imageUrl: 'data:image/png;base64,AAAA',
      previewImageUrl: null,
      aspectRatio: '1:1',
      displayName: 'Character reference',
    });
    const sourceNode = useCanvasStore.getState().nodes[0];
    const create = await canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeType: CANVAS_NODE_TYPES.blueprint,
        nodeId: 'director-1',
        position: { x: 400, y: 0 },
      },
    });
    expect(create.ok).toBe(true);

    const update = await canvasCommandRegistry.execute({
      type: 'director.update',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeId: 'director-1',
        mode: 'flat',
        referenceAssetIds: [`${sourceNode.id}:image`],
        items: [{
          id: 'person-1',
          label: 'Lead',
          x: 0,
          y: 0,
          color: '#ffffff',
          category: 'person',
          referenceAssetId: `${sourceNode.id}:image`,
        }],
      },
    });
    expect(update).toMatchObject({ ok: true, commandType: 'director.update' });
    const director = useCanvasStore.getState().nodes.find((node) => node.id === 'director-1');
    expect(director?.data).toMatchObject({
      referenceImages: [{ id: `${sourceNode.id}:image`, label: 'Character reference' }],
      items: [{ id: 'person-1', refImageName: 'Character reference' }],
    });

    const rejected = await canvasCommandRegistry.execute({
      type: 'director.update',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeId: 'director-1', backgroundAssetId: 'missing:asset' },
    });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'invalid_command', message: expect.stringContaining('missing:asset') },
    });
  });

  it('keeps the whole Director scene update atomic when a later field is invalid', () => {
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.blueprint, { x: 0, y: 0 });
    const directorId = useCanvasStore.getState().nodes[0].id;
    const revision = useCanvasStore.getState().revision;
    const original = useCanvasStore.getState().nodes[0].data;

    const result = canvasCommandRegistry.executeTransaction({
      id: 'invalid-director-update',
      origin: 'agent',
      expectedRevision: revision,
      commands: [{
        type: 'director.update',
        version: CANVAS_COMMAND_VERSION,
        input: {
          nodeId: directorId,
          basePrompt: 'Must not persist',
          referenceAssetIds: ['missing:asset'],
        },
      }],
    });

    expect(result).toMatchObject({ ok: false, revisionAfter: revision });
    expect(useCanvasStore.getState().nodes[0].data).toEqual(original);
  });

  it('keeps a Director recording request alive until the studio reports its result', async () => {
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.blueprint, { x: 0, y: 0 });
    const directorId = useCanvasStore.getState().nodes[0].id;
    const unsubscribe = canvasEventBus.subscribe('director-studio/record', (request) => {
      globalThis.setTimeout(() => {
        canvasEventBus.publish('director-studio/record-result', {
          requestId: request.requestId,
          nodeId: request.nodeId,
          resultNodeId: 'recorded-video-1',
        });
      }, 0);
    });

    try {
      const result = await canvasCommandRegistry.execute({
        type: 'director.record',
        version: CANVAS_COMMAND_VERSION,
        input: {
          nodeId: directorId,
          resolution: '720p',
          fps: 30,
          addToCanvas: true,
        },
      });

      expect(result).toMatchObject({
        ok: true,
        commandType: 'director.record',
        output: {
          references: {
            nodeId: 'recorded-video-1',
            nodeIds: [directorId, 'recorded-video-1'],
          },
          value: { recorded: true, resultNodeId: 'recorded-video-1' },
        },
      });
    } finally {
      unsubscribe();
    }
  });

  it('rejects malformed nested workflow payloads before they reach graph preparation', async () => {
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.storyboardSplit, { x: 0, y: 0 });
    const storyboardId = useCanvasStore.getState().nodes[0].id;
    const storyboard = await canvasCommandRegistry.execute({
      type: 'storyboard.update',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeId: storyboardId, frames: [{ frameId: 'frame-1', order: 'first' }] },
    } as never);
    expect(storyboard).toMatchObject({ ok: false, error: { code: 'invalid_command' } });

    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.blueprint, { x: 400, y: 0 });
    const directorId = useCanvasStore.getState().nodes.find((node) => node.type === CANVAS_NODE_TYPES.blueprint)?.id;
    const director = await canvasCommandRegistry.execute({
      type: 'director.update',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeId: directorId, items: [{ id: 'item-1', label: 'Actor', x: 0, y: 0, color: '#fff', pos3d: { x: 0, y: 0 } }] },
    } as never);
    expect(director).toMatchObject({ ok: false, error: { code: 'invalid_command' } });
  });

  it('rejects non-image assets and paid AI-edit tools from Agent workflows', async () => {
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.panorama, { x: 0, y: 0 });
    const panoramaId = useCanvasStore.getState().nodes[0].id;
    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.video, { x: 400, y: 0 }, { videoUrl: 'https://example.com/clip.mp4' });
    const videoId = useCanvasStore.getState().nodes.find((node) => node.type === CANVAS_NODE_TYPES.video)?.id;

    const panorama = await canvasCommandRegistry.execute({
      type: 'panorama.update',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeId: panoramaId, sourceAssetId: `${videoId}:video` },
    });
    expect(panorama).toMatchObject({ ok: false, error: { code: 'invalid_command' } });

    useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.upload, { x: 800, y: 0 }, { imageUrl: 'data:image/png;base64,AAAA' });
    const imageId = useCanvasStore.getState().nodes.find((node) => node.type === CANVAS_NODE_TYPES.upload)?.id;
    const aiTool = await canvasCommandRegistry.execute({
      type: 'node.tool.run',
      version: CANVAS_COMMAND_VERSION,
      input: { nodeId: imageId, toolType: 'hd' },
    } as never);
    expect(aiTool).toMatchObject({ ok: false, error: { code: 'invalid_command' } });
  });
});
