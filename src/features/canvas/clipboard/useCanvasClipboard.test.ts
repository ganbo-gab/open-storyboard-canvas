// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '../domain/canvasNodes';
import { useCanvasClipboard, type DuplicateResult } from './useCanvasClipboard';
import type * as ClipboardIO from './clipboardIO';
import { readClipboardContent, writeTextToClipboard } from './clipboardIO';
import { decodeCanvasClipboard } from './canvasClipboardFormat';
import { useProjectStore } from '@/stores/projectStore';
import { getNodeDefinition } from '../domain/nodeRegistry';

const system = vi.hoisted(() => ({ text: '', files: [] as File[] }));
vi.mock('./clipboardIO', async (importOriginal) => ({
  ...await importOriginal<typeof ClipboardIO>(),
  writeTextToClipboard: vi.fn(async (text: string) => { system.text = text; system.files = []; }),
  readClipboardContent: vi.fn(async () => ({ mediaFiles: system.files, mediaFile: system.files[0] ?? null, imageFile: null, text: system.text })),
}));

function node(id: string, name: string, type = CANVAS_NODE_TYPES.imageEdit as CanvasNode['type']): CanvasNode {
  return { id, type, position: { x: 100, y: 80 }, data: { ...getNodeDefinition(type).createDefaultData(), displayName: name } };
}

function edge(id: string, source: string, target: string): CanvasEdge {
  return { id, source, target, sourceHandle: 'source', targetHandle: 'target', type: 'disconnectableEdge', data: { label: id } };
}

function renderClipboard() {
  return renderHook(() => useCanvasClipboard({
    materialImport: {
      createFromFile: vi.fn(async () => null),
      createFromSource: vi.fn(async () => null),
      handleDragOver: vi.fn(),
      handleDrop: vi.fn(),
    },
    resolvePastePosition: () => ({ x: 800, y: 400 }),
    scheduleCanvasPersist: vi.fn(),
  }));
}

afterEach(cleanup);
beforeEach(() => {
  system.text = ''; system.files = []; vi.clearAllMocks();
  useCanvasStore.setState({ nodes: [], edges: [], revision: 0, selectedNodeId: null, history: { past: [], future: [] }, dragHistorySnapshot: null });
});

