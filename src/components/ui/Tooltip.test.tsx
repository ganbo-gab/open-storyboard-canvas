// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tooltip } from './Tooltip';
import { FLOATING_SURFACE_OPEN, MODAL_SURFACE_OPEN } from './floatingSurfaces';

const delay = 600;
function Surface({ onClick }: { onClick?(): void }) {
  return <><Tooltip label="Model details" delay={delay}><button onClick={onClick}>Model</button></Tooltip><div data-testid="scroller">Scroll area</div></>;
}
function hover() { fireEvent.pointerEnter(screen.getByRole('button', { name: 'Model' })); }
const cancelEvents = [
  { name: 'floating surface', emit: () => document.dispatchEvent(new CustomEvent(FLOATING_SURFACE_OPEN)) },
  { name: 'modal', emit: () => document.dispatchEvent(new CustomEvent(MODAL_SURFACE_OPEN)) },
  { name: 'pointer press', emit: () => fireEvent.pointerDown(screen.getByTestId('scroller')) },
  { name: 'resize', emit: () => fireEvent.resize(window) },
  { name: 'wheel', emit: () => fireEvent.wheel(screen.getByTestId('scroller'), { deltaY: 40 }) },
  { name: 'nested scroll', emit: () => fireEvent.scroll(screen.getByTestId('scroller')) },
];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('tooltip cancellation lifecycle', () => {
  it.each(cancelEvents)('cancels a pending tooltip when $name occurs', ({ emit }) => {
    render(<Surface />); hover();
    act(() => vi.advanceTimersByTime(delay - 1));
    act(() => { emit(); });
    act(() => vi.advanceTimersByTime(delay));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(cancelEvents)('hides a visible tooltip when $name occurs', ({ emit }) => {
    render(<Surface />); hover();
    act(() => vi.advanceTimersByTime(delay));
    expect(screen.getByRole('tooltip').textContent).toBe('Model details');
    act(() => { emit(); });
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => vi.advanceTimersByTime(delay));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it.each([FLOATING_SURFACE_OPEN, MODAL_SURFACE_OPEN])('cancels the focus delay scheduled between pointerdown and click opening %s', eventName => {
    render(<Surface onClick={() => document.dispatchEvent(new CustomEvent(eventName))} />);
    const trigger = screen.getByRole('button', { name: 'Model' });
    hover();
    fireEvent.pointerDown(trigger);
    fireEvent.focus(trigger);
    expect(vi.getTimerCount()).toBe(1);
    fireEvent.pointerUp(trigger); fireEvent.click(trigger);
    act(() => vi.advanceTimersByTime(delay));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not register cancellation listeners for idle tooltips and removes active listeners on leave and unmount', () => {
    const docAdd = vi.spyOn(document, 'addEventListener'), docRemove = vi.spyOn(document, 'removeEventListener');
    const winAdd = vi.spyOn(window, 'addEventListener'), winRemove = vi.spyOn(window, 'removeEventListener');
    const watched = ['pointerdown', 'resize', 'wheel', 'scroll', FLOATING_SURFACE_OPEN, MODAL_SURFACE_OPEN];
    const mounted = render(<Surface />);
    const added = () => [...docAdd.mock.calls, ...winAdd.mock.calls].filter(([name]) => watched.includes(name));
    const removed = () => [...docRemove.mock.calls, ...winRemove.mock.calls].filter(([name]) => watched.includes(name));
    expect(added()).toHaveLength(0);
    hover();
    expect(added()).toHaveLength(6);
    fireEvent.focus(screen.getByRole('button', { name: 'Model' }));
    expect(added()).toHaveLength(6);
    fireEvent.pointerLeave(screen.getByRole('button', { name: 'Model' }));
    expect(removed()).toHaveLength(6);
    expect(vi.getTimerCount()).toBe(0);
    hover(); expect(added()).toHaveLength(12);
    mounted.unmount(); expect(removed()).toHaveLength(12);
    expect(vi.getTimerCount()).toBe(0);
    for (const [name, listener, options] of added()) {
      const capture = typeof options === 'boolean' ? options : options?.capture ?? false;
      expect(removed().some(([removedName, removedListener, removedOptions]) => removedName === name && removedListener === listener
        && (typeof removedOptions === 'boolean' ? removedOptions : removedOptions?.capture ?? false) === capture)).toBe(true);
    }
  });

  it('cleans up a visible tooltip on unmount and allows a new hover to show after cancellation', () => {
    const mounted = render(<Surface />); hover();
    fireEvent.scroll(screen.getByTestId('scroller'));
    hover(); act(() => vi.advanceTimersByTime(delay));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    mounted.unmount(); expect(screen.queryByRole('tooltip')).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
});
