// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJSONStorage } from 'zustand/middleware';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
import { useChannelStore } from '@/features/channels/store/channelStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, isImageEditNode } from '@/features/canvas/domain/canvasNodes';
import type { NodeReferences } from './useNodeReferences';
import type { ModelConfigValue } from '@/features/canvas/ui/ModelConfigPicker';
const references = vi.hoisted(() => ({ current: { all: [], pickable: [] } as NodeReferences }));
vi.mock('./useNodeReferences', () => ({ useNodeReferences: () => references.current }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { NativeImageControls } from './NativeImageControls';

const profile: ChannelProfileV2 = { version: 2, id: 'native-image-controls-fixture', name: 'Native image controls fixture', baseUrl: 'https://fixture.invalid', auth: { type: 'none' },
  operations: {
    'image.generate': { method: 'POST', path: '/images', body: 'json', template: { prompt: '{{prompt}}' }, response: { mode: 'sync', outputs: [] } },
    'image.edit': { method: 'POST', path: '/edits', body: 'json', template: { prompt: '{{prompt}}', images: '{{slot.images}}' }, response: { mode: 'sync', outputs: [] } },
  }, models: [{ id: 'image', operations: ['image.generate', 'image.edit'], params: [], modes: [
    { id: 'text', label: 'Text mode', operation: 'image.generate', params: [{ key: 'size', label: '尺寸', type: 'enum', default: '1024x1024', options: [{ label: 'Text size', value: '1024x1024' }] }] },
    { id: 'edit', label: 'Edit mode', operation: 'image.edit', slots: [{ key: 'images', label: 'Images', kind: 'image', min: 1, max: 2 }],
      params: [{ key: 'size', label: '尺寸', type: 'enum', default: '1536x1024', options: [{ label: 'Edit size', value: '1536x1024' }] }] },
  ] }] };
const modelValue: ModelConfigValue = { entryId: 'custom:native-image-controls-fixture:image', ratio: 'auto', extraParams: {} };
let nodeId: string;
function Surface() {
  const value = useCanvasStore(state => { const node = state.nodes.find(node => node.id === nodeId); return node && isImageEditNode(node) ? node.data.modelConfig : undefined; });
  return <NativeImageControls nodeId={nodeId} value={value ?? modelValue} onChange={modelConfig => useCanvasStore.getState().updateNodeData(nodeId, { modelConfig })} />;
}
function graphImages(count: number): NodeReferences {
  const all: NodeReferences['all'] = Array.from({ length: count }, (_, index) => ({ kind: 'image', sourceNodeId: `image-${index}`, label: `图${index + 1}`, token: `@图${index + 1}`,
    title: `Image ${index + 1}`, imageUrl: `/image-${index}.png`, displayUrl: null }));
  return { all, pickable: all };
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  useChannelStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useChannelStore.setState({ channels: [{ profile: structuredClone(profile), origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
  useCanvasStore.getState().setCanvasData([], []);
  nodeId = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.imageEdit, { x: 0, y: 0 }, { prompt: 'Fixture', modelConfig: structuredClone(modelValue) });
  references.current = graphImages(0);
});
afterEach(() => { cleanup(); useCanvasStore.getState().setCanvasData([], []); useChannelStore.setState({ channels: [] }); vi.unstubAllGlobals(); });

describe('native image controls', () => {
  it('reacts to graph image references with automatic text/edit mode and the matching parameter default summary', () => {
    const view = render(<Surface />);
    expect(screen.getByRole('button', { name: 'ui.channels.autoImage.auto · Text mode' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Text size' })).toBeTruthy();
    references.current = graphImages(1); view.rerender(<Surface />);
    expect(screen.getByRole('button', { name: 'ui.channels.autoImage.auto · Edit mode' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit size' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Text size' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit size' }));
    expect(screen.getByRole('button', { name: 'Edit size', pressed: true })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    references.current = graphImages(0); view.rerender(<Surface />);
    expect(screen.getByRole('button', { name: 'ui.channels.autoImage.auto · Text mode' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Text size' })).toBeTruthy();
    const node = useCanvasStore.getState().nodes.find(node => node.id === nodeId);
    expect(node?.data.channelModeId).toBeUndefined();
  });

  it('shows the new automatic mode default when a previous-mode parameter value is no longer supported', () => {
    act(() => useCanvasStore.getState().updateNodeData(nodeId, { modelConfig: { ...modelValue, extraParams: { size: '1024x1024' } } }));
    const view = render(<Surface />);
    expect(screen.getByRole('button', { name: 'Text size' })).toBeTruthy();
    references.current = graphImages(1); view.rerender(<Surface />);
    expect(screen.getByRole('button', { name: 'ui.channels.autoImage.auto · Edit mode' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit size' })).toBeTruthy();
  });

  it('keeps manual mode selection locked across graph reference changes and returns to automatic on request', () => {
    const view = render(<Surface />);
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.autoImage.auto · Text mode' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit mode' }));
    expect(screen.getByRole('button', { name: 'Edit mode' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit size' })).toBeTruthy();
    references.current = graphImages(1); view.rerender(<Surface />);
    expect(screen.getByRole('button', { name: 'Edit mode' })).toBeTruthy();
    references.current = graphImages(0); view.rerender(<Surface />);
    expect(screen.getByRole('button', { name: 'Edit mode' })).toBeTruthy();
    expect(useCanvasStore.getState().nodes.find(node => node.id === nodeId)?.data.channelModeId).toBe('edit');
    fireEvent.click(screen.getByRole('button', { name: 'Edit mode' }));
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.autoImage.auto' }));
    expect(screen.getByRole('button', { name: 'ui.channels.autoImage.auto · Text mode' })).toBeTruthy();
    expect(useCanvasStore.getState().nodes.find(node => node.id === nodeId)?.data.channelModeId).toBeUndefined();
  });

  it('does not reset a manually selected reference subset when choosing the current mode again', () => {
    references.current = graphImages(2);
    act(() => useCanvasStore.getState().updateNodeData(nodeId, { channelModeId: 'edit', referenceSlots: { images: ['/image-1.png'] },
      modelConfig: { ...modelValue, extraParams: { size: '1536x1024' } } }));
    const before = useCanvasStore.getState().nodes.find(node => node.id === nodeId);
    render(<Surface />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit mode' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'channelModes.mode' })).getByRole('button', { name: 'Edit mode' }));
    expect(useCanvasStore.getState().nodes.find(node => node.id === nodeId)).toBe(before);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('preserves compatible selected slots when switching between manual modes instead of restoring all graph images', () => {
    const configured = structuredClone(profile);
    configured.models[0].modes!.push({ ...configured.models[0].modes![1], id: 'edit-alternate', label: 'Alternate edit' });
    useChannelStore.setState({ channels: [{ profile: configured, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
    references.current = graphImages(2);
    act(() => useCanvasStore.getState().updateNodeData(nodeId, { channelModeId: 'edit', referenceSlots: { images: ['/image-1.png'] },
      modelConfig: { ...modelValue, extraParams: { size: '1536x1024' } } }));
    render(<Surface />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit mode' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alternate edit' }));
    expect(useCanvasStore.getState().nodes.find(node => node.id === nodeId)?.data).toMatchObject({
      channelModeId: 'edit-alternate', referenceSlots: { images: ['/image-1.png'] }, modelConfig: { extraParams: { size: '1536x1024' } },
    });
    expect(screen.getByRole('button', { name: 'Alternate edit' })).toBeTruthy();
  });

  it('shows a mode-selection error for ambiguous automatic references without rewriting the graph or model config', () => {
    const ambiguous = structuredClone(profile);
    ambiguous.models[0].modes!.push({ ...ambiguous.models[0].modes![1], id: 'edit-copy', label: 'Other edit' });
    useChannelStore.setState({ channels: [{ profile: ambiguous, origin: 'native', migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
    references.current = graphImages(1);
    const before = structuredClone(useCanvasStore.getState().nodes);
    render(<Surface />);
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.autoImage.choose' }));
    expect(screen.getByRole('alert').textContent).toContain('多个模式');
    expect(useCanvasStore.getState().nodes).toEqual(before);
  });

  it('uses explicit slots instead of graph fallback while computing the displayed automatic mode', () => {
    act(() => useCanvasStore.getState().updateNodeData(nodeId, { referenceSlots: {} }));
    references.current = graphImages(1);
    const view = render(<Surface />);
    expect(screen.getByRole('button', { name: 'ui.channels.autoImage.auto · Text mode' })).toBeTruthy();
    act(() => useCanvasStore.getState().updateNodeData(nodeId, { referenceSlots: { images: ['/assigned.png'] } }));
    view.rerender(<Surface />);
    expect(screen.getByRole('button', { name: 'ui.channels.autoImage.auto · Edit mode' })).toBeTruthy();
  });
});
