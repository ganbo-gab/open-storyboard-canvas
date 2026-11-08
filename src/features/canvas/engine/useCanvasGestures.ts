import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';

import { useSettingsStore } from '@/stores/settingsStore';
import { useCanvasUiStore } from '@/features/canvas/state/canvasUiStore';
import {
  createWheelClassifier,
  resolveWheelIntent,
  zoomAround,
  type Viewport,
} from './viewportMath';
import { isEditableTarget, isOverlayTarget } from './domTargets';
import { installCanvasPointerGestures } from './canvasPointerGestures';
import { clearAlignmentSession, setAlignmentSnapDisabled } from './alignment';
import { IS_MAC } from './shortcuts';
import { createCanvasViewportGesture, type CanvasViewportGesture } from './canvasViewportGesture';
import { registerCanvasViewportFlush } from '../application/canvasViewportCommit';

/** True when the wheel should scroll a nested element rather than move the canvas. */
function canScrollNatively(target: EventTarget | null, root: HTMLElement, dx: number, dy: number): boolean {
  let element = target instanceof Element ? target : null;
  while (element && element !== root) {
    if (element instanceof HTMLElement) {
      const style = getComputedStyle(element);
      const scrollsY = /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
      const scrollsX = /(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
      if (scrollsY && dy !== 0) {
        const atTop = element.scrollTop <= 0;
        const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
        if ((dy < 0 && !atTop) || (dy > 0 && !atBottom)) return true;
      }
      if (scrollsX && dx !== 0) {
        const atLeft = element.scrollLeft <= 0;
        const atRight = element.scrollLeft + element.clientWidth >= element.scrollWidth - 1;
        if ((dx < 0 && !atLeft) || (dx > 0 && !atRight)) return true;
      }
    }
    element = element.parentElement;
  }
  return false;
}

/**
 * Owns every viewport gesture React Flow does not handle well for a creative canvas:
 * - wheel: trackpad scroll pans, pinch / ⌘-wheel zooms, mouse wheel follows the setting;
 * - configurable pointer actions share one owner, separated from native node editing;
 * - Space provides temporary panning without permanently disabling node controls.
 */
const noViewportCommit = (_viewport: Viewport) => {};
const noViewportStart = () => {};

export function useCanvasGestures(wrapperRef: RefObject<HTMLDivElement | null>, {
  onViewportCommit = noViewportCommit,
  onViewportStart = noViewportStart,
}: { onViewportCommit?: (viewport: Viewport) => void; onViewportStart?: () => void } = {}) {
  const reactFlow = useReactFlow();
  const flowStore = useStoreApi();
  const viewportGestureRef = useRef<CanvasViewportGesture | null>(null);
  const onMoveStart = useCallback(() => viewportGestureRef.current?.onMoveStart(), []);
  const onMoveEnd = useCallback((viewport: Viewport) => viewportGestureRef.current?.onMoveEnd(viewport), []);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const classifier = createWheelClassifier();
    const viewportGesture = createCanvasViewportGesture({
      readViewport: reactFlow.getViewport,
      applyViewport: (viewport) => { void reactFlow.setViewport(viewport); },
      onStart: () => { wrapper.dataset.viewportTransform = ''; onViewportStart(); },
      onCommit: (viewport) => { delete wrapper.dataset.viewportTransform; onViewportCommit(viewport); },
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: cancelAnimationFrame,
      setTimer: (callback, delay) => window.setTimeout(callback, delay),
      clearTimer: (handle) => window.clearTimeout(handle),
    });
    viewportGestureRef.current = viewportGesture;
    const unregisterViewportFlush = registerCanvasViewportFlush(viewportGesture.finish, viewportGesture.isActive, () => flowStore.getState().paneDragging);
    const currentViewport = viewportGesture.currentViewport;
    const pointerGestures = installCanvasPointerGestures(wrapper, reactFlow, viewportGesture);

    const handleWheel = (event: WheelEvent) => {
      if (pointerGestures.isActive()) { event.preventDefault(); return; }
      const marker = event.target instanceof Element
        ? event.target.closest('.nowheel, [data-canvas-wheel="native"]')
        : null;
      if (marker && wrapper.contains(marker)) {
        // Owned by an embedded viewer/editor. Only stop the browser's page zoom on pinch.
        if (event.ctrlKey) event.preventDefault();
        return;
      }
      if (isOverlayTarget(event.target)) return;
      if (!event.ctrlKey && !event.metaKey && canScrollNatively(event.target, wrapper, event.deltaX, event.deltaY)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const legacy = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
      const sample = {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        wheelDeltaY: typeof legacy === 'number' ? legacy : 0,
        timeStamp: event.timeStamp,
      };
      const device = classifier.classify(sample);
      const wheelMode = useSettingsStore.getState().canvasWheelMode;
      const intent = resolveWheelIntent(sample, device, wheelMode, wrapper.clientHeight);
      const viewport = currentViewport();

      if (intent.kind === 'pan') {
        if (intent.dx === 0 && intent.dy === 0) return;
        viewportGesture.schedule({ ...viewport, x: viewport.x + intent.dx, y: viewport.y + intent.dy }, true);
        return;
      }
      const rect = wrapper.getBoundingClientRect();
      const { minZoom, maxZoom } = flowStore.getState();
      const next = zoomAround(
        viewport,
        intent.factor,
        event.clientX - rect.left,
        event.clientY - rect.top,
        minZoom,
        maxZoom
      );
      if (next !== viewport) viewportGesture.schedule(next, true);
    };

    let primaryPointer: number | null = null;

    const finishPrimaryTransform = (event?: PointerEvent) => {
      if (primaryPointer === null || (event && event.pointerId !== primaryPointer)) return;
      if (event?.type === 'pointercancel') clearAlignmentSession();
      primaryPointer = null;
      window.removeEventListener('pointerup', finishPrimaryTransform, true);
      window.removeEventListener('pointercancel', finishPrimaryTransform, true);
      if (!pointerGestures.isActive()) delete wrapper.dataset.pointerTransform;
    };

    const handlePointerDown = (event: PointerEvent) => {
      viewportGesture.finish();
      setAlignmentSnapDisabled(IS_MAC ? event.metaKey : event.ctrlKey);
      if (pointerGestures.isActive()) return;
      if (event.button === 0) {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || isOverlayTarget(target) || isEditableTarget(target)
          || target.closest('.nodrag, .react-flow__handle, button, input, textarea, select, a')) return;
        if (!target.closest('.react-flow__node, .react-flow__nodesselection-rect')
          && !target.matches('.react-flow__pane')) return;
        primaryPointer = event.pointerId;
        wrapper.dataset.pointerTransform = '';
        window.addEventListener('pointerup', finishPrimaryTransform, true);
        window.addEventListener('pointercancel', finishPrimaryTransform, true);
        return;
      }
    };

    const finishPointerInteraction = () => {
      clearAlignmentSession();
      setAlignmentSnapDisabled(false);
      pointerGestures.cancel();
      finishPrimaryTransform();
      delete wrapper.dataset.viewportTransform;
    };

    // Flush a pending wheel frame before another control/keyboard action can navigate or fit-view.
    const flushBeforeAction = () => { if (!pointerGestures.isActive()) viewportGesture.finish(); };

    const handleAlignmentModifier = (event: PointerEvent | KeyboardEvent) => setAlignmentSnapDisabled(IS_MAC ? event.metaKey : event.ctrlKey);
    window.addEventListener('pointermove', handleAlignmentModifier, true);
    window.addEventListener('keydown', handleAlignmentModifier, true);
    window.addEventListener('keyup', handleAlignmentModifier, true);
    window.addEventListener('pointerdown', flushBeforeAction, true);
    window.addEventListener('keydown', flushBeforeAction, true);
    window.addEventListener('pagehide', finishPointerInteraction);
    wrapper.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    wrapper.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('blur', finishPointerInteraction);
    return () => {
      pointerGestures.dispose();
      unregisterViewportFlush();
      viewportGesture.dispose();
      delete wrapper.dataset.viewportTransform;
      if (viewportGestureRef.current === viewportGesture) viewportGestureRef.current = null;
      finishPrimaryTransform();
      wrapper.removeEventListener('wheel', handleWheel, true);
      wrapper.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('blur', finishPointerInteraction);
      clearAlignmentSession();
      window.removeEventListener('pointermove', handleAlignmentModifier, true);
      window.removeEventListener('keydown', handleAlignmentModifier, true);
      window.removeEventListener('keyup', handleAlignmentModifier, true);
      window.removeEventListener('pointerdown', flushBeforeAction, true);
      window.removeEventListener('keydown', flushBeforeAction, true);
      window.removeEventListener('pagehide', finishPointerInteraction);
    };
  }, [flowStore, onViewportCommit, onViewportStart, reactFlow, wrapperRef]);

  // Space is temporary. Pointer ownership is sampled when the next drag begins.
  useEffect(() => {
    const setSpacePan = useCanvasUiStore.getState().setSpacePan;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || isEditableTarget(event.target)) return;
      setSpacePan(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpacePan(false);
    };
    const handleBlur = () => setSpacePan(false);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  return { onMoveStart, onMoveEnd };
}
