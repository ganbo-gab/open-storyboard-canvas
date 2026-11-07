import type { Viewport } from './viewportMath';

export const CANVAS_WHEEL_IDLE_MS = 120;

interface ViewportGestureOptions {
  readViewport(): Viewport;
  /** React Flow's zero-duration setViewport applies its transform synchronously. */
  applyViewport(viewport: Viewport): void;
  onStart(): void;
  onCommit(viewport: Viewport): void;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(handle: number): void;
}

const sameViewport = (left: Viewport, right: Viewport) => left.x === right.x && left.y === right.y && left.zoom === right.zoom;

export interface CanvasViewportGesture {
  isActive(): boolean;
  currentViewport(): Viewport;
  schedule(viewport: Viewport, wheel?: boolean): void;
  onMoveStart(): void;
  onMoveEnd(viewport: Viewport): void;
  finish(): void;
  dispose(): void;
}

/** Live transforms stay frame-paced; canonical state is committed once at the real gesture end. */
export function createCanvasViewportGesture(options: ViewportGestureOptions): CanvasViewportGesture {
  let active = false;
  let pending: Viewport | null = null;
  let frame: number | undefined;
  let idleTimer: number | undefined;
  let ownedEnd: Viewport | null = null;
  let disposed = false;
  const applyPending = () => {
    frame = undefined;
    const viewport = pending;
    pending = null;
    if (viewport) {
      ownedEnd = viewport;
      options.applyViewport(viewport);
    }
  };
  const finish = () => {
    if (idleTimer !== undefined) options.clearTimer(idleTimer);
    idleTimer = undefined;
    if (!active) return;
    if (frame !== undefined) options.cancelFrame(frame);
    applyPending();
    // Keep suppression active while the final transform emits its synchronous Flow callbacks.
    const viewport = options.readViewport();
    ownedEnd = viewport;
    active = false;
    options.onCommit(viewport);
  };
  return {
    isActive: () => active,
    currentViewport: () => pending ?? options.readViewport(),
    schedule(viewport: Viewport, wheel = false) {
      if (disposed) return;
      if (!active) { active = true; options.onStart(); }
      pending = viewport;
      if (frame === undefined) frame = options.requestFrame(applyPending);
      if (wheel) {
        if (idleTimer !== undefined) options.clearTimer(idleTimer);
        idleTimer = options.setTimer(finish, CANVAS_WHEEL_IDLE_MS);
      }
    },
    onMoveStart() { if (!active && !disposed) options.onStart(); },
    onMoveEnd(viewport: Viewport) {
      if (active || disposed) return;
      if (!sameViewport(viewport, options.readViewport())) return;
      // d3 schedules a zero-delay end after setViewport; finish already committed that transform.
      if (ownedEnd && sameViewport(ownedEnd, viewport)) { ownedEnd = null; return; }
      ownedEnd = null;
      options.onCommit(viewport);
    },
    finish,
    dispose() { finish(); disposed = true; },
  };
}
