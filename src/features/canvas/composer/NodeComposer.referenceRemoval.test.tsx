// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, isStoryboardGenNode, type CanvasEdge, type CanvasNode } from '../domain/canvasNodes';
import { usePromptDraft, useTextDraft } from './usePromptDraft';
import { NodeComposer } from './NodeComposer';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { label?: string; count?: number }) => `${key}${options?.label ? `:${options.label}` : ''}${options?.count !== undefined ? `:${options.count}` : ''}` }) }));
vi.mock('@/features/canvas/ui/SafeNodeToolbar', () => ({ SafeNodeToolbar: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/features/canvas/application/generation', () => ({ submitNodeGeneration: vi.fn() }));
vi.mock('@/features/library/application/projectLibraryActions', () => ({ getCanvasHistoryReuseOptions: () => null }));
vi.mock('@/features/canvas/ui/GenerationDraftOptionsDialog', () => ({ openGenerationDraftOptionsEditor: vi.fn() }));
vi.mock('@/features/assets/ui/CanvasAssetEditHost', () => ({ openCanvasAssetEditor: vi.fn() }));
vi.mock('@/features/assets/ui/AssetMedia', () => ({ AssetMedia: () => <span aria-hidden="true" /> }));
vi.mock('./useSourceCommands', () => ({ useSourceCommands: () => [], applyComposerPrompt: vi.fn() }));

function image(id: string): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.upload, position: { x: 0, y: 0 }, data: { imageUrl: `/${id}.png`, aspectRatio: '1:1', previewImageUrl: null } };
}
function consumer(): CanvasNode {
  return { id: 'target', type: CANVAS_NODE_TYPES.imageEdit, position: { x: 600, y: 0 }, selected: true,
    data: { prompt: 'Stored text', model: 'gpt-image-2', size: '2K', imageUrl: null, aspectRatio: '1:1', previewImageUrl: null } };
}
function fixture(grouped = false, storyboard = false) {
  const consumerNode: CanvasNode = storyboard ? { id: 'target', type: CANVAS_NODE_TYPES.storyboardGen, position: { x: 600, y: 0 }, selected: true,
    data: { gridRows: 1, gridCols: 2, model: 'gpt-image-2', size: '2K', requestAspectRatio: '1:1', imageUrl: null, aspectRatio: '2:1',
      frames: [{ id: 'shot-a', description: 'Other shot @图2' }, { id: 'shot-b', description: 'Stored text' }] } } : consumer();
  const nodes = [image('one'), image('two'), consumerNode];
  const edges: CanvasEdge[] = [{ id: 'one-target', source: 'one', target: 'target' }, { id: 'two-target', source: 'two', target: 'target' }];
  if (grouped) {
    nodes.push({ id: 'group', type: CANVAS_NODE_TYPES.tagGroup, position: { x: 0, y: 300 }, data: { label: 'Group', displayName: 'Group', schemaVersion: 2, memberNodeIds: ['one', 'two'], enabled: true, color: 'neutral', shape: 'rounded' } });
    edges.splice(0, edges.length, { id: 'group-target', source: 'group', target: 'target' });
  }
  useCanvasStore.setState({ nodes, edges, revision: 0, selectedNodeId: 'target', history: { past: [], future: [] }, dragHistorySnapshot: null });
  function Surface() {
    const prompt = useCanvasStore(state => state.nodes.find(node => node.id === 'target')?.data.prompt);
    const draft = usePromptDraft('target', 'prompt', typeof prompt === 'string' ? prompt : '');
    return <NodeComposer nodeId="target" open draft={draft} placeholder="Write" params={<span>Parameters</span>} />;
  }
  function StoryboardSurface() {
    const target = useCanvasStore(state => state.nodes.find(node => node.id === 'target'));
    const frame = target && isStoryboardGenNode(target) ? target.data.frames.find(frame => frame.id === 'shot-b') : undefined;
    const draft = useTextDraft('target:shot-b', frame?.description ?? '', (description) => {
      const state = useCanvasStore.getState();
      const latest = state.nodes.find(node => node.id === 'target');
      if (latest && isStoryboardGenNode(latest)) state.updateNodeData('target', { frames: latest.data.frames.map(frame => frame.id === 'shot-b' ? { ...frame, description } : frame) });
    });
    return <NodeComposer nodeId="target" open draft={draft} referencePromptTarget={{ kind: 'storyboardFrame', frameId: 'shot-b' }} placeholder="Write" params={<span>Parameters</span>} />;
  }
  return render(storyboard ? <StoryboardSurface /> : <Surface />);
}
function editor(): Editor {
  const textbox = screen.getByRole('textbox', { name: 'rework.prompt' });
  if ('editor' in textbox && textbox.editor instanceof Editor) return textbox.editor;
  throw new Error('Expected the real prompt editor');
}
async function ready() { await screen.findByRole('textbox', { name: 'rework.prompt' }); return editor(); }
function removeButton(label = '图1') { return screen.getByRole('button', { name: `ui.canvas.removeReference:${label}` }); }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(100, 300, 0, 20) });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('composer reference removal controls', () => {
  it('keeps insertion and removal as separate buttons, preserving the full uncommitted draft in one graph edit', async () => {
    fixture(); const prompt = await ready();
    const insert = screen.getByRole('button', { name: 'rework.canvas.composer.insertReference:图1' });
    expect(insert.contains(removeButton())).toBe(false);
    fireEvent.click(insert);
    await waitFor(() => expect(prompt.getText()).toBe('Stored text @图1 '));
    const baseline = useCanvasStore.getState().history.past.length;
    act(() => prompt.commands.insertContentAt(prompt.state.doc.content.size - 1, 'unsaved @图2'));
    expect(useCanvasStore.getState().nodes.find(node => node.id === 'target')?.data.prompt).toBe('Stored text @图1 ');
    fireEvent.pointerDown(removeButton()); fireEvent.click(removeButton());
    await waitFor(() => expect(prompt.getText()).toBe('Stored text  unsaved @图1'));
    expect(useCanvasStore.getState().edges.map(edge => edge.id)).toEqual(['two-target']);
    expect(useCanvasStore.getState().nodes).toHaveLength(3);
    expect(useCanvasStore.getState().history.past.length).toBe(baseline + 1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect([...prompt.view.dom.querySelectorAll('[data-prompt-reference]')].map(node => node.textContent)).toEqual(['@图1']);
    act(() => prompt.commands.undo());
    expect(prompt.getText()).toBe('Stored text  unsaved @图1');
  });

  it('cancels a multi-reference disconnection without losing uncommitted text', async () => {
    fixture(true); const prompt = await ready();
    act(() => prompt.commands.insertContentAt(prompt.state.doc.content.size - 1, ' pending @图2'));
    fireEvent.click(removeButton());
    const dialog = screen.getByRole('dialog', { name: 'ui.canvas.removeSharedReferenceTitle' });
    expect(within(dialog).getByText('ui.canvas.removeSharedReferenceHint:2')).toBeTruthy();
    expect(useCanvasStore.getState().edges).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(prompt.getText()).toBe('Stored text pending @图2');
    expect(useCanvasStore.getState().edges).toHaveLength(1);
  });

  it('confirms the shared edge using the latest draft, even if the typing timer committed while the modal was open', async () => {
    fixture(true); const prompt = await ready();
    act(() => prompt.commands.insertContentAt(prompt.state.doc.content.size - 1, ' pending @图2'));
    fireEvent.click(removeButton());
    act(() => useCanvasStore.getState().updateNodeData('target', { prompt: 'Stored text pending @图2' }));
    const baseline = useCanvasStore.getState().history.past.length;
    fireEvent.click(screen.getByRole('button', { name: 'ui.canvas.disconnectReferences' }));
    await waitFor(() => expect(prompt.getText()).toBe('Stored text pending '));
    expect(useCanvasStore.getState().edges).toEqual([]);
    expect(useCanvasStore.getState().nodes).toHaveLength(4);
    expect(useCanvasStore.getState().history.past.length).toBe(baseline + 1);
  });

  it('requires a fresh choice if the shared reference membership changes before confirmation', async () => {
    fixture(true); const prompt = await ready();
    fireEvent.click(removeButton());
    act(() => useCanvasStore.getState().updateNodeData('group', { memberNodeIds: ['one'] }));
    fireEvent.click(screen.getByRole('button', { name: 'ui.canvas.disconnectReferences' }));
    expect(useCanvasStore.getState().edges).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('ui.canvas.referenceRemovalChanged');
    expect(prompt.getText()).toBe('Stored text');
  });

  it('preserves the active storyboard draft, remaps the other shot, and does not create a root prompt or second undo entry', async () => {
    fixture(false, true); const prompt = await ready();
    act(() => prompt.commands.insertContentAt(prompt.state.doc.content.size - 1, ' unsaved @图2'));
    fireEvent.pointerDown(removeButton()); fireEvent.click(removeButton());
    await waitFor(() => expect(prompt.getText()).toBe('Stored text unsaved @图1'));
    const state = useCanvasStore.getState();
    expect(state.nodes.find(node => node.id === 'target')?.data.frames).toEqual([
      { id: 'shot-a', description: 'Other shot @图1' }, { id: 'shot-b', description: 'Stored text unsaved @图1' },
    ]);
    expect(state.nodes.find(node => node.id === 'target')?.data).not.toHaveProperty('prompt');
    expect(state.edges.map(edge => edge.id)).toEqual(['two-target']);
    expect(state.history.past).toHaveLength(1);
    // The old typing timer must neither restore pre-removal numbering nor append a frame
    // array write after the atomic graph edit was acknowledged locally.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1050)); });
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    expect(prompt.getText()).toBe('Stored text unsaved @图1');
    act(() => useCanvasStore.getState().undo());
    await waitFor(() => expect(prompt.getText()).toBe('Stored text'));
    expect(useCanvasStore.getState().edges).toHaveLength(2);
    act(() => useCanvasStore.getState().redo());
    await waitFor(() => expect(prompt.getText()).toBe('Stored text unsaved @图1'));
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
  });
});
