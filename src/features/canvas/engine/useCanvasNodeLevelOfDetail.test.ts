// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi, type ReactFlowState } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoreApi } from 'zustand';

import { useCanvasUiStore } from '@/features/canvas/state/canvasUiStore';
import { useCanvasNodeLevelOfDetail } from './useCanvasNodeLevelOfDetail';

let flowStore: Pick<StoreApi<ReactFlowState>, 'getState' | 'setState' | 'subscribe'> | undefined;
let renders = 0;

function DetailProbe() {
  flowStore = useStoreApi();
  const simplified = useCanvasNodeLevelOfDetail();
  renders += 1;
  return createElement('output', { 'aria-label': 'Node detail' }, simplified ? 'low' : 'full');
}

function zoom(value: number) {
  const store = flowStore;
  if (!store) throw new Error('Probe is not mounted');
  act(() => store.setState({ transform: [0, 0, value] }));
}

function activity(keepAllNodesRendered: boolean, simplifyNodes: boolean) {
  act(() => useCanvasUiStore.getState().setZoomRendering({ keepAllNodesRendered, simplifyNodes }));
}

beforeEach(() => {
  renders = 0;
  flowStore = undefined;
  useCanvasUiStore.getState().reset();
});
afterEach(cleanup);

describe('effective canvas node detail subscription', () => {
  it('does not rerender far nodes for gesture state or viewport changes that preserve detail', () => {
    render(createElement(ReactFlowProvider, null, createElement(DetailProbe)));
    zoom(0.15);
    expect(screen.getByLabelText('Node detail').textContent).toBe('low');
    const settledRenders = renders;
    activity(true, true);
    zoom(0.2);
    zoom(0.8);
    zoom(0.3);
    activity(false, true);
    activity(false, false);
    expect(renders).toBe(settledRenders);
    expect(screen.getByLabelText('Node detail').textContent).toBe('low');
  });

  it('upgrades a close-up only after the gesture override is released', () => {
    render(createElement(ReactFlowProvider, null, createElement(DetailProbe)));
    expect(screen.getByLabelText('Node detail').textContent).toBe('full');
    activity(false, true);
    expect(screen.getByLabelText('Node detail').textContent).toBe('low');
    const gestureRenders = renders;
    zoom(0.2);
    zoom(0.8);
    activity(false, true);
    expect(renders).toBe(gestureRenders);
    activity(false, false);
    expect(screen.getByLabelText('Node detail').textContent).toBe('full');
    expect(renders).toBe(gestureRenders + 1);
  });
});
