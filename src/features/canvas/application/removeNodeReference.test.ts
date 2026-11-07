import { beforeEach, describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '../domain/canvasNodes';
import { CANVAS_NODE_TYPES } from '../domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { collectInputReferences } from './graphReferenceResolver';
import { planNodeReferenceRemoval } from './removeNodeReference';

function image(id: string, url = `/${id}.png`): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.upload, position: { x: 0, y: 0 }, data: { imageUrl: url, aspectRatio: '1:1', previewImageUrl: null } };
}
function target(id = 'target', prompt = ''): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.imageEdit, position: { x: 600, y: 0 }, data: { prompt, model: 'gpt-image-2', size: '2K', imageUrl: null, aspectRatio: '1:1', previewImageUrl: null } };
}
function group(id: string, members: string[]): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.tagGroup, position: { x: 300, y: 0 }, data: { displayName: id, label: id, schemaVersion: 2, memberNodeIds: members, enabled: true, color: 'neutral', shape: 'rounded' } };
}
function tag(id: string): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.tag, position: { x: 300, y: 0 }, data: { label: id, displayName: id, enabled: true, color: 'cyan' } };
}
function link(source: string, target = 'target', id = `${source}-${target}`): CanvasEdge { return { id, source, target }; }
function remove(nodes: CanvasNode[], edges: CanvasEdge[], index: number, prompt = '') {
  const reference = collectInputReferences('target', nodes, edges)[index];
  const plan = planNodeReferenceRemoval({ nodeId: 'target', reference, nodes, edges, prompt });
  if (!plan) throw new Error('Expected a removable reference');
  return plan;
}
beforeEach(() => useCanvasStore.setState({ nodes: [], edges: [], revision: 0, selectedNodeId: null, history: { past: [], future: [] }, dragHistorySnapshot: null }));

