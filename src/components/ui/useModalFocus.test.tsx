// @vitest-environment jsdom
import { fireEvent, render, cleanup, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModalFocus } from './useModalFocus';

function Dialog({ name, onClose }: { name: string; onClose(): void }) {
  const { dialogRef, onKeyDown } = useModalFocus({ isOpen: true, onClose });
  return <div role="dialog" aria-label={name} ref={dialogRef} onKeyDown={onKeyDown} tabIndex={-1}>
    <button>{name} first</button><button>{name} last</button>
  </div>;
}

beforeEach(() => {
  const rect = new DOMRect(0, 0, 100, 30);
  const rects = Object.assign([rect], { item: (index: number) => index === 0 ? rect : null });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(rects);
  document.body.tabIndex = -1;
});
afterEach(() => { cleanup(); document.body.removeAttribute('tabindex'); vi.restoreAllMocks(); });

describe('modal keyboard ownership', () => {
  it('Escape still closes after disabling the focused submit moves focus to body', () => {
    const close = vi.fn();
    render(<Dialog name="editor" onClose={close} />);
    const submit = screen.getByRole('button', { name: 'editor first' });
    submit.focus();
    submit.setAttribute('disabled', '');
    // jsdom does not model Chromium's automatic focus loss when a focused button is disabled.
    document.body.focus();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('only the top dialog consumes Escape, then restores keyboard ownership to its parent', () => {
    const parentClose = vi.fn();
    function Nested() {
      const [child, setChild] = useState(true);
      return <><Dialog name="parent" onClose={parentClose} />{child && <Dialog name="child" onClose={() => setChild(false)} />}</>;
    }
    render(<Nested />);
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'child' })).toBeNull();
    expect(parentClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(parentClose).toHaveBeenCalledOnce();
  });

  it('does not close when a higher-priority menu already consumed Escape', () => {
    const close = vi.fn();
    render(<Dialog name="editor" onClose={close} />);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    document.body.dispatchEvent(event);
    expect(close).not.toHaveBeenCalled();
  });

  it('Tab returns escaped focus to the first or last available control', () => {
    render(<Dialog name="editor" onClose={() => undefined} />);
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'editor first' }));
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'editor last' }));
  });
});
