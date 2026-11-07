// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MenuSurface, PopoverSurface, anchorAbove, type MenuAnchor } from './Menu';
import { UiSelect } from './primitives';
import { MODAL_SURFACE_OPEN } from './floatingSurfaces';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let frames: Map<number, FrameRequestCallback>;
let sequence = 0;
beforeEach(() => {
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function click(element: HTMLElement) { fireEvent.pointerDown(element); fireEvent.pointerUp(element); fireEvent.click(element); }
function frame() { act(() => { const current = [...frames.values()]; frames.clear(); for (const callback of current) callback(0); }); }
function Surface() {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [child, setChild] = useState('one');
  return <><div data-node-overlay-owner="owner"><button onClick={event => setAnchor(anchor ? null : anchorAbove(event.currentTarget))}>Toggle model</button></div>
    <div className="react-flow__node" data-id="owner">Drag owner</div><button>Outside</button>
    {anchor && <PopoverSurface anchor={anchor} label="Parameters" onClose={() => setAnchor(null)}><UiSelect aria-label="Quality" value={child} onChange={event => setChild(event.target.value)}><option value="one">One</option><option value="two">Two</option></UiSelect></PopoverSurface>}
  </>;
}
it('closes on the second trigger click, stays closed until another click, and dismisses outside', () => {
  render(<Surface />);
  const trigger = screen.getByRole('button', { name: 'Toggle model' });
  click(trigger); expect(screen.getByRole('dialog', { name: 'Parameters' })).toBeTruthy();
  click(trigger); expect(screen.queryByRole('dialog')).toBeNull();
  click(trigger); expect(screen.getByRole('dialog')).toBeTruthy();
  click(screen.getByRole('button', { name: 'Outside' })); expect(screen.queryByRole('dialog')).toBeNull();
});
it('follows the live trigger during owner dragging and closes when that trigger is removed', () => {
  render(<Surface />);
  const trigger = screen.getByRole('button', { name: 'Toggle model' });
  let rect = new DOMRect(100, 350, 80, 30);
  vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => rect);
  click(trigger);
  const menu = screen.getByRole('dialog');
  expect(menu.style.left).toBe('100px');
  fireEvent.pointerDown(screen.getByText('Drag owner'));
  expect(screen.getByRole('dialog')).toBe(menu);
  rect = new DOMRect(230, 410, 80, 30); frame();
  expect(menu.style.left).toBe('230px'); expect(menu.style.top).toBe('404px');
  trigger.remove(); frame(); expect(screen.queryByRole('dialog')).toBeNull();
});
it('keeps a parent open for its nested select and lets Escape dismiss only the child first', () => {
  render(<Surface />); click(screen.getByRole('button', { name: 'Toggle model' }));
  click(screen.getByRole('button', { name: 'Quality' }));
  expect(screen.getByRole('listbox')).toBeTruthy(); expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull(); expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull();
});
it('replaces sibling menus while a coordinate context menu keeps its original anchor', () => {
  function Siblings() {
    const [a, setA] = useState<MenuAnchor | null>(null), [b, setB] = useState<MenuAnchor | null>(null);
    return <><button onClick={event => setA(a ? null : anchorAbove(event.currentTarget))}>First</button><button onClick={event => setB(b ? null : anchorAbove(event.currentTarget))}>Second</button>
      {a && <MenuSurface anchor={a} label="A" onClose={() => setA(null)}>A content</MenuSurface>}
      {b && <MenuSurface anchor={b} label="B" onClose={() => setB(null)}>B content</MenuSurface>}</>;
  }
  render(<Siblings />); click(screen.getByRole('button', { name: 'First' })); click(screen.getByRole('button', { name: 'Second' }));
  expect(screen.queryByRole('menu', { name: 'A' })).toBeNull(); expect(screen.getByRole('menu', { name: 'B' })).toBeTruthy();
});

it('commits a nested select option without dismissing its parent and closes the child on a second trigger click', () => {
  render(<Surface />); click(screen.getByRole('button', { name: 'Toggle model' }));
  const parent = screen.getByRole('dialog', { name: 'Parameters' });
  click(screen.getByRole('button', { name: 'Quality' }));
  click(screen.getByRole('option', { name: 'Two' }));
  expect(screen.getByRole('dialog', { name: 'Parameters' })).toBe(parent);
  expect(screen.getByRole('button', { name: 'Quality' }).textContent).toContain('Two');
  expect(screen.queryByRole('listbox')).toBeNull();
  click(screen.getByRole('button', { name: 'Quality' }));
  expect(screen.getByRole('listbox')).toBeTruthy();
  click(screen.getByRole('button', { name: 'Quality' }));
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Parameters' })).toBe(parent);
});

it('replaces sibling selectors inside the same parent and dismisses the full stack outside', () => {
  function SiblingSelects() {
    const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
    return <><button onClick={event => setAnchor(anchor ? null : anchorAbove(event.currentTarget))}>Open settings</button><button>Outside settings</button>
      {anchor && <PopoverSurface anchor={anchor} label="Settings" onClose={() => setAnchor(null)}>
        <UiSelect aria-label="First setting" defaultValue="one"><option value="one">One</option></UiSelect>
        <UiSelect aria-label="Second setting" defaultValue="two"><option value="two">Two</option></UiSelect>
      </PopoverSurface>}</>;
  }
  render(<SiblingSelects />); click(screen.getByRole('button', { name: 'Open settings' }));
  click(screen.getByRole('button', { name: 'First setting' }));
  expect(screen.getByRole('listbox', { name: 'First setting' })).toBeTruthy();
  click(screen.getByRole('button', { name: 'Second setting' }));
  expect(screen.queryByRole('listbox', { name: 'First setting' })).toBeNull();
  expect(screen.getByRole('listbox', { name: 'Second setting' })).toBeTruthy();
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  click(screen.getByRole('button', { name: 'Outside settings' }));
  expect(screen.queryByRole('listbox')).toBeNull(); expect(screen.queryByRole('dialog')).toBeNull();
});

it('stops tracking closed surfaces and cleans up both parent and nested selector animation frames', () => {
  const mounted = render(<Surface />);
  const trigger = screen.getByRole('button', { name: 'Toggle model' });
  const read = vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 350, 80, 30));
  click(trigger);
  expect(frames.size).toBe(1);
  click(screen.getByRole('button', { name: 'Quality' }));
  expect(frames.size).toBe(2);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(frames.size).toBe(1);
  frame(); expect(frames.size).toBe(1);
  click(trigger); expect(frames.size).toBe(0);
  const before = read.mock.calls.length;
  frame(); expect(read).toHaveBeenCalledTimes(before);
  click(trigger); click(screen.getByRole('button', { name: 'Quality' }));
  expect(frames.size).toBe(2);
  mounted.unmount(); expect(frames.size).toBe(0);
});

