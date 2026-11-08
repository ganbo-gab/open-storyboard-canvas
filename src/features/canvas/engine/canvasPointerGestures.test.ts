// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCanvasPointerGestures } from './canvasPointerGestures';
import { createCanvasViewportGesture } from './canvasViewportGesture';
import type { Viewport } from './viewportMath';
import { useCanvasStore } from '@/stores/canvasStore';
import { useCanvasUiStore } from '../state/canvasUiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { DEFAULT_CANVAS_MOUSE_BINDINGS } from '@/features/settings/canvasMouseSettings';
import type { CanvasNode } from '../domain/canvasNodes';

class Pointer extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType = 'mouse';
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, { bubbles: true, cancelable: true, ...init });
    this.pointerId = init.pointerId ?? 1;
  }
}
const node = (id: string, x = 0): CanvasNode => ({ id, type: 'textAnnotationNode', position: { x, y: 0 }, data: { content: id }, measured: { width: 100, height: 100 } });
let teardown: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  useSettingsStore.setState({ canvasMouseBindings: { ...DEFAULT_CANVAS_MOUSE_BINDINGS } });
  useCanvasUiStore.getState().reset();
  useCanvasStore.setState({ nodes: [node('one'), node('two', 200)], edges: [], selectedNodeId: null });
});
afterEach(() => { teardown?.(); document.body.replaceChildren(); vi.useRealTimers(); });
function setup(zoom = 1) {
  const wrapper = document.createElement('div');
  wrapper.tabIndex = -1;
  wrapper.innerHTML = '<div class="react-flow__pane"></div><div class="react-flow__node nopan" data-id="one"><span>node</span><button>edit</button><input /><div contenteditable="true">text</div><span class="react-flow__handle"></span></div><div data-canvas-overlay><button>overlay</button></div>';
  document.body.append(wrapper);
  const pane = wrapper.firstElementChild!;
  let viewport: Viewport = { x: 30, y: 40, zoom };
  const commit = vi.fn();
  const camera = createCanvasViewportGesture({ readViewport: () => viewport, applyViewport: next => { viewport = next; }, onStart: vi.fn(), onCommit: commit,
    requestFrame: callback => window.setTimeout(callback, 16), cancelFrame: window.clearTimeout,
    setTimer: window.setTimeout, clearTimer: window.clearTimeout });
  const intersects = vi.fn(() => [useCanvasStore.getState().nodes[1]]);
  const fit = vi.fn(async () => true);
  const owner = installCanvasPointerGestures(wrapper, { screenToFlowPosition: p => ({ x: (p.x - viewport.x) / viewport.zoom, y: (p.y - viewport.y) / viewport.zoom }),
    getIntersectingNodes: intersects, fitView: fit }, camera);
  teardown = () => { owner.dispose(); camera.dispose(); };
  const send = (type: string, button: number, x: number, y: number, target: EventTarget = pane, extra: PointerEventInit = {}) => {
    const event = new Pointer(type, { button, clientX: x, clientY: y, ...extra });
    target.dispatchEvent(event); return event;
  };
  const click = (button = 0, x = 100, y = 100, target: EventTarget = pane) => { send('pointerdown', button, x, y, target); send('pointerup', button, x, y, window); };
  return { wrapper, pane, send, click, camera, commit, owner, intersects, fit, viewport: () => viewport };
}
describe('configurable canvas mouse interactions', () => {
  it('moves focus out of an editor when a canvas gesture takes over', () => {
    const surface = setup();
    const input = surface.wrapper.querySelector('input')!;
    input.focus(); expect(document.activeElement).toBe(input);
    surface.send('pointerdown', 0, 100, 100);
    expect(document.activeElement).toBe(surface.wrapper);
    surface.send('pointerup', 0, 100, 100, window);
  });
  it('clears node and edge multi-selection on blank click and replaces edges on marquee', () => {
    const surface = setup();
    useCanvasStore.getState().setSelectedNodeIds(['one', 'two']);
    useCanvasStore.setState({ edges: [{ id: 'edge', source: 'one', target: 'two', selected: true }] });
    surface.click();
    expect(useCanvasStore.getState().nodes.some(n => n.selected)).toBe(false);
    expect(useCanvasStore.getState().edges.some(e => e.selected)).toBe(false);
    useCanvasStore.setState({ edges: [{ id: 'edge', source: 'one', target: 'two', selected: true }] });
    surface.send('pointerdown', 2, 100, 100); surface.send('pointerup', 2, 300, 300, window);
    expect(useCanvasStore.getState().edges.some(e => e.selected)).toBe(false);
    expect(useCanvasStore.getState().nodes.filter(n => n.selected).map(n => n.id)).toEqual(['two']);
  });
  it('pans on left blank drag, commits once, and never selects or opens a menu', () => {
    const surface = setup();
    surface.send('pointerdown', 0, 100, 100);
    for (let i = 1; i <= 10; i++) { surface.send('pointermove', 0, 100 + i * 10, 100 + i * 5, window); vi.advanceTimersByTime(16); }
    expect(surface.commit).not.toHaveBeenCalled();
    surface.send('pointerup', 0, 215, 155, window);
    expect(surface.viewport()).toEqual({ x: 145, y: 95, zoom: 1 });
    expect(surface.commit).toHaveBeenCalledOnce();
    expect(surface.intersects).not.toHaveBeenCalled();
    expect(useCanvasUiStore.getState()).toMatchObject({ addMenu: null, contextMenu: null });
  });
  it.each([0.1, 1, 4])('right drag selects once at zoom %s without panning or a release menu', zoom => {
    const surface = setup(zoom);
    surface.send('pointerdown', 2, 130, 140);
    surface.send('pointermove', 2, 230, 240, window);
    expect(surface.intersects).not.toHaveBeenCalled();
    expect(surface.wrapper.querySelector('.canvas-marquee')).not.toBeNull();
    surface.send('pointerup', 2, 330, 340, window);
    expect(surface.intersects).toHaveBeenCalledExactlyOnceWith({ x: 100 / zoom, y: 100 / zoom, width: 200 / zoom, height: 200 / zoom }, true);
    expect(useCanvasStore.getState().nodes.filter(n => n.selected).map(n => n.id)).toEqual(['two']);
    expect(surface.commit).not.toHaveBeenCalled();
    expect(surface.wrapper.querySelector('.canvas-marquee')).toBeNull();
    expect(useCanvasUiStore.getState().contextMenu).toBeNull();
    surface.pane.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    expect(useCanvasUiStore.getState().contextMenu).toBeNull();
  });
  it.each([[300, 100], [100, 300]])('does not select every node for a zero-area marquee to %s,%s', (x, y) => {
    const surface = setup();
    useCanvasStore.getState().setSelectedNodeIds(['one']);
    surface.send('pointerdown', 2, 100, 100); surface.send('pointerup', 2, x, y, window);
    expect(surface.intersects).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes.some(n => n.selected)).toBe(false);
  });
  it('opens the right click menu on release, preserving an existing node multi-selection', () => {
    const surface = setup();
    useCanvasStore.getState().setSelectedNodeIds(['one', 'two']);
    const node = surface.wrapper.querySelector('[data-id="one"] span')!;
    surface.send('pointerdown', 2, 120, 120, node);
    surface.pane.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    expect(useCanvasUiStore.getState().contextMenu).toBeNull();
    surface.send('pointerup', 2, 121, 121, window);
    expect(useCanvasUiStore.getState().contextMenu).toMatchObject({ nodeId: 'one', clientX: 121 });
    expect(useCanvasStore.getState().nodes.filter(n => n.selected)).toHaveLength(2);
  });
  it('double-clicks blank canvas to quick create while hand is selected', () => {
    const surface = setup(0.1);
    useCanvasUiStore.getState().setTool('hand');
    surface.click(); vi.advanceTimersByTime(80); surface.click();
    expect(useCanvasUiStore.getState().addMenu).toMatchObject({ clientX: 100, clientY: 100, flowPosition: { x: 700, y: 600 } });
    expect(surface.viewport()).toEqual({ x: 30, y: 40, zoom: 0.1 });
  });
  it('keeps hand-tool node interactions and all controls available to their own handlers', () => {
    const surface = setup(); useCanvasUiStore.getState().setTool('hand');
    for (const selector of ['[data-id="one"] span', 'button', 'input', '[contenteditable]', '.react-flow__handle', '[data-canvas-overlay]']) {
      const target = surface.wrapper.querySelector(selector)!;
      expect(surface.send('pointerdown', 0, 100, 100, target).defaultPrevented).toBe(false);
      expect(surface.owner.isActive()).toBe(false);
    }
    for (const selector of ['button', 'input', '[contenteditable]', '.react-flow__handle', '[data-canvas-overlay]']) {
      expect(surface.send('pointerdown', 2, 100, 100, surface.wrapper.querySelector(selector)!).defaultPrevented).toBe(false);
    }
  });
  it('distinguishes custom right double-click from single-click without opening a competing menu', () => {
    const surface = setup();
    useSettingsStore.setState({ canvasMouseBindings: { ...DEFAULT_CANVAS_MOUSE_BINDINGS, rightDoubleClick: 'quickCreate' } });
    surface.click(2); expect(useCanvasUiStore.getState().contextMenu).toBeNull();
    vi.advanceTimersByTime(100); surface.click(2); vi.advanceTimersByTime(500);
    expect(useCanvasUiStore.getState().addMenu).not.toBeNull();
    expect(useCanvasUiStore.getState().contextMenu).toBeNull();
    useCanvasUiStore.getState().closeMenus();
    surface.click(2); vi.advanceTimersByTime(401);
    expect(useCanvasUiStore.getState().contextMenu).not.toBeNull();
  });
  it('discards a delayed click when the user moves on to a control or another surface', () => {
    const surface = setup();
    useSettingsStore.setState({ canvasMouseBindings: { ...DEFAULT_CANVAS_MOUSE_BINDINGS, rightDoubleClick: 'quickCreate' } });
    for (const target of [surface.wrapper.querySelector('button')!, document.body]) {
      surface.click(2);
      surface.send('pointerdown', 0, 30, 40, target);
      vi.advanceTimersByTime(500);
      expect(useCanvasUiStore.getState().contextMenu).toBeNull();
    }
  });
  it('honors a changed middle button mapping and disabled left actions immediately', () => {
    const surface = setup();
    useSettingsStore.setState({ canvasMouseBindings: { ...DEFAULT_CANVAS_MOUSE_BINDINGS, middleClick: 'fitView', middleDrag: 'selectionBox', leftClick: 'none', leftDoubleClick: 'none', leftDrag: 'none' } });
    surface.click(1); expect(surface.fit).toHaveBeenCalledOnce();
    surface.send('pointerdown', 0, 100, 100); surface.send('pointerup', 0, 300, 300, window);
    expect(surface.viewport()).toEqual({ x: 30, y: 40, zoom: 1 });
    surface.send('pointerdown', 1, 100, 100); surface.send('pointerup', 1, 300, 300, window);
    expect(surface.intersects).toHaveBeenCalledOnce();
  });
  it('adds marquee matches with Shift and cancels selection on Escape/blur without a stale popup', () => {
    const surface = setup(); useCanvasStore.getState().setSelectedNodeIds(['one']);
    surface.send('pointerdown', 2, 100, 100, surface.pane, { shiftKey: true }); surface.send('pointerup', 2, 300, 300, window);
    expect(useCanvasStore.getState().nodes.filter(n => n.selected).map(n => n.id)).toEqual(['one', 'two']);
    for (const ending of ['Escape', 'cancel']) {
      surface.send('pointerdown', 2, 100, 100); surface.send('pointermove', 2, 200, 200, window);
      if (ending === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); else surface.owner.cancel();
      surface.send('pointerup', 2, 200, 200, window);
      expect(surface.wrapper.querySelector('.canvas-marquee')).toBeNull();
      expect(surface.owner.isActive()).toBe(false);
      expect(useCanvasUiStore.getState().contextMenu).toBeNull();
    }
  });
});