describe('consumer-side reference removal', () => {
  it('disconnects only the selected consumer, preserves source nodes and remaps draft mentions once', () => {
    const nodes = [image('one'), image('two'), image('three'), target(), target('other')];
    const edges = [link('one'), link('two'), link('three'), link('one', 'other')];
    const plan = remove(nodes, edges, 0, 'Unsaved words @图1 then @图2 and @图3.');
    expect(plan.edges).toEqual(edges.slice(1));
    expect(plan.nodes.slice(0, 3)).toEqual(nodes.slice(0, 3));
    expect(plan.nodes[4]).toBe(nodes[4]);
    expect(plan.prompt).toBe('Unsaved words  then @图1 and @图2.');
    expect(plan.removed.map(reference => reference.sourceNodeId)).toEqual(['one']);
  });

  it('distinguishes @图1, @图10 and unknown larger numbers without cascading replacements', () => {
    const images = Array.from({ length: 12 }, (_, index) => image(`image-${index + 1}`));
    const plan = remove([...images, target()], images.map(node => link(node.id)), 0, '@图1 @图2 @图10 @图11 @图12 @图100 @@图2 ＠图10 @图10的颜色');
    expect(plan.prompt).toBe(' @图1 @图9 @图10 @图11 @图100 @图1 @图9 @图9的颜色');
  });

  it('cleans only slot URLs no longer connected while retaining unrelated assignments and aliases', () => {
    const consumer = target();
    consumer.data.referenceSlots = { first: ['/shared.png'], last: ['/two.png'], extra: ['/independent.png'] };
    const nodes = [image('one', '/shared.png'), image('two'), tag('alias'), consumer];
    const edges = [link('one'), link('one', 'alias'), link('alias'), link('two')];
    const plan = remove(nodes, edges, 0);
    expect(plan.nodes.find(node => node.id === 'target')?.data.referenceSlots).toEqual(consumer.data.referenceSlots);
    const next = remove(plan.nodes, plan.edges, 1);
    expect(next.nodes.find(node => node.id === 'target')?.data.referenceSlots).toEqual({ first: ['/shared.png'], last: [], extra: ['/independent.png'] });
  });

  it('disconnects a tag at the consumer boundary without damaging the shared source chain', () => {
    const nodes = [image('one'), tag('inner'), tag('outer'), target(), target('other')];
    const edges = [link('one', 'inner'), link('inner', 'outer'), link('outer'), link('outer', 'other')];
    const plan = remove(nodes, edges, 0, 'Use @outer for a closeup');
    expect(plan.edgeIds).toEqual(['outer-target']);
    expect(plan.edges).toEqual([edges[0], edges[1], edges[3]]);
    expect(plan.prompt).toBe('Use  for a closeup');
    expect(collectInputReferences('other', plan.nodes, plan.edges)).toHaveLength(1);
  });

  it('reports all media on an indivisible tag-group edge and updates legacy group tokens', () => {
    const video: CanvasNode = { id: 'video', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 }, data: { videoUrl: '/clip.mp4', thumbnailUrl: null, aspectRatio: '16:9' } };
    const text: CanvasNode = { id: 'text', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content: 'Notes', fontSize: 16, color: '#000', backgroundColor: '#fff', textAlign: 'left' } };
    const nodes = [image('one'), image('two'), video, text, group('Scene', ['one', 'video', 'text']), target(), target('other')];
    const edges = [link('Scene'), link('two'), link('Scene', 'other')];
    const plan = remove(nodes, edges, 0, 'Use @Scene, @图1 @图2 @视频1 @文本1');
    expect(plan.removed.map(reference => reference.kind)).toEqual(['image', 'video', 'text']);
    expect(plan.edgeIds).toEqual(['Scene-target']);
    expect(plan.prompt).toBe('Use ,  @图1  ');
    expect(plan.nodes.find(node => node.id === 'Scene')).toBe(nodes[4]);
    expect(collectInputReferences('other', plan.nodes, plan.edges)).toHaveLength(3);
  });

  it('treats all frames from the same connected source as one edge and preserves frame identity', () => {
    const frames: CanvasNode = { id: 'frames', type: CANVAS_NODE_TYPES.storyboardSplit, position: { x: 0, y: 0 }, data: { frames: [
      { id: 'frame-a', imageUrl: '/a.png', previewImageUrl: null, note: 'A', order: 0 }, { id: 'frame-b', imageUrl: '/b.png', previewImageUrl: null, note: 'B', order: 1 },
    ], aspectRatio: '2:1', gridRows: 1, gridCols: 2, frameAspectRatio: '1:1' } };
    const nodes = [frames, image('three'), target()];
    const edges = [link('frames'), link('three')];
    const plan = remove(nodes, edges, 1, 'Keep @图3, remove @图1 and @图2');
    expect(plan.removed.map(reference => reference.sourceItemId)).toEqual(['frame-a', 'frame-b']);
    expect(plan.prompt).toBe('Keep @图1, remove  and ');
    expect(plan.edges).toEqual([edges[1]]);
  });

  it('removes duplicate paths supplying a deduplicated reference while leaving others', () => {
    const nodes = [image('one'), image('two'), group('Both', ['one', 'two']), target()];
    const edges = [link('one'), link('Both')];
    const plan = remove(nodes, edges, 0, '@图1 @图2');
    expect(plan.edgeIds).toEqual(['one-target', 'Both-target']);
    expect(plan.removed).toHaveLength(2);
    expect(plan.edges).toEqual([]);
  });

  it('does not guess when a custom tag token collides with a numbered reference', () => {
    const nodes = [image('one'), image('two'), tag('图1'), target()];
    const edges = [link('one'), link('two', '图1'), link('图1')];
    expect(remove(nodes, edges, 0, '@图1').prompt).toBe('');
  });

  it('commits edges, slots and complete draft text as a single undoable graph edit', () => {
    const consumer = target('target', 'Stored @图2');
    consumer.data.referenceSlots = { images: ['/one.png', '/two.png'] };
    const nodes = [image('one'), image('two'), consumer];
    const edges = [link('one'), link('two')];
    useCanvasStore.setState({ nodes, edges });
    const graph = useCanvasStore.getState();
    const plan = remove(graph.nodes, graph.edges, 0, 'New unsaved draft @图2');
    expect(graph.commitGraphTransaction({ expectedRevision: graph.revision, nodes: plan.nodes, edges: plan.edges, selectedNodeId: null })).not.toBeNull();
    useCanvasStore.getState().updateNodeData('target', { prompt: plan.prompt });
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(useCanvasStore.getState().nodes.find(node => node.id === 'target')?.data).toMatchObject({ prompt: 'New unsaved draft @图1', referenceSlots: { images: ['/two.png'] } });
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().edges).toEqual(edges);
    expect(useCanvasStore.getState().nodes.find(node => node.id === 'target')?.data).toMatchObject(consumer.data);
    expect(useCanvasStore.getState().redo()).toBe(true);
    expect(useCanvasStore.getState().nodes.find(node => node.id === 'target')?.data.prompt).toBe('New unsaved draft @图1');
  });

  it('treats missing targets or stale references as no-ops', () => {
    const reference = { kind: 'image' as const, sourceNodeId: 'missing' };
    expect(planNodeReferenceRemoval({ nodeId: 'target', reference, nodes: [target()], edges: [], prompt: 'draft' })).toBeNull();
    expect(planNodeReferenceRemoval({ nodeId: 'missing', reference, nodes: [], edges: [], prompt: 'draft' })).toBeNull();
  });

  it.each([CANVAS_NODE_TYPES.imageEdit, CANVAS_NODE_TYPES.aiVideo, CANVAS_NODE_TYPES.aiAudio, CANVAS_NODE_TYPES.aiText])('supports the root prompt composer for %s, including a legacy missing prompt', type => {
    const consumer: CanvasNode = { ...target(), type };
    delete consumer.data.prompt;
    const plan = remove([image('one'), image('two'), consumer], [link('one'), link('two')], 0, 'Current draft @图2');
    expect(plan.nodes.find(node => node.id === 'target')?.data.prompt).toBe('Current draft @图1');
  });

  it('updates all storyboard shot references in one transaction and writes the current draft only to its explicit shot', () => {
    const storyboard: CanvasNode = { id: 'target', type: CANVAS_NODE_TYPES.storyboardGen, position: { x: 600, y: 0 }, data: {
      gridRows: 1, gridCols: 3, model: 'gpt-image-2', size: '2K', requestAspectRatio: '1:1', imageUrl: null, aspectRatio: '3:1',
      frames: [{ id: 'shot-a', description: 'Wide @图1 and @图2' }, { id: 'shot-b', description: 'Stored active @图1' }, { id: 'shot-c', description: 'Close @图2', referenceIndex: 1 }],
      referenceSlots: { images: ['/one.png', '/two.png'] },
    } };
    const nodes = [image('one'), image('two'), storyboard];
    const edges = [link('one'), link('two')];
    const reference = collectInputReferences('target', nodes, edges)[0];
    const plan = planNodeReferenceRemoval({ nodeId: 'target', nodes, edges, reference,
      prompt: 'Uncommitted active @图2', promptTarget: { kind: 'storyboardFrame', frameId: 'shot-b' } });
    expect(plan).not.toBeNull();
    if (!plan) return;
    const updated = plan.nodes[2];
    expect(updated.data.frames).toEqual([{ id: 'shot-a', description: 'Wide  and @图1' }, { id: 'shot-b', description: 'Uncommitted active @图1' }, { id: 'shot-c', description: 'Close @图1', referenceIndex: 1 }]);
    expect(updated.data).not.toHaveProperty('prompt');
    expect(updated.data.referenceSlots).toEqual({ images: ['/two.png'] });
    useCanvasStore.setState({ nodes, edges });
    const graph = useCanvasStore.getState();
    graph.commitGraphTransaction({ expectedRevision: graph.revision, nodes: plan.nodes, edges: plan.edges, selectedNodeId: null });
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes[2].data).toEqual(storyboard.data);
    expect(useCanvasStore.getState().edges).toEqual(edges);
    expect(planNodeReferenceRemoval({ nodeId: 'target', nodes, edges, reference, prompt: 'Stale draft', promptTarget: { kind: 'storyboardFrame', frameId: 'deleted-shot' } })).toBeNull();
    expect(planNodeReferenceRemoval({ nodeId: 'target', nodes, edges, reference, prompt: 'Wrong root' })).toBeNull();
  });
});
