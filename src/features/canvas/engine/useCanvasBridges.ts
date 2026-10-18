import { useEffect, type RefObject } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';

import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { canvasNavigationFacade } from '@/features/canvas/application/canvasNavigationFacade';
import { useCanvasStore } from '@/stores/canvasStore';
import { resolveInverseZoom } from './viewportMath';

/**
 * Connections between the mounted canvas and app-level services:
 * - navigation facade (Agent / dialogs ask the canvas to focus nodes);
 * - tool-dialog events from nodes;
 * - container size for placement maths in the store;
 * - `--canvas-ui-scale` (1 / zoom, clamped) written straight to the DOM on every viewport
 *   change, so screen-constant chrome stays readable without a React render per frame.
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
    let lastZoom = Number.NaN;
    const write = (zoom: number) => {
      if (zoom === lastZoom) return;
      lastZoom = zoom;
      wrapper.style.setProperty('--canvas-ui-scale', resolveInverseZoom(zoom).toFixed(4));
    };
    write(flowStore.getState().transform[2]);
    return flowStore.subscribe((state) => write(state.transform[2]));
  }, [flowStore, wrapperRef]);
}
