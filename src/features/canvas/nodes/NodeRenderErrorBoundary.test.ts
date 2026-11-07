// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sameCanvasNodeBodyProps, withNodeRenderErrorBoundary } from './NodeRenderErrorBoundary';

let renders = 0;
function Body({ data }: NodeProps) {
  renders += 1;
  return createElement('output', { 'aria-label': 'body' }, String(data.content));
}
const SafeBody = withNodeRenderErrorBoundary(Body);
function props(): NodeProps {
  return { id: 'body', type: 'textAnnotationNode', data: { content: 'first' }, width: 320, height: 220, selected: false, dragging: false, zIndex: 0, selectable: true, deletable: true, draggable: true, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0 };
}
function view(value: NodeProps) {
  return createElement(ReactFlowProvider, null, createElement(SafeBody, value));
}
beforeEach(() => { renders = 0; });
afterEach(cleanup);

describe('canvas node body memo boundary', () => {
  it('lets the Flow wrapper move without recreating the node body', () => {
    const initial = props();
    const mounted = render(view(initial));
    mounted.rerender(view({ ...initial, positionAbsoluteX: 100, positionAbsoluteY: 50, dragging: true }));
    expect(renders).toBe(1);
    expect(screen.getByLabelText('body').textContent).toBe('first');
    mounted.rerender(view({ ...initial, data: { content: 'edited' } }));
    expect(renders).toBe(2);
    expect(screen.getByLabelText('body').textContent).toBe('edited');
  });

  it('does not ignore presentation or capability changes', () => {
    const initial = props();
    for (const next of [
      { ...initial, selected: true }, { ...initial, width: 640 }, { ...initial, height: 440 },
      { ...initial, type: 'aiTextNode' }, { ...initial, parentId: 'group' },
      { ...initial, isConnectable: false }, { ...initial, draggable: false },
      { ...initial, deletable: false }, { ...initial, selectable: false }, { ...initial, zIndex: 10 },
    ]) expect(sameCanvasNodeBodyProps(initial, next)).toBe(false);
  });
});
