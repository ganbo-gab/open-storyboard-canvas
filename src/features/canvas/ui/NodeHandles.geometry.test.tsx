// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ReactFlow, ReactFlowProvider, useStoreApi, type ReactFlowState } from '@xyflow/react';
import { ConnectionMode, getHandlePosition, Position, XYHandle } from '@xyflow/system';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasNode } from '../domain/canvasNodes';
import { NodeHandles } from './NodeFrame';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let flow: { getState(): ReactFlowState<CanvasNode>; setState(patch: Partial<ReactFlowState<CanvasNode>>): void };
let queued: FrameRequestCallback[] = [];
const card = { width: 520, height: 300, zoom: 1, x: 700, y: 100 };
function Frame() { return <div style={{ width: card.width, height: card.height }}><NodeHandles type="imageNode" width={card.width} height={card.height} /></div>; }
const nodeTypes = { imageNode: Frame };
function Probe() { flow = useStoreApi<CanvasNode>(); return null; }
function flushFrames() {
  for (let round = 0; queued.length && round < 5; round++) {
    const frame = queued; queued = [];
    act(() => frame.forEach(callback => callback(0)));
  }
}
function geometry(rect: { x: number; y: number; width: number; height: number }): DOMRect {
  return { ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => rect };
}
beforeEach(() => {
  Object.assign(card, { width: 520, height: 300, zoom: 1, x: 700, y: 100 }); queued = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queued.push(callback); return queued.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = card.zoom; });
  document.elementFromPoint = vi.fn(() => null);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('react-flow__handle')) return geometry({ x: card.x * card.zoom - card.zoom,
      y: (card.y + card.height / 2 - 1) * card.zoom, width: 2 * card.zoom, height: 2 * card.zoom });
    if (this.classList.contains('react-flow__node')) return geometry({ x: card.x * card.zoom, y: card.y * card.zoom, width: card.width * card.zoom, height: card.height * card.zoom });
    return geometry({ x: 0, y: 0, width: 1600, height: 1000 });
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('react-flow__handle') ? 2 : this.classList.contains('react-flow__node') ? card.width : 1600; });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('react-flow__handle') ? 2 : this.classList.contains('react-flow__node') ? card.height : 1000; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('node handle geometry and direction', () => {
  it.each([1, 0.57, 0.71])('refreshes cached handle bounds at zoom %s after the actual card mounts and changes size', zoom => {
    card.zoom = zoom;
    const initial: CanvasNode = { id: 'generator', type: 'imageNode', position: { x: card.x, y: card.y }, width: 520, height: 300,
      measured: { width: 520, height: 300 }, data: { imageUrl: null, prompt: 'Fixture', model: '', size: '2K', aspectRatio: '1:1' } };
    const mounted = render(<ReactFlowProvider><ReactFlow<CanvasNode> nodes={[initial]} nodeTypes={nodeTypes} defaultViewport={{ x: 0, y: 0, zoom }}><Probe /></ReactFlow></ReactFlowProvider>);
    const current = flow.getState().nodeLookup.get('generator');
    if (!current) throw new Error('Mounted node is missing');
    current.internals.handleBounds = { target: [{ id: 'target', nodeId: 'generator', type: 'target', position: Position.Left, x: -1, y: 109, width: 2, height: 2 }], source: [] };
    flushFrames();
    const measured = flow.getState().nodeLookup.get('generator');
    if (!measured) throw new Error('Measured node is missing');
    const initialPoint = getHandlePosition(measured, measured.internals.handleBounds?.target?.[0] ?? null, Position.Left, true);
    expect(initialPoint.x).toBeCloseTo(700); expect(initialPoint.y).toBeCloseTo(250);
    const calls = vi.spyOn(flow.getState(), 'updateNodeInternals');
    act(() => flow.setState({ transform: [30, 50, zoom * 1.2] }));
    flushFrames();
    expect(calls).not.toHaveBeenCalled();
    card.height = 400;
    const resized = { ...initial, height: 400, measured: { width: 520, height: 400 } };
    mounted.rerender(<ReactFlowProvider><ReactFlow<CanvasNode> nodes={[resized]} nodeTypes={nodeTypes} defaultViewport={{ x: 0, y: 0, zoom }}><Probe /></ReactFlow></ReactFlowProvider>);
    flushFrames();
    const updated = flow.getState().nodeLookup.get('generator');
    if (!updated) throw new Error('Resized node is missing');
    const resizedPoint = getHandlePosition(updated, updated.internals.handleBounds?.target?.[0] ?? null, Position.Left, true);
    expect(resizedPoint.x).toBeCloseTo(700); expect(resizedPoint.y).toBeCloseTo(300);
  });

  it('starts a connection at a manual input and keeps strict handle validation in source-to-target direction', () => {
    const image: CanvasNode = { id: 'image', type: 'imageNode', position: { x: 0, y: 0 }, width: 520, height: 300,
      measured: { width: 520, height: 300 }, data: { imageUrl: null, prompt: 'Fixture', model: '', size: '2K', aspectRatio: '1:1' } };
    const output = { ...image, id: 'output' };
    const mounted = render(<ReactFlowProvider><ReactFlow<CanvasNode> nodes={[image, output]} nodeTypes={nodeTypes}><Probe /></ReactFlow></ReactFlowProvider>);
    flushFrames();
    const input = mounted.container.querySelector<HTMLElement>('.react-flow__handle.target[data-nodeid="image"]');
    const source = mounted.container.querySelector<HTMLElement>('.react-flow__handle.source[data-nodeid="output"]');
    if (!input || !source) throw new Error('Expected native handles');
    expect(input.classList.contains('connectablestart')).toBe(true);
    expect(source.classList.contains('connectableend')).toBe(true);
    const start = vi.fn(); flow.setState({ onConnectStart: start });
    fireEvent.mouseDown(input, { button: 0, clientX: 700, clientY: 250 });
    fireEvent.mouseMove(document, { clientX: 690, clientY: 250 });
    expect(start).toHaveBeenCalledWith(expect.any(MouseEvent), { nodeId: 'image', handleId: 'target', handleType: 'target' });
    fireEvent.mouseUp(document, { clientX: 690, clientY: 250 });
    document.elementFromPoint = vi.fn(() => source);
    const inspect = (fromType: 'source' | 'target') => XYHandle.isValid(new MouseEvent('mousemove', { clientX: 700, clientY: 250 }), {
      handle: null, connectionMode: ConnectionMode.Strict, fromNodeId: 'image', fromHandleId: fromType,
      fromType, doc: document, lib: 'react', flowId: flow.getState().rfId, nodeLookup: flow.getState().nodeLookup,
    });
    expect(inspect('target')).toMatchObject({ isValid: true, connection: { source: 'output', sourceHandle: 'source', target: 'image', targetHandle: 'target' } });
    expect(inspect('source').isValid).toBe(false);
  });
});
