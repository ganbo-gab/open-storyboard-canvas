import { useCallback, useSyncExternalStore } from 'react';
import { useStoreApi } from '@xyflow/react';

import { useCanvasUiStore } from '@/features/canvas/state/canvasUiStore';
import { CANVAS_NODE_DETAIL_ZOOM } from './canvasZoomRendering';

/** Subscribe to the effective detail level, not each source's intermediate boolean. */
export function useCanvasNodeLevelOfDetail(): boolean {
  const flowStore = useStoreApi();
  const subscribe = useCallback((listener: () => void) => {
    const offFlow = flowStore.subscribe((state, previous) => { if ((state.transform[2] < CANVAS_NODE_DETAIL_ZOOM) !== (previous.transform[2] < CANVAS_NODE_DETAIL_ZOOM)) listener(); });
    const offUi = useCanvasUiStore.subscribe((state, previous) => { if (state.zoomRendering.simplifyNodes !== previous.zoomRendering.simplifyNodes) listener(); });
    return () => {
      offFlow();
      offUi();
    };
  }, [flowStore]);
  const snapshot = useCallback(() => (
    flowStore.getState().transform[2] < CANVAS_NODE_DETAIL_ZOOM || useCanvasUiStore.getState().zoomRendering.simplifyNodes
  ), [flowStore]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
