import { useEffect, type RefObject } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';

import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { canvasNavigationFacade } from '@/features/canvas/application/canvasNavigationFacade';
import { isCustomCanvasViewportGestureActive } from '@/features/canvas/application/canvasViewportCommit';
import { useCanvasStore } from '@/stores/canvasStore';
import { useCanvasUiStore } from '@/features/canvas/state/canvasUiStore';
import { CANVAS_NODE_DETAIL_ZOOM, createCanvasZoomRendering } from './canvasZoomRendering';
import { resolveHandleScale, resolveInverseZoom } from './viewportMath';

/**
 * Connections between the mounted canvas and app-level services:
 * - navigation facade (Agent / dialogs ask the canvas to focus nodes);
 * - tool-dialog events from nodes;
 * - container size for placement maths in the store;
 * - `--canvas-ui-scale` (1 / zoom, clamped) and `--canvas-handle-scale` (resize handles, wider
 *   clamp) written straight to the DOM on every viewport change, so screen-constant chrome stays
 *   readable without a React render per frame.
 */
export function useCanvasBridges(wrapperRef: RefObject<HTMLElement | null>): void {
  const reactFlow = useReactFlow();
  const flowStore = useStoreApi();

  useEffect(() => canvasNavigationFacade.registerBridge({
    focusNodeIds: async (nodeIds, options) => {
      const wanted = new Set(nodeIds);
      const targets = reactFlow.getNodes().filter((node) => wanted.has(node.id));
      if (targets.length !== wanted.size) return false;
      if (options.select) useCanvasStore.getState().setSelectedNodeIds(nodeIds);
      return reactFlow.fitView({ nodes: targets, padding: options.padding, duration: 300 });
    },
  }), [reactFlow]);

  useEffect(() => {
    const { openToolDialog, closeToolDialog } = useCanvasStore.getState();
    const offOpen = canvasEventBus.subscribe('tool-dialog/open', (payload) => openToolDialog(payload));
    const offClose = canvasEventBus.subscribe('tool-dialog/close', () => closeToolDialog());
    return () => {
      offOpen();
      offClose();
    };
  }, []);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const { setCanvasViewportSize } = useCanvasStore.getState();
    const observer = new ResizeObserver(([entry]) => {
      setCanvasViewportSize({
        width: Math.max(0, Math.round(entry.contentRect.width)),
        height: Math.max(0, Math.round(entry.contentRect.height)),
      });
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [wrapperRef]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const initialTransform = flowStore.getState().transform;
    let lastX = initialTransform[0];
    let lastY = initialTransform[1];
    let observedZoom = initialTransform[2];
    let lastZoom = observedZoom;
    let farZoom = lastZoom < CANVAS_NODE_DETAIL_ZOOM;
    let promoted = farZoom;
    wrapper.toggleAttribute('data-far-zoom', promoted);
    const writePromotion = (rendering = useCanvasUiStore.getState().zoomRendering) => {
      // A retained far graph can cross into close-up before culling commits.
      // Keep its existing rasters until both the detail/pixel override releases.
      const next = farZoom || (rendering.simplifyNodes && rendering.thumbnailZoom !== undefined);
      if (next === promoted) return;
      promoted = next;
      wrapper.toggleAttribute('data-far-zoom', promoted);
    };
    let lastScale = resolveInverseZoom(lastZoom).toFixed(4);
    let lastHandleScale = resolveHandleScale(lastZoom).toFixed(4);
    wrapper.style.setProperty('--canvas-ui-scale', lastScale);
    wrapper.style.setProperty('--canvas-handle-scale', lastHandleScale);
    const writeScale = () => {
      // observe() can publish synchronously before lastZoom advances; the Flow
      // transform already contains the current scale in that notification.
      const zoom = flowStore.getState().transform[2];
      const scale = resolveInverseZoom(zoom).toFixed(4);
      const handleScale = resolveHandleScale(zoom).toFixed(4);
      if (handleScale !== lastHandleScale) {
        lastHandleScale = handleScale;
        wrapper.style.setProperty('--canvas-handle-scale', handleScale);
      }
      if (scale === lastScale) return;
      lastScale = scale;
      wrapper.style.setProperty('--canvas-ui-scale', scale);
    };
    const zoomRendering = createCanvasZoomRendering({
      initialZoom: lastZoom,
      canKeepAllNodesRendered: () => {
        const count = flowStore.getState().nodeLookup.size;
        return lastZoom < CANVAS_NODE_DETAIL_ZOOM && count > 0
          && wrapper.querySelectorAll('.react-flow__node').length === count;
      },
      isViewportGestureActive: () => isCustomCanvasViewportGestureActive()
        || wrapper.hasAttribute('data-panning') || flowStore.getState().paneDragging,
      publish: (rendering) => {
        useCanvasUiStore.getState().setZoomRendering(rendering);
        writePromotion(rendering);
        // Do not invalidate inherited chrome styles across the retained far-zoom graph.
        // Once culling has settled, restore the exact screen-constant scale at rest.
        if (!rendering.simplifyNodes) writeScale();
      },
      scheduler: {
        setTimeout: (callback, delay) => window.setTimeout(callback, delay),
        clearTimeout: (handle) => window.clearTimeout(handle),
        requestAnimationFrame: (callback) => requestAnimationFrame(callback),
        cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
      },
    });
    const write = ([x, y, zoom]: readonly number[]) => {
      const zoomChanged = zoom !== observedZoom;
      if (!zoomChanged && x === lastX && y === lastY) return;
      lastX = x;
      lastY = y;
      observedZoom = zoom;
      farZoom = zoom < CANVAS_NODE_DETAIL_ZOOM;
      if (zoomChanged) zoomRendering.observe(zoom);
      else zoomRendering.observePan();
      writePromotion();
      lastZoom = zoom;
      if (zoomChanged && !useCanvasUiStore.getState().zoomRendering.simplifyNodes) writeScale();
    };
    const unsubscribe = flowStore.subscribe((state) => write(state.transform));
    return () => {
      unsubscribe();
      zoomRendering.dispose();
      wrapper.removeAttribute('data-far-zoom');
    };
  }, [flowStore, wrapperRef]);
}
