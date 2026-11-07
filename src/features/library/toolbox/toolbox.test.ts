// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { applyTemplateToCanvas } from './toolboxStore';
import { executionOrder, instantiateTemplate, saveGroupAsTemplate, ToolboxError } from './toolbox';

const originalCanvas = useCanvasStore.getState();
afterEach(() => useCanvasStore.setState(originalCanvas, true));
function graph() {
  const group: CanvasNode = { id: 'group', type: CANVAS_NODE_TYPES.group, position: { x: 100, y: 200 }, style: { width: 500, height: 400 }, data: { label: '镜头组' } };
  const a: CanvasNode = { id: 'a', type: CANVAS_NODE_TYPES.imageEdit, parentId: 'group', position: { x: 20, y: 30 }, data: { prompt: '人物近景', modelId: 'chosen-model', imageUrl: null, aspectRatio: '16:9', resolution: '1K', generationJobId: 'old-job', generationJobState: 'running', isGenerating: true, resultNodeId: 'b', batchId: 'old-batch' } };
  const b: CanvasNode = { id: 'b', type: CANVAS_NODE_TYPES.aiVideo, parentId: 'group', position: { x: 230, y: 30 }, data: { prompt: '人物转身', aspectRatio: '16:9', generationLastJobId: 'older-job', isGenerating: false } };
  const outside: CanvasNode = { id: 'outside', type: CANVAS_NODE_TYPES.upload, position: { x: 0, y: 0 }, data: { imageUrl: '/ref.png', aspectRatio: '1:1' } };
  const edges: CanvasEdge[] = [{ id: 'in', source: 'outside', target: 'a' }, { id: 'internal', source: 'a', target: 'b' }, { id: 'out', source: 'b', target: 'outside' }];
  return { nodes: [outside, b, group, a], edges };
}
describe('toolbox graph templates', () => {
  it('captures only descendants and internal edges, detaches nested root and preserves relative positions', async () => {
    const { nodes, edges } = graph(); const template = await saveGroupAsTemplate('group', nodes, edges, { id: 'fixture', createdAt: 5 });
    expect(template.nodes.map(node => node.id)).toEqual(['group', 'b', 'a']);
    expect(template.edges.map(edge => edge.id)).toEqual(['internal']);
    expect(template.nodes.find(node => node.id === 'group')).toMatchObject({ position: { x: 0, y: 0 } });
    expect(template.nodes.find(node => node.id === 'a')).toMatchObject({ parentId: 'group', position: { x: 20, y: 30 } });
    expect(template.bounds).toEqual({ x: 0, y: 0, width: 500, height: 400 });
    await expect(saveGroupAsTemplate('outside', nodes, edges)).rejects.toMatchObject({ code: 'not-group' });
  });
  it('remaps ids once, preserves internal references, clears job state and never mutates the snapshot', async () => {
    const { nodes, edges } = graph(); const template = await saveGroupAsTemplate('group', nodes, edges);
    const before = structuredClone(template); const calls: string[] = [];
    const result = instantiateTemplate(template, { x: 800, y: 600 }, { createNodeId: node => { calls.push(node.id); return `fresh-${node.id}`; } });
    expect(calls).toHaveLength(3); expect(new Set(calls).size).toBe(3);
    expect([...result.idMap]).toEqual([['group', 'fresh-group'], ['b', 'fresh-b'], ['a', 'fresh-a']]);
    expect(result.nodes.find(node => node.id === 'fresh-group')?.position).toEqual({ x: 800, y: 600 });
    expect(result.nodes.find(node => node.id === 'fresh-a')).toMatchObject({ parentId: 'fresh-group', position: { x: 20, y: 30 }, data: { prompt: '人物近景', modelId: 'chosen-model', isGenerating: false, resultNodeId: 'fresh-b' } });
    expect(result.nodes.find(node => node.id === 'fresh-a')?.data).not.toHaveProperty('generationJobId');
    expect(result.nodes.find(node => node.id === 'fresh-a')?.data).not.toHaveProperty('batchId');
    expect(result.edges).toMatchObject([{ source: 'fresh-a', target: 'fresh-b' }]);
    expect(template).toEqual(before);
    expect(() => instantiateTemplate(template, { x: 0, y: 0 }, { createNodeId: () => 'same-id' })).toThrow(ToolboxError);
  });
  it('persists inline media as stable asset refs instead of copying data URLs into the template', async () => {
    const { nodes, edges } = graph();
    const upload: CanvasNode = { id: 'ref', parentId: 'group', type: CANVAS_NODE_TYPES.upload, position: { x: 1, y: 1 }, data: { imageUrl: 'data:image/png;base64,aGVsbG8=', aspectRatio: '1:1' } };
    const template = await saveGroupAsTemplate('group', [...nodes, upload], edges);
    expect(template.nodes.find(node => node.id === 'ref')?.data.imageUrl).toMatch(/^asset-media:/);
    expect(upload.data.imageUrl).toBe('data:image/png;base64,aGVsbG8=');
  });
  it('orders generators through intermediates and returns a typed cycle failure', () => {
    const { nodes, edges } = graph();
    expect(executionOrder({ nodes: nodes.filter(node => node.id !== 'outside'), edges })).toEqual(['a', 'b']);
    const looping = [...edges, { id: 'back', source: 'b', target: 'a' }];
    try { executionOrder({ nodes, edges: looping }); throw new Error('Expected cycle'); }
    catch (error) { expect(error).toBeInstanceOf(ToolboxError); expect(error).toMatchObject({ code: 'cycle' }); }
  });
  it('applies an instance as one undoable graph transaction', async () => {
    const { nodes, edges } = graph(); const template = await saveGroupAsTemplate('group', nodes, edges);
    useCanvasStore.setState({ nodes: [], edges: [], revision: 0, history: { past: [], future: [] }, selectedNodeId: null });
    const result = applyTemplateToCanvas(template, { x: 40, y: 50 });
    expect(result.nodeIds).toHaveLength(3); expect(useCanvasStore.getState().edges).toHaveLength(1);
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes).toEqual([]); expect(useCanvasStore.getState().edges).toEqual([]);
    useCanvasStore.getState().redo(); expect(useCanvasStore.getState().nodes).toHaveLength(3);
  });
});
