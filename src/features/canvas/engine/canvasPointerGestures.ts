import type { ReactFlowInstance } from '@xyflow/react';
import type { CanvasMouseClickAction, CanvasMouseDragAction } from '@/features/settings/canvasMouseSettings';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { useCanvasUiStore } from '../state/canvasUiStore';
import { getNodeIdFromTarget, isEditableTarget, isOverlayTarget, readSelectedText } from './domTargets';
import type { CanvasViewportGesture } from './canvasViewportGesture';
import { IS_MAC } from './shortcuts';

const DRAG_THRESHOLD = 4;
const DOUBLE_CLICK_MS = 400;
const BUTTON_NAMES = ['left', 'middle', 'right'] as const;
type ButtonName = typeof BUTTON_NAMES[number];
interface Click {
  button: ButtonName;
  x: number;
  y: number;
  time: number;
  target: EventTarget | null;
  action: CanvasMouseClickAction;
  doubleAction: CanvasMouseClickAction;
  additive: boolean;
}
interface Gesture extends Click {
  pointerId: number;
  drag: CanvasMouseDragAction;
  moved: boolean;
  lastX: number;
  lastY: number;
  initialSelection: string[];
}

function protectedTarget(target: EventTarget | null): boolean {
  const noPan = target instanceof Element ? target.closest('.nopan') : null;
  return isEditableTarget(target) || isOverlayTarget(target)
    // Flow marks every draggable node "nopan"; that excludes its own d3 panning,
    // not user-configured right/middle actions or temporary Space panning.
    || Boolean(noPan && !noPan.matches('.react-flow__node'))
    || (target instanceof Element && Boolean(target.closest('button, a, select, [role="button"], .react-flow__handle, .nodrag')));
}

/** Mouse ownership is decided at pointer-down; node editing remains React Flow's job.
 * The marquee only paints a DOM rectangle while moving, then selects once on release.
 * A thousand-node selection never writes graph state or history on every mouse event.
 */
