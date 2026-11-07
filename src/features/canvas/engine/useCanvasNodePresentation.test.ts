// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi, type InternalNode, type ReactFlowState } from '@xyflow/react';
import type { StoreApi } from 'zustand';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCanvasNodePresentation } from './useCanvasNodePresentation';

let flow: Pick<StoreApi<ReactFlowState>, 'getState' | 'setState'> | undefined;
let renders = 0;
function Probe() {
  flow = useStoreApi();
  const node = useCanvasNodePresentation('node');
  renders += 1;
  return createElement('output', { 'aria-label': 'presentation' }, node ? `${String(node.data.content)}:${node.measured.width}:${Boolean(node.selected)}` : 'missing');
}
function publish(node?: InternalNode) {
  const store = flow;
  if (!store) throw new Error('Probe is not mounted');
  act(() => store.setState({ nodeLookup: node ? new Map([[node.id, node]]) : new Map() }));
}
function initial(): InternalNode {
  const node = { id: 'node', type: 'textAnnotationNode', position: { x: 0, y: 0 }, data: { content: 'first' }, width: 320, height: 220 };
  return { ...node, measured: { width: 320, height: 220 }, internals: { positionAbsolute: { x: 0, y: 0 }, z: 0, userNode: node } };
}
beforeEach(() => { renders = 0; flow = undefined; });
afterEach(cleanup);

describe('node presentation subscription', () => {
  it('does not rerender a node body when only absolute position and dragging change', () => {
    render(createElement(ReactFlowProvider, null, createElement(Probe)));
    const node = initial();
    publish(node);
    const before = renders;
    publish({ ...node, position: { x: 200, y: 100 }, dragging: true, internals: { ...node.internals, positionAbsolute: { x: 200, y: 100 } } });
    expect(renders).toBe(before);
    expect(screen.getByLabelText('presentation').textContent).toBe('first:320:false');
  });

  it('still updates data, dimensions, selection and deletion', () => {
    render(createElement(ReactFlowProvider, null, createElement(Probe)));
    const node = initial();
    publish(node);
    const changed = { ...node, data: { content: 'edited' }, selected: true, measured: { width: 640, height: 220 } };
    publish(changed);
    expect(screen.getByLabelText('presentation').textContent).toBe('edited:640:true');
    publish();
    expect(screen.getByLabelText('presentation').textContent).toBe('missing');
  });
});