it('updates nested selector placement as its live trigger moves and resizes without a scroll event', () => {
  render(<Surface />); click(screen.getByRole('button', { name: 'Toggle model' }));
  const trigger = screen.getByRole('button', { name: 'Quality' });
  let rect = new DOMRect(100, 150, 120, 32);
  vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => rect);
  click(trigger);
  const list = screen.getByRole('listbox');
  expect(list.style.left).toBe('100px'); expect(list.style.minWidth).toBe('120px');
  rect = new DOMRect(250, 280, 180, 32); frame();
  expect(list.style.left).toBe('250px'); expect(list.style.top).toBe('318px'); expect(list.style.minWidth).toBe('180px');
});

it('closes parent and child surfaces when a modal opens without leaking their tracking frames', () => {
  render(<Surface />); click(screen.getByRole('button', { name: 'Toggle model' }));
  click(screen.getByRole('button', { name: 'Quality' }));
  expect(frames.size).toBe(2);
  act(() => document.dispatchEvent(new CustomEvent(MODAL_SURFACE_OPEN)));
  expect(screen.queryByRole('listbox')).toBeNull(); expect(screen.queryByRole('dialog')).toBeNull(); expect(frames.size).toBe(0);
});

it('places a select above its trigger using the actual list height and preserves the gap', () => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.getAttribute('role') === 'listbox' ? 114 : 0; });
  render(<UiSelect aria-label="Actual height" defaultValue="one"><option value="one">One</option><option value="two">Two</option><option value="three">Three</option></UiSelect>);
  const trigger = screen.getByRole('button', { name: 'Actual height' });
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 700, 120, 32));
  click(trigger);
  const list = screen.getByRole('listbox');
  expect(list.getAttribute('data-placement')).toBe('top');
  expect(list.style.top).toBe('580px');
});
