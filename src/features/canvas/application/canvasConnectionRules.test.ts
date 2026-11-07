import { describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode, type CanvasNodeType } from '../domain/canvasNodes';
import { getNodeDefinition } from '../domain/nodeRegistry';
import { explainConnection, validateCanvasConnection } from './canvasConnectionRules';

function node(id: string, type: CanvasNodeType): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data: getNodeDefinition(type).createDefaultData() };
}

function edge(source: string, target: string): CanvasEdge {
  return { id: `${source}-${target}`, source, target };
}

const image = node('image', CANVAS_NODE_TYPES.upload);
const imageGenerator = node('image-generator', CANVAS_NODE_TYPES.imageEdit);
const audio = node('audio', CANVAS_NODE_TYPES.audio);
const tag = node('tag', CANVAS_NODE_TYPES.tag);

describe('connection rejection explanations', () => {
  it.each([CANVAS_NODE_TYPES.upload, CANVAS_NODE_TYPES.exportImage, CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.audio])('only lets material/result %s nodes be upstream', (type) => {
    const material = node('material', type);
    expect(validateCanvasConnection(imageGenerator.id, material.id, [imageGenerator, material], []).valid).toBe(false);
    expect(explainConnection(imageGenerator, material)).toEqual({ ok: false, reason: { type: 'targetIsMaterial' } });
    expect(explainConnection(material, node('video-generator', CANVAS_NODE_TYPES.aiVideo))).toEqual({ ok: true });
  });

  it('links internal generation results without enabling manual connections into material cards', () => {
    const result = node('result', CANVAS_NODE_TYPES.exportImage);
    useCanvasStore.setState({ nodes: [imageGenerator, result], edges: [], revision: 0, history: { past: [], future: [] }, dragHistorySnapshot: null });
    expect(useCanvasStore.getState().addEdge(imageGenerator.id, result.id)).toBeNull();
    expect(useCanvasStore.getState().addEdge(imageGenerator.id, result.id, { provenance: 'generationResult' })).toBeTruthy();
    expect(useCanvasStore.getState().edges).toContainEqual(expect.objectContaining({ source: imageGenerator.id, target: result.id }));
    expect(explainConnection(imageGenerator, result)).toEqual({ ok: false, reason: { type: 'targetIsMaterial' } });
  });

  it('reports the accepted and actual kinds instead of silently connecting incompatible media', () => {
    expect(validateCanvasConnection(audio.id, imageGenerator.id, [audio, imageGenerator], []).valid).toBe(false);
    expect(explainConnection(audio, imageGenerator)).toEqual({ ok: false, reason: { type: 'kindMismatch', expected: ['image', 'text'], actual: 'audio' } });
    expect(explainConnection(image, node('audio-generator', CANVAS_NODE_TYPES.aiAudio))).toEqual({ ok: false, reason: { type: 'kindMismatch', expected: ['text', 'audio'], actual: 'image' } });
    expect(explainConnection(image, imageGenerator)).toEqual({ ok: true });
  });

  it('rejects cycles in ordinary generation graphs as well as tag graphs', () => {
    const second = node('second', CANVAS_NODE_TYPES.imageEdit);
    expect(validateCanvasConnection(second.id, imageGenerator.id, [second, imageGenerator], [edge(imageGenerator.id, second.id)]).valid).toBe(false);
    expect(explainConnection(second, imageGenerator, { edges: [edge(imageGenerator.id, second.id)] })).toEqual({ ok: false, reason: { type: 'cycle' } });
    expect(explainConnection(tag, imageGenerator, { edges: [edge(imageGenerator.id, tag.id)] })).toEqual({ ok: false, reason: { type: 'cycle' } });
  });

  it('rejects an already connected pair during a drag with the existing edge identity', () => {
    expect(explainConnection(image, imageGenerator, { edges: [edge(image.id, imageGenerator.id)] })).toEqual({ ok: false, reason: { type: 'duplicate', existingEdgeId: 'image-image-generator' } });
  });

  it('identifies each missing endpoint, self-connection, and unsupported endpoint', () => {
    expect(explainConnection(undefined, imageGenerator)).toEqual({ ok: false, reason: { type: 'missingNode', endpoint: 'source' } });
    expect(explainConnection(image, undefined)).toEqual({ ok: false, reason: { type: 'missingNode', endpoint: 'target' } });
    expect(explainConnection(imageGenerator, imageGenerator)).toEqual({ ok: false, reason: { type: 'selfConnection' } });
    expect(explainConnection(node('group', CANVAS_NODE_TYPES.group), imageGenerator)).toEqual({ ok: false, reason: { type: 'sourceNotConnectable' } });
    expect(explainConnection(image, node('group', CANVAS_NODE_TYPES.group))).toEqual({ ok: false, reason: { type: 'targetNotConnectable' } });
  });

  it('reports a wrong input or output handle explicitly', () => {
    expect(explainConnection(image, imageGenerator, { sourceHandle: 'target' })).toEqual({ ok: false, reason: { type: 'invalidHandle', endpoint: 'source', handleId: 'target' } });
    expect(explainConnection(image, imageGenerator, { targetHandle: 'source' })).toEqual({ ok: false, reason: { type: 'invalidHandle', endpoint: 'target', handleId: 'source' } });
  });

  it('keeps tag-specific source cardinality and tag-group target explanations', () => {
    expect(explainConnection(image, tag, { edges: [edge('other', tag.id)] })).toEqual({ ok: false, reason: { type: 'tagSourceConflict', existingEdgeId: 'other-tag' } });
    expect(explainConnection(node('tag-group', CANVAS_NODE_TYPES.tagGroup), tag)).toEqual({ ok: false, reason: { type: 'tagGroupTarget' } });
  });

  it('checks the actual material kind through tags and group members', () => {
    expect(explainConnection(tag, imageGenerator, { nodes: [tag, audio, imageGenerator], edges: [edge(audio.id, tag.id)] })).toEqual({ ok: false, reason: { type: 'kindMismatch', expected: ['image', 'text'], actual: 'audio' } });
    const group = node('tag-group', CANVAS_NODE_TYPES.tagGroup);
    group.data.memberNodeIds = [audio.id];
    expect(explainConnection(group, imageGenerator, { nodes: [group, audio, imageGenerator] })).toEqual({ ok: false, reason: { type: 'kindMismatch', expected: ['image', 'text'], actual: 'audio' } });
  });
});