describe('canvas duplicate and paste', () => {
  it('duplicates every incoming and outgoing connection while repointing internal edges once', () => {
    const nodes = [node('upstream', 'Reference', CANVAS_NODE_TYPES.upload), node('a', 'Shot A'), node('b', 'Shot B'), node('downstream', 'Final')];
    const edges = [edge('incoming', 'upstream', 'a'), edge('internal', 'a', 'b'), edge('outgoing', 'b', 'downstream')];
    useCanvasStore.setState({ nodes, edges });
    const { result } = renderClipboard();
    const copies: { current: DuplicateResult | null } = { current: null };
    act(() => { copies.current = result.current.duplicateNodes(['a', 'b']); });
    expect(copies.current).not.toBeNull();
    const a = copies.current!.idMap.get('a');
    const b = copies.current!.idMap.get('b');
    const state = useCanvasStore.getState();
    expect(state.edges).toHaveLength(6);
    expect(state.edges.slice(3)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'upstream', target: a, data: { label: 'incoming' } }),
      expect.objectContaining({ source: a, target: b, data: { label: 'internal' } }),
      expect.objectContaining({ source: b, target: 'downstream', data: { label: 'outgoing' } }),
    ]));
    expect(state.nodes.find((item) => item.id === a)?.data.displayName).toBe('Shot A-副本');
    expect(state.history.past).toHaveLength(1);
    act(() => { expect(useCanvasStore.getState().undo()).toBe(true); });
    expect(useCanvasStore.getState().nodes).toEqual(nodes);
    expect(useCanvasStore.getState().edges).toEqual(edges);
  });

  it('names successive duplicates and internal pastes uniquely without inheriting external paste edges', async () => {
    const nodes = [node('upstream', 'Reference', CANVAS_NODE_TYPES.upload), node('a', 'Shot A'), node('b', 'Shot B')];
    useCanvasStore.setState({ nodes, edges: [edge('incoming', 'upstream', 'a'), edge('internal', 'a', 'b')] });
    const { result } = renderClipboard();
    act(() => { result.current.duplicateNodes(['a']); });
    act(() => { result.current.copyNodes(['a', 'b']); });
    await act(async () => { await result.current.pasteAt({ nodeId: null, flowPosition: { x: 1000, y: 600 } }); });
    await act(async () => { await result.current.pasteAt({ nodeId: null, flowPosition: { x: 1400, y: 600 } }); });
    const state = useCanvasStore.getState();
    expect(state.nodes.map((item) => item.data.displayName)).toEqual(expect.arrayContaining(['Shot A-副本', 'Shot A-副本2', 'Shot A-副本3', 'Shot B-副本', 'Shot B-副本2']));
    const pastedA = state.nodes.find((item) => item.data.displayName === 'Shot A-副本2');
    const pastedB = state.nodes.find((item) => item.data.displayName === 'Shot B-副本');
    expect(state.edges.filter((item) => item.target === pastedA?.id)).toEqual([]);
    expect(state.edges).toContainEqual(expect.objectContaining({ source: pastedA?.id, target: pastedB?.id }));
  });

  it('copies grouped children, dimensions, configuration and tag relations without sharing mutable data', () => {
    const group = node('group', 'Sequence', CANVAS_NODE_TYPES.group);
    const child = { ...node('child', 'Frame'), parentId: 'group', extent: 'parent' as const, position: { x: 16, y: 24 }, style: { width: 480, height: 270 }, data: { ...getNodeDefinition(CANVAS_NODE_TYPES.imageEdit).createDefaultData(), displayName: 'Frame', prompt: 'A sunrise', extraParams: { seed: 123 }, isGenerating: true, generationJobId: 'running-job' } };
    const tag = node('tag', 'Reference tag', CANVAS_NODE_TYPES.tag);
    const upstream = node('upstream', 'Image', CANVAS_NODE_TYPES.upload);
    useCanvasStore.setState({ nodes: [group, child, tag, upstream], edges: [edge('to-tag', 'upstream', 'tag'), edge('to-child', 'tag', 'child')] });
    const { result } = renderClipboard();
    act(() => { result.current.duplicateNodes(['group', 'tag']); });
    const state = useCanvasStore.getState();
    const copy = state.nodes.find((item) => item.data.displayName === 'Frame-副本');
    const groupCopy = state.nodes.find((item) => item.data.displayName === 'Sequence-副本');
    const tagCopy = state.nodes.find((item) => item.data.displayName === 'Reference tag-副本');
    expect(copy).toMatchObject({ parentId: groupCopy?.id, position: { x: 16, y: 24 }, style: { width: 480, height: 270 }, data: { prompt: 'A sunrise', extraParams: { seed: 123 }, isGenerating: false, generationJobId: null } });
    expect(copy?.data.extraParams).not.toBe(child.data.extraParams);
    expect(state.edges).toContainEqual(expect.objectContaining({ source: upstream.id, target: tagCopy?.id }));
    expect(state.edges).toContainEqual(expect.objectContaining({ source: tagCopy?.id, target: copy?.id }));
  });
});


