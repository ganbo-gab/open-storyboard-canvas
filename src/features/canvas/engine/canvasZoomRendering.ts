export interface CanvasZoomRendering {
  /** Only retain the whole graph when it was already mounted at gesture start. */
  keepAllNodesRendered: boolean;
  simplifyNodes: boolean;
  /** Hold image pixels for retained far nodes until visibility culling has committed. */
  thumbnailZoom?: number;
}

export const IDLE_CANVAS_ZOOM_RENDERING: CanvasZoomRendering = {
  keepAllNodesRendered: false,
  simplifyNodes: false,
};

export const CANVAS_ZOOM_SETTLE_MS = 120;
export const CANVAS_NODE_DETAIL_ZOOM = 0.4;

interface ZoomRenderingScheduler {
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (handle: number) => void;
  requestAnimationFrame: (callback: () => void) => number;
  cancelAnimationFrame: (handle: number) => void;
}

interface ZoomRenderingOptions {
  initialZoom: number;
  /** Called once per gesture, not once per viewport frame. */
  canKeepAllNodesRendered: () => boolean;
  /** Pointer/native pan ownership survives long frames with no transform notification. */
  isViewportGestureActive?: () => boolean;
  publish: (rendering: CanvasZoomRendering) => void;
  scheduler: ZoomRenderingScheduler;
}

/**
 * Avoid LOD/culling remount storms during continuous viewport movement. A graph already entirely
 * mounted at far zoom can stay mounted cheaply; a close-up graph keeps normal visibility culling.
 * At rest, restore culling before lifting the detail override so offscreen nodes never upgrade.
 */
export function createCanvasZoomRendering({
  initialZoom,
  canKeepAllNodesRendered,
  isViewportGestureActive = () => false,
  publish,
  scheduler,
}: ZoomRenderingOptions): { observe: (zoom: number) => void; observePan: () => void; dispose: () => void } {
  let lastZoom = initialZoom;
  let active = false;
  let simplifyNodes = false;
  let thumbnailZoom: number | undefined;
  let disposed = false;
  let settleTimer: number | undefined;
  let releaseFrame: number | undefined;
  let settleVersion = 0;
  let releaseVersion = 0;
  let rendering = IDLE_CANVAS_ZOOM_RENDERING;

  const publishChanged = (next: CanvasZoomRendering) => {
    if (next.keepAllNodesRendered === rendering.keepAllNodesRendered
      && next.simplifyNodes === rendering.simplifyNodes
      && next.thumbnailZoom === rendering.thumbnailZoom) return;
    rendering = next;
    publish(next);
  };

  const cancelRelease = () => {
    releaseVersion += 1;
    if (releaseFrame === undefined) return;
    scheduler.cancelAnimationFrame(releaseFrame);
    releaseFrame = undefined;
  };

  const settle = () => {
    settleTimer = undefined;
    active = false;
    publishChanged({ keepAllNodesRendered: false, simplifyNodes, ...(thumbnailZoom === undefined ? {} : { thumbnailZoom }) });
    if (!simplifyNodes) return;
    // React Flow first commits onlyRenderVisibleElements and prunes the offscreen wrappers.
    const version = ++releaseVersion;
    releaseFrame = scheduler.requestAnimationFrame(() => {
      if (disposed || version !== releaseVersion) return;
      releaseFrame = scheduler.requestAnimationFrame(() => {
        if (disposed || version !== releaseVersion) return;
        releaseFrame = undefined;
        simplifyNodes = false;
        thumbnailZoom = undefined;
        publishChanged(IDLE_CANVAS_ZOOM_RENDERING);
      });
    });
  };

  const scheduleSettle = () => {
    if (settleTimer !== undefined) scheduler.clearTimeout(settleTimer);
    const version = ++settleVersion;
    settleTimer = scheduler.setTimeout(() => {
      if (disposed || version !== settleVersion) return;
      // A long frame can outlast the idle delay while the pointer is still down.
      // Keep the existing mounted graph until actual pan ownership has ended.
      if (isViewportGestureActive()) scheduleSettle();
      else settle();
    }, CANVAS_ZOOM_SETTLE_MS);
  };

  const observeMovement = (zoom: number, panOnly: boolean) => {
    if (disposed || (!panOnly && zoom === lastZoom)) return;
    const wasFar = lastZoom < CANVAS_NODE_DETAIL_ZOOM;
    const pendingDetailRelease = simplifyNodes && releaseFrame !== undefined;
    const previousZoom = lastZoom;
    lastZoom = zoom;
    cancelRelease();
    if (!active) {
      active = true;
      // Inspect the mounted graph only once, at a far gesture's start. Panning
      // a subset or a close-up must never mount the rest of the graph.
      const keepAllNodesRendered = wasFar && canKeepAllNodesRendered();
      simplifyNodes = pendingDetailRelease || keepAllNodesRendered
        || (!panOnly && (wasFar || zoom < CANVAS_NODE_DETAIL_ZOOM));
      thumbnailZoom = keepAllNodesRendered ? (pendingDetailRelease ? thumbnailZoom ?? previousZoom : previousZoom) : undefined;
      publishChanged({ keepAllNodesRendered, simplifyNodes, ...(thumbnailZoom === undefined ? {} : { thumbnailZoom }) });
    } else if (!panOnly && !simplifyNodes && zoom < CANVAS_NODE_DETAIL_ZOOM) {
      simplifyNodes = true;
      publishChanged({ keepAllNodesRendered: false, simplifyNodes: true });
    }
    scheduleSettle();
  };

  return {
    observe: (zoom) => observeMovement(zoom, false),
    observePan: () => observeMovement(lastZoom, true),
    dispose() {
      disposed = true;
      settleVersion += 1;
      if (settleTimer !== undefined) scheduler.clearTimeout(settleTimer);
      cancelRelease();
      publishChanged(IDLE_CANVAS_ZOOM_RENDERING);
    },
  };
}
