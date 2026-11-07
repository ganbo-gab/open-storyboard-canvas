// @vitest-environment jsdom
import { createElement, useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useCanvasGestures } from './useCanvasGestures';
import { useCanvasAlignmentStore } from '../state/canvasUiStore';
import { IS_MAC } from './shortcuts';

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, { bubbles: true, ...init });
    this.pointerId = init.pointerId ?? 1;
  }
}
function pointer(target: Element | Window, type: string, button = 0, pointerId = 1) {
  fireEvent(target, new TestPointerEvent(type, { button, pointerId }));
}
function Surface() {
  const wrapper = useRef<HTMLDivElement>(null);
  useCanvasGestures(wrapper);
  return createElement('div', { ref: wrapper, 'data-testid': 'root' },
    createElement('div', { className: 'react-flow__pane', 'data-testid': 'pane' }),
    createElement('div', { className: 'react-flow__node', 'data-id': 'node' },
      createElement('span', { 'data-testid': 'node' }, 'Node'),
      createElement('button', { 'data-testid': 'button' }, 'Action'),
      createElement('span', { className: 'react-flow__handle', 'data-testid': 'handle' })),
    createElement('svg', null, createElement('path', { className: 'canvas-edge__hit', 'data-testid': 'edge' })),
    createElement('div', { 'data-canvas-overlay': '', 'data-testid': 'overlay' }));
}
function mount() {
  return render(createElement(ReactFlowProvider, null, createElement(Surface)));
}
afterEach(cleanup);

describe('pointer-transform edge hit-test suspension', () => {
  it('suspends edge hit testing during node/pane primary interactions and restores on release', () => {
    mount();
    const root = screen.getByTestId('root');
    pointer(screen.getByTestId('node'), 'pointerdown');
    expect(root.hasAttribute('data-pointer-transform')).toBe(true);
    pointer(window, 'pointerup', 0, 2);
    expect(root.hasAttribute('data-pointer-transform')).toBe(true);
    pointer(window, 'pointerup');
    expect(root.hasAttribute('data-pointer-transform')).toBe(false);
    pointer(screen.getByTestId('pane'), 'pointerdown');
    expect(root.hasAttribute('data-pointer-transform')).toBe(true);
    pointer(window, 'pointercancel');
    expect(root.hasAttribute('data-pointer-transform')).toBe(false);
  });

  it('clears alignment guides on pointer cancellation and live platform-modifier press', () => {
    mount();
    pointer(screen.getByTestId('node'), 'pointerdown');
    useCanvasAlignmentStore.getState().setAlignmentGuides({ x: [100], y: [200] });
    pointer(window, 'pointercancel');
    expect(useCanvasAlignmentStore.getState().alignmentGuides).toBeNull();
    pointer(screen.getByTestId('node'), 'pointerdown');
    useCanvasAlignmentStore.getState().setAlignmentGuides({ x: [100], y: [] });
    fireEvent.keyDown(window, IS_MAC ? { key: 'Meta', metaKey: true } : { key: 'Control', ctrlKey: true });
    expect(useCanvasAlignmentStore.getState().alignmentGuides).toBeNull();
    fireEvent.keyUp(window, { key: IS_MAC ? 'Meta' : 'Control' });
    pointer(window, 'pointerup');
  });

  it('does not interfere with ordinary edge clicks, connection handles or controls', () => {
    mount();
    const root = screen.getByTestId('root');
    for (const name of ['edge', 'handle', 'button', 'overlay']) {
      pointer(screen.getByTestId(name), 'pointerdown');
      expect(root.hasAttribute('data-pointer-transform')).toBe(false);
      pointer(window, 'pointerup');
    }
  });

  it('clears suspension on blur and unmount so it cannot become a permanent interaction change', () => {
    const mounted = mount();
    const root = screen.getByTestId('root');
    pointer(screen.getByTestId('node'), 'pointerdown');
    fireEvent(window, new Event('blur'));
    expect(root.hasAttribute('data-pointer-transform')).toBe(false);
    pointer(screen.getByTestId('node'), 'pointerdown');
    mounted.unmount();
    expect(root.hasAttribute('data-pointer-transform')).toBe(false);
    pointer(window, 'pointerup');
  });
});
