// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UiModal } from './primitives';
afterEach(cleanup);
it('keeps portaled dialog controls from selecting or keyboard-moving their canvas owner', () => {
  const owner = vi.fn(), control = vi.fn(), close = vi.fn();
  render(<div onKeyDown={owner} onClick={owner} onDoubleClick={owner} onFocus={owner} onPointerDown={owner} onMouseDown={owner}>
    <UiModal isOpen title="Camera" onClose={close}><button onClick={control}>Next lens</button></UiModal>
  </div>);
  const button = screen.getByRole('button', { name: 'Next lens' });
  fireEvent.focus(button); fireEvent.pointerDown(button); fireEvent.mouseDown(button);
  fireEvent.click(button, { ctrlKey: true }); fireEvent.doubleClick(button);
  fireEvent.keyDown(button, { key: 'ArrowRight' }); fireEvent.keyDown(button, { key: ' ' });
  expect(control).toHaveBeenCalledOnce(); expect(owner).not.toHaveBeenCalled();
  fireEvent.keyDown(button, { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
});
