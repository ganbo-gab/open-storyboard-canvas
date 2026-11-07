// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider, type FinalConnectionState } from '@xyflow/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useCanvasUiStore } from '../state/canvasUiStore';
import { useCanvasConnections } from './useCanvasConnections';

let connections: ReturnType<typeof useCanvasConnections>;
const persist = vi.fn();
function Probe() { connections = useCanvasConnections(persist); return null; }
function pointerTarget(id: string, handleType?: 'source' | 'target'): HTMLElement {
  const node = document.createElement('div'); node.className = 'react-flow__node'; node.dataset.id = id;
  if (handleType) { const handle = document.createElement('div'); handle.className = 'react-flow__handle'; node.append(handle); document.body.append(node); return handle; }
  document.body.append(node); return node;
}
function mouse(target: HTMLElement, clientX = 300, clientY = 200): MouseEvent {
  const event = new MouseEvent('mouseup', { clientX, clientY });
  Object.defineProperty(event, 'target', { value: target }); return event;
}
function ended(valid = false): FinalConnectionState {
  if (valid) throw new Error('This fixture represents an unconnected card drop');
  return { isValid: null, from: null, fromHandle: null, fromPosition: null,
    fromNode: null, to: null, toHandle: null, toPosition: null, toNode: null, pointer: null };
}
beforeEach(() => {
  persist.mockClear(); useCanvasUiStore.getState().reset();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle));
  document.elementFromPoint = vi.fn(() => null);
  useCanvasStore.getState().setCanvasData([
    { id: 'image', type: 'uploadNode', position: { x: 0, y: 0 }, data: { imageUrl: '/fixture.png', aspectRatio: '1:1' } },
    { id: 'generator', type: 'imageNode', position: { x: 500, y: 0 }, data: { imageUrl: null, prompt: 'Fixture', aspectRatio: '1:1', resolution: '2K' } },
    { id: 'audio', type: 'audioNode', position: { x: 0, y: 400 }, data: { audioUrl: null } },
  ], []);
  render(<ReactFlowProvider><Probe /></ReactFlowProvider>);
});
afterEach(() => { cleanup(); document.querySelectorAll('.react-flow__node').forEach(node => node.remove()); vi.unstubAllGlobals(); });

describe('canvas connection drag direction', () => {
  it('connects a target-origin drag dropped on a source card in the canonical source-to-target direction', async () => {
    const input = pointerTarget('generator', 'target'), source = pointerTarget('image');
    act(() => connections.onConnectStart(mouse(input), { nodeId: 'generator', handleId: 'target', handleType: 'target' }));
    act(() => connections.onConnectEnd(mouse(source), ended()));
    await waitFor(() => expect(useCanvasStore.getState().edges).toHaveLength(1));
    expect(useCanvasStore.getState().edges[0]).toMatchObject({ source: 'image', target: 'generator', sourceHandle: 'source', targetHandle: 'target' });
    expect(persist).toHaveBeenCalledOnce();
  });
  it('retains media-kind restrictions and rejects duplicates for a target-origin gesture', async () => {
    const input = pointerTarget('generator', 'target');
    act(() => connections.onConnectStart(mouse(input), { nodeId: 'generator', handleId: 'target', handleType: 'target' }));
    act(() => connections.onConnectEnd(mouse(pointerTarget('audio')), ended()));
    await Promise.resolve();
    expect(useCanvasStore.getState().edges).toEqual([]);
    expect(connections.isValidConnection({ source: 'audio', target: 'generator', sourceHandle: 'source', targetHandle: 'target' })).toBe(false);
    useCanvasStore.getState().addEdge('image', 'generator');
    expect(connections.isValidConnection({ source: 'image', target: 'generator', sourceHandle: 'source', targetHandle: 'target' })).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });
});
