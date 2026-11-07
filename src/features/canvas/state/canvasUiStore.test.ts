// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCanvasAlignmentStore, useCanvasUiStore } from './canvasUiStore';

let cardRenders = 0;
function Card() {
  const rejection = useCanvasUiStore((state) => state.connectionReject);
  cardRenders += 1;
  return createElement('output', { 'aria-label': 'Connection state' }, rejection?.nodeId ?? 'ready');
}
function Guides() {
  const guides = useCanvasAlignmentStore((state) => state.alignmentGuides);
  return createElement('output', { 'aria-label': 'Alignment guides' }, guides ? `${guides.x.join(',')}:${guides.y.join(',')}` : 'none');
}
beforeEach(() => {
  useCanvasUiStore.getState().reset();
  cardRenders = 0;
});
afterEach(cleanup);

describe('drag alignment display state', () => {
  it('updates visible guides without rerendering an unchanged card and clears them with canvas reset', () => {
    render(createElement('div', null, createElement(Card), createElement(Guides)));
    const before = cardRenders;
    act(() => useCanvasAlignmentStore.getState().setAlignmentGuides({ x: [100], y: [200, 240] }));
    expect(screen.getByLabelText('Alignment guides').textContent).toBe('100:200,240');
    expect(screen.getByLabelText('Connection state').textContent).toBe('ready');
    expect(cardRenders).toBe(before);
    act(() => useCanvasUiStore.getState().reset());
    expect(screen.getByLabelText('Alignment guides').textContent).toBe('none');
  });
});
