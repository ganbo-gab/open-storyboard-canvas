// @vitest-environment jsdom
import { useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useCanvasPointer } from './useCanvasHotkeys';
afterEach(cleanup);
it('captures stopped pointer events, window reentry and the current client rectangle after resize', () => {
  let current: { current: { x: number; y: number } | null } = { current: null };
  function Probe() {
    const wrapper = useRef<HTMLDivElement>(null); current = useCanvasPointer(wrapper);
    return <div ref={wrapper} data-testid="canvas"><button onPointerMove={event => event.stopPropagation()}>Overlay</button></div>;
  }
  render(<Probe />);
  const element = screen.getByTestId('canvas');
  element.getBoundingClientRect = () => new DOMRect(0, 40, 1200, 800);
  fireEvent.mouseMove(screen.getByRole('button'), { clientX: 700, clientY: 400 });
  expect(current.current).toEqual({ x: 700, y: 400 });
  fireEvent.contextMenu(element, { clientX: 800, clientY: 500 });
  expect(current.current).toEqual({ x: 800, y: 500 });
  element.getBoundingClientRect = () => new DOMRect(200, 80, 960, 600);
  fireEvent.mouseMove(element, { clientX: 300, clientY: 100 });
  expect(current.current).toEqual({ x: 300, y: 100 });
  fireEvent.mouseMove(document.body, { clientX: 20, clientY: 20 });
  expect(current.current).toBeNull();
});
