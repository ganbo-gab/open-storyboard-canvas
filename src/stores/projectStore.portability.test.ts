import { describe, expect, it } from 'vitest';
import type { CanvasNode } from './canvasStore';
import {
  decodeProject,
  encodeProject,
  type Project,
} from './projectStore';
import { applyCanvasHistoryEntry, createCanvasHistoryEntry } from './canvasHistory';

describe('project persistence media codec', () => {
  it('round-trips image/video/audio and nested Director Studio refs without pooling retry blobs', () => {
    const nodes = [{
      id: 'media-node',
      type: 'videoNode',
      position: { x: 0, y: 0 },
      data: {
        imageUrl: 'data:image/png;base64,aW1hZ2U=',
        localVideoUrl: '/tmp/video.mp4',
        localAudioUrl: '/tmp/audio.wav',
        generationRetryResultUrl: 'data:video/mp4;base64,bm90LXJldHJ5LW1ldGFkYXRh',
        directorStudioProjects: [{
          id: 'director-project',
          coverUrl: 'data:image/png;base64,Y292ZXI=',
          snapshot: {
            snapshotUrl: 'data:image/png;base64,c25hcHNob3Q=',
            snapshotHistory: ['data:image/png;base64,aGlzdG9yeQ=='],
            backgroundPanoramaUrl: '/tmp/panorama.jpg',
            items: [{ id: 'item', refImageUrl: '/tmp/item.png' }],
            referenceImages: [{ id: 'reference', url: '/tmp/reference.png' }],
          },
        }],
      },
    }] as unknown as CanvasNode[];
    const project: Project = {
      id: 'project',
      name: 'Media',
      createdAt: 1,
      updatedAt: 2,
      nodeCount: 1,
      nodes,
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      history: { past: [createCanvasHistoryEntry({ nodes: [], edges: [] }, { nodes, edges: [] })!], future: [] },
    };

    const encoded = encodeProject(project);
    expect(encoded.imagePool).toEqual(expect.arrayContaining([
      'data:image/png;base64,aW1hZ2U=',
      '/tmp/video.mp4',
      '/tmp/audio.wav',
      '/tmp/panorama.jpg',
      '/tmp/reference.png',
    ]));
    expect(encoded.imagePool).not.toContain('data:video/mp4;base64,bm90LXJldHJ5LW1ldGFkYXRh');
    expect(JSON.stringify(encoded.nodes)).not.toContain('bm90LXJldHJ5LW1ldGFkYXRh');

    const decoded = decodeProject(encoded);
    expect(decoded.nodes[0].data).toMatchObject({
      imageUrl: 'data:image/png;base64,aW1hZ2U=',
      localVideoUrl: '/tmp/video.mp4',
      localAudioUrl: '/tmp/audio.wav',
      generationRetryResultUrl: null,
    });
    expect(JSON.stringify(decoded.nodes)).toContain('/tmp/panorama.jpg');
    expect(JSON.stringify(decoded.nodes)).toContain('/tmp/reference.png');
    expect(JSON.stringify(decoded.history)).toContain('/tmp/video.mp4');
  });

  it('replaces a dead blob: image or preview with the surviving copy, keeping blob-only nodes for recovery', () => {
    const node = (id: string, data: Record<string, unknown>) => ({ id, type: 'exportImageNode', position: { x: 0, y: 0 }, data });
    const nodes = [
      node('preview-dead', { imageUrl: 'data:image/png;base64,aW1hZ2U=', previewImageUrl: 'blob:http://app/dead-preview' }),
      node('image-dead', { imageUrl: 'blob:http://app/dead-image', previewImageUrl: 'data:image/png;base64,cHJldmlldw==' }),
      node('blob-only', { imageUrl: 'blob:http://app/dead-image-2', previewImageUrl: 'blob:http://app/dead-preview-2' }),
      node('remote', { imageUrl: 'https://cdn.example/a.png', previewImageUrl: 'https://cdn.example/a-small.png' }),
    ] as unknown as CanvasNode[];
    const decoded = decodeProject(encodeProject({
      id: 'p', name: 'p', createdAt: 1, updatedAt: 1, nodeCount: 4, nodes, edges: [],
      viewport: { x: 0, y: 0, zoom: 1 }, history: { past: [], future: [] },
    }));
    expect(decoded.nodes.map((item) => [item.data.imageUrl, item.data.previewImageUrl])).toEqual([
      ['data:image/png;base64,aW1hZ2U=', 'data:image/png;base64,aW1hZ2U='],
      ['data:image/png;base64,cHJldmlldw==', 'data:image/png;base64,cHJldmlldw=='],
      ['blob:http://app/dead-image-2', 'blob:http://app/dead-preview-2'],
      ['https://cdn.example/a.png', 'https://cdn.example/a-small.png'],
    ]);
  });

  it('round-trips retired text Agent associations without exposing them in new UI', () => {
    const nodes = [
      {
        id: 'legacy-text-node',
        type: 'aiTextNode',
        position: { x: 0, y: 0 },
        data: {
          prompt: 'Preserved user prompt',
          model: 'custom:chat:model-a',
          agentId: 'legacy-agent-a',
          resultNodeId: 'legacy-result-node',
        },
      },
      {
        id: 'legacy-result-node',
        type: 'jsonCardNode',
        position: { x: 400, y: 0 },
        data: {
          rawContent: '{"shot":1}',
          parsedJson: { shot: 1 },
          displayFields: [{ path: '$.shot', label: 'Shot', value: '1' }],
          sourceAiNodeId: 'legacy-text-node',
          sourceAgentId: 'legacy-agent-a',
        },
      },
    ] as unknown as CanvasNode[];
    const project: Project = {
      id: 'legacy-agent-project',
      name: 'Legacy text Agent',
      createdAt: 1,
      updatedAt: 2,
      nodeCount: nodes.length,
      nodes,
      edges: [{ id: 'legacy-edge', source: 'legacy-text-node', target: 'legacy-result-node' }],
      viewport: { x: 0, y: 0, zoom: 1 },
      history: { past: [createCanvasHistoryEntry({ nodes: [], edges: [] }, { nodes, edges: [] })!], future: [] },
    };

    const decoded = decodeProject(encodeProject(project));
    expect(decoded.nodes[0].data).toMatchObject({
      agentId: 'legacy-agent-a',
      prompt: 'Preserved user prompt',
      resultNodeId: 'legacy-result-node',
    });
    expect(decoded.nodes[1].data).toMatchObject({
      sourceAgentId: 'legacy-agent-a',
      rawContent: '{"shot":1}',
      parsedJson: { shot: 1 },
    });
    const restored = applyCanvasHistoryEntry({ nodes: [], edges: [] }, decoded.history.past[0], 'redo');
    expect(restored.nodes[0].data.agentId).toBe('legacy-agent-a');
  });
});