describe('one system clipboard for all paste entry points', () => {
  it('preserves a copied paragraph containing a media URL instead of dropping its prose', async () => {
    const view = renderClipboard();
    system.text = 'Keep the red coat\nhttps://example.test/reference.png';
    await act(async () => { await view.result.current.pasteFromShortcut(); });
    expect(useCanvasStore.getState().nodes[0].data.content).toBe(system.text);
  });
  it('honors the latest copy across shortcut, context menu and a remounted canvas', async () => {
    useCanvasStore.setState({ nodes: [node('a', 'Shot A')] });
    const first = renderClipboard();
    act(() => first.result.current.copyNodes(['a']));
    await act(async () => { await first.result.current.pasteFromShortcut(); });
    expect(decodeCanvasClipboard(system.text)?.nodes[0].id).toBe('a');
    expect(useCanvasStore.getState().nodes.at(-1)?.position).toEqual({ x: 800, y: 400 });
    first.unmount();
    const next = renderClipboard();
    await act(async () => { await next.result.current.pasteAt({ nodeId: null, flowPosition: { x: 1100, y: 700 } }); });
    expect(useCanvasStore.getState().nodes.at(-1)?.data.displayName).toBe('Shot A-副本2');
    system.text = 'Copied outside';
    await act(async () => { await next.result.current.pasteFromShortcut(); });
    expect(useCanvasStore.getState().nodes.at(-1)?.data.content).toBe('Copied outside');
    await act(async () => { await next.result.current.pasteAt({ nodeId: null, flowPosition: { x: 1200, y: 700 } }); });
    expect(useCanvasStore.getState().nodes.at(-1)?.data.content).toBe('Copied outside');
    act(() => next.result.current.copyNodes(['a']));
    await act(async () => { await next.result.current.pasteFromShortcut(); });
    expect(useCanvasStore.getState().nodes.at(-1)?.data.displayName).toBe('Shot A-副本3');
  });

  it('handles a browser paste event containing the same graph data without converting it into text', async () => {
    useCanvasStore.setState({ nodes: [node('a', 'Shot A')] }); const view = renderClipboard();
    act(() => view.result.current.copyNodes(['a']));
    await waitFor(() => expect(system.text).toContain('clipboard v1'));
    fireEvent.paste(document.body, { clipboardData: { files: [], items: [], getData: () => system.text } });
    await waitFor(() => expect(useCanvasStore.getState().nodes).toHaveLength(2));
    expect(useCanvasStore.getState().nodes[1].type).toBe(CANVAS_NODE_TYPES.imageEdit);
  });

  it('freezes the pointer before a slow read and does not overwrite the selected upload', async () => {
    const deferred = Promise.withResolvers<ClipboardIO.ClipboardContentReadResult>();
    vi.mocked(readClipboardContent).mockReturnValueOnce(deferred.promise);
    let pointer = { x: 321, y: 456 };
    const createFromFile = vi.fn(async () => ({ nodeId: 'new', type: CANVAS_NODE_TYPES.upload }));
    useCanvasStore.setState({ nodes: [{ ...node('source', 'Existing', CANVAS_NODE_TYPES.upload), selected: true }] });
    const view = renderHook(() => useCanvasClipboard({ materialImport: { createFromFile, createFromSource: vi.fn(), handleDrop: vi.fn(), handleDragOver: vi.fn() }, resolvePastePosition: () => pointer, scheduleCanvasPersist: vi.fn() }));
    let task: Promise<boolean>;
    act(() => { task = view.result.current.pasteFromShortcut(); });
    pointer = { x: 999, y: 999 };
    const file = new File(['image'], 'copied.png', { type: 'image/png' });
    await act(async () => { deferred.resolve({ mediaFile: file, imageFile: file, text: '' }); await task; });
    expect(createFromFile).toHaveBeenCalledWith(file, { x: 321, y: 456 });
    expect(useCanvasStore.getState().nodes[0].data.displayName).toBe('Existing');
  });

  it('aborts a delayed read after changing projects and never resurrects an internal copy on read failure', async () => {
    const deferred = Promise.withResolvers<ClipboardIO.ClipboardContentReadResult>();
    vi.mocked(readClipboardContent).mockReturnValueOnce(deferred.promise);
    const view = renderClipboard(); const original = useProjectStore.getState().currentProjectId;
    let task: Promise<boolean>;
    act(() => { task = view.result.current.pasteFromShortcut(); });
    await waitFor(() => expect(readClipboardContent).toHaveBeenCalled());
    useProjectStore.setState({ currentProjectId: 'different' });
    await act(async () => { deferred.resolve({ mediaFile: null, imageFile: null, text: 'stale' }); await task; });
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
    useProjectStore.setState({ currentProjectId: original });
    vi.mocked(readClipboardContent).mockResolvedValueOnce({ mediaFile: null, imageFile: null, text: '', readFailed: true });
    await act(async () => { expect(await view.result.current.pasteFromShortcut()).toBe(false); });
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
  });

  it('copies a child without its parent at its absolute position', async () => {
    const group = node('g', 'Group', CANVAS_NODE_TYPES.group), child = { ...node('c', 'Child'), parentId: 'g', extent: 'parent' as const, position: { x: 20, y: 30 } };
    useCanvasStore.setState({ nodes: [group, child] }); const view = renderClipboard();
    act(() => view.result.current.copyNodes(['c']));
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(decodeCanvasClipboard(system.text)?.nodes[0]).toMatchObject({ position: { x: 120, y: 110 } });
    expect(decodeCanvasClipboard(system.text)?.nodes[0].parentId).toBeUndefined();
  });
});