export function installCanvasPointerGestures(
  wrapper: HTMLElement,
  flow: Pick<ReactFlowInstance, 'screenToFlowPosition' | 'getIntersectingNodes' | 'fitView'>,
  viewport: CanvasViewportGesture,
) {
  let gesture: Gesture | null = null;
  let previousClick: Click | null = null;
  let clickTimer: number | undefined;
  let marquee: HTMLDivElement | null = null;
  let recentRelease = -Infinity;

  const clearClick = () => {
    window.clearTimeout(clickTimer);
    clickTimer = undefined;
    previousClick = null;
  };
  const clearEdgeSelection = () => {
    const state = useCanvasStore.getState();
    state.onEdgesChange(state.edges.filter(edge => edge.selected).map(edge => ({ type: 'select', id: edge.id, selected: false })));
  };
  const executeClick = (click: Click, action: CanvasMouseClickAction) => {
    const ui = useCanvasUiStore.getState();
    const nodeId = getNodeIdFromTarget(click.target);
    const point = { x: click.x, y: click.y };
    if (action === 'nodeMenu') {
      const selectedText = readSelectedText(wrapper);
      if (nodeId && !selectedText && !useCanvasStore.getState().nodes.find(node => node.id === nodeId)?.selected) {
        useCanvasStore.getState().setSelectedNode(nodeId);
      }
      ui.openContextMenu({ clientX: click.x, clientY: click.y, flowPosition: flow.screenToFlowPosition(point), nodeId, selectedText: selectedText || undefined });
    } else if (action === 'quickCreate') {
      ui.openAddMenu({ clientX: click.x, clientY: click.y, flowPosition: flow.screenToFlowPosition(point) });
    } else if (action === 'fitView') {
      ui.closeMenus();
      void flow.fitView({ padding: 0.2, duration: 200 });
    } else if (action === 'selectNode') {
      ui.closeMenus();
      const state = useCanvasStore.getState();
      if (click.additive && nodeId) {
        const ids = state.nodes.filter(node => node.selected).map(node => node.id);
        state.setSelectedNodeIds(ids.includes(nodeId) ? ids.filter(id => id !== nodeId) : [...ids, nodeId]);
      } else if (!click.additive) { clearEdgeSelection(); state.setSelectedNodeIds(nodeId ? [nodeId] : []); }
    }
  };

  const click = (next: Click) => {
    const previous = previousClick;
    if (previous && previous.button === next.button && previous.target === next.target
      && next.time - previous.time <= DOUBLE_CLICK_MS
      && Math.hypot(next.x - previous.x, next.y - previous.y) < 6 && next.doubleAction !== 'none') {
      clearClick();
      executeClick(next, next.doubleAction);
      return;
    }
    // A pending single-click belongs to its original location, never the new one.
    if (previous && clickTimer !== undefined) executeClick(previous, previous.action);
    clearClick();
    previousClick = next;
    if (next.doubleAction !== 'none' && next.action !== 'selectNode' && next.action !== 'none') {
      clickTimer = window.setTimeout(() => { clearClick(); executeClick(next, next.action); }, DOUBLE_CLICK_MS);
    } else executeClick(next, next.action);
  };

  const drawMarquee = (active: Gesture, x: number, y: number) => {
    if (!marquee) {
      marquee = document.createElement('div');
      marquee.className = 'canvas-marquee';
      marquee.setAttribute('aria-hidden', 'true');
      wrapper.append(marquee);
    }
    const rect = wrapper.getBoundingClientRect();
    marquee.style.transform = `translate(${Math.min(active.x, x) - rect.left}px, ${Math.min(active.y, y) - rect.top}px)`;
    marquee.style.width = `${Math.abs(x - active.x)}px`;
    marquee.style.height = `${Math.abs(y - active.y)}px`;
  };
  const move = (event: PointerEvent) => {
    const active = gesture;
    if (!active || event.pointerId !== active.pointerId) return;
    if (!active.moved) {
      if (Math.hypot(event.clientX - active.x, event.clientY - active.y) < DRAG_THRESHOLD) return;
      active.moved = true;
      clearClick();
      window.getSelection()?.removeAllRanges();
      useCanvasUiStore.getState().closeMenus();
      if (active.drag === 'panCanvas') wrapper.dataset.panning = 'true';
    }
    event.preventDefault();
    event.stopPropagation();
    if (active.drag === 'panCanvas') {
      const current = viewport.currentViewport();
      viewport.schedule({ ...current, x: current.x + event.clientX - active.lastX, y: current.y + event.clientY - active.lastY });
    } else if (active.drag === 'selectionBox') drawMarquee(active, event.clientX, event.clientY);
    active.lastX = event.clientX;
    active.lastY = event.clientY;
  };
  const finish = () => {
    const finished = gesture;
    gesture = null;
    if (finished?.drag === 'panCanvas') viewport.finish();
    marquee?.remove(); marquee = null;
    delete wrapper.dataset.panning;
    if (finished) delete wrapper.dataset.pointerTransform;
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    return finished;
  };
  const up = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    move(event); // Include the final position even if the browser coalesced the last move.
    const finished = finish();
    if (!finished) return;
    recentRelease = event.timeStamp;
    event.preventDefault();
    event.stopPropagation();
    if (!finished.moved) {
      click({ ...finished, x: event.clientX, y: event.clientY, time: event.timeStamp });
    } else if (finished.drag === 'selectionBox') {
      const start = flow.screenToFlowPosition({ x: finished.x, y: finished.y });
      const end = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const width = Math.abs(end.x - start.x), height = Math.abs(end.y - start.y);
      // Flow treats a zero-area rectangle as contained by every node. A line is
      // an empty selection, never a request to select the entire project.
      const nodes = width > 0 && height > 0
        ? flow.getIntersectingNodes({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width, height }, true)
          .filter(node => !node.hidden && node.selectable !== false
            && (node.measured?.width ?? node.width ?? node.initialWidth ?? 0) > 0
            && (node.measured?.height ?? node.height ?? node.initialHeight ?? 0) > 0)
        : [];
      const ids = finished.additive ? [...finished.initialSelection] : [];
      for (const node of nodes) if (!ids.includes(node.id)) ids.push(node.id);
      if (!finished.additive) clearEdgeSelection();
      useCanvasStore.getState().setSelectedNodeIds(ids);
    }
  };
  const cancel = (event?: PointerEvent) => {
    if (event && gesture?.pointerId !== event.pointerId) return;
    finish(); clearClick();
  };
  const down = (event: PointerEvent) => {
    if (gesture || event.pointerType === 'touch' || protectedTarget(event.target)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const button = BUTTON_NAMES[IS_MAC && event.ctrlKey && event.button === 0 ? 2 : event.button];
    if (!button) return;
    const blank = target.matches('.react-flow__pane');
    const ui = useCanvasUiStore.getState();
    // Left-button node selection, dragging, text editing and connections remain native.
    if (button === 'left' && !blank && !ui.spacePan) return;
    const bindings = useSettingsStore.getState().canvasMouseBindings;
    let drag = bindings[`${button}Drag`];
    if (button === 'left') {
      if (ui.spacePan || ui.tool === 'hand') drag = 'panCanvas';
      else if (event.shiftKey) drag = 'selectionBox';
    }
    viewport.finish();
    event.preventDefault();
    event.stopPropagation();
    wrapper.focus({ preventScroll: true });
    wrapper.dataset.pointerTransform = '';
    gesture = { button, pointerId: event.pointerId, target: event.target,
      x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, time: event.timeStamp,
      action: ui.spacePan ? 'none' : bindings[`${button}Click`], doubleAction: ui.spacePan ? 'none' : bindings[`${button}DoubleClick`],
      drag, moved: false, additive: event.shiftKey || event.metaKey || (!IS_MAC && event.ctrlKey),
      initialSelection: useCanvasStore.getState().nodes.filter(node => node.selected).map(node => node.id) };
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
  };
  const suppressClick = (event: MouseEvent) => {
    if (protectedTarget(event.target)) return;
    const blank = event.target instanceof Element && event.target.matches('.react-flow__pane');
    if (blank || event.timeStamp - recentRelease < 50) { event.preventDefault(); event.stopPropagation(); }
  };
  const suppressOwnedMouseDown = (event: MouseEvent) => {
    if (gesture) { event.preventDefault(); event.stopPropagation(); }
  };
  const contextMenu = (event: MouseEvent) => {
    if (protectedTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    // Pointer menus are handled after release on both Windows and macOS. Keyboard menus
    // have no pointer gesture; preserve Shift+F10 / the dedicated context-menu key.
    if (!gesture && event.timeStamp - recentRelease > 1000 && event.button !== 2) {
      executeClick({ button: 'right', x: event.clientX, y: event.clientY, time: event.timeStamp, target: event.target,
        action: 'nodeMenu', doubleAction: 'none', additive: false }, 'nodeMenu');
    }
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cancel();
    else clearClick();
  };
  const leavingClickSequence = (event: PointerEvent) => {
    if (!(event.target instanceof Node) || !wrapper.contains(event.target) || protectedTarget(event.target)) clearClick();
  };
  const unsubscribeMenus = useCanvasUiStore.subscribe((state, previous) => {
    if (state.tool !== previous.tool || state.sheet !== previous.sheet || state.assetPanel !== previous.assetPanel
      || state.addMenu !== previous.addMenu || state.contextMenu !== previous.contextMenu) clearClick();
  });
  wrapper.addEventListener('pointerdown', down, true);
  wrapper.addEventListener('mousedown', suppressOwnedMouseDown, true);
  wrapper.addEventListener('click', suppressClick, true);
  wrapper.addEventListener('dblclick', suppressClick, true);
  wrapper.addEventListener('auxclick', suppressClick, true);
  wrapper.addEventListener('contextmenu', contextMenu, true);
  window.addEventListener('keydown', keyDown, true);
  window.addEventListener('pointerdown', leavingClickSequence, true);
  return {
    isActive: () => gesture !== null,
    cancel: () => cancel(),
    dispose: () => {
      cancel();
      unsubscribeMenus();
      wrapper.removeEventListener('pointerdown', down, true);
      wrapper.removeEventListener('mousedown', suppressOwnedMouseDown, true);
      wrapper.removeEventListener('click', suppressClick, true);
      wrapper.removeEventListener('dblclick', suppressClick, true);
      wrapper.removeEventListener('auxclick', suppressClick, true);
      wrapper.removeEventListener('contextmenu', contextMenu, true);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('pointerdown', leavingClickSequence, true);
    },
  };
}
