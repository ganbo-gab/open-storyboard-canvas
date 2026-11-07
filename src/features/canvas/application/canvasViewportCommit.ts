/** Mounted viewport owner only; project transitions flush it before taking their final snapshot. */
let activeOwner: { flush: () => void; isActive: () => boolean; isNativeActive: () => boolean } | null = null;

export function registerCanvasViewportFlush(flush: () => void, isActive: () => boolean = () => false, isNativeActive: () => boolean = () => false): () => void {
  const owner = { flush, isActive, isNativeActive };
  activeOwner = owner;
  return () => { if (activeOwner === owner) activeOwner = null; };
}

export function flushPendingCanvasViewport(): void {
  activeOwner?.flush();
}

/** True only during our custom pointer/wheel transform session; native Flow gestures are unchanged. */
export function isCustomCanvasViewportGestureActive(): boolean {
  return activeOwner?.isActive() ?? false;
}

/** Query the mounted Flow owner without broadcasting pointer frames to React. */
export function isCanvasViewportInteractionActive(): boolean {
  return Boolean(activeOwner && (activeOwner.isActive() || activeOwner.isNativeActive()));
}
