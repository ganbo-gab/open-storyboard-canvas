import type { CanvasWheelMode } from '@/stores/settingsStore';

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface WheelSample {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** Legacy WebKit/Blink field; 0 when unavailable. */
  wheelDeltaY: number;
  timeStamp: number;
}

export type WheelDevice = 'trackpad' | 'mouse';

export type WheelIntent =
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'zoom'; factor: number };

/** Events closer than this belong to one gesture and keep the first event's device guess. */
const WHEEL_BURST_MS = 180;
const LINE_HEIGHT_PX = 16;
const MOUSE_ZOOM_BASE = 1.0013;
const PINCH_ZOOM_RATE = 0.012;
/** One mouse notch never zooms more than this, whatever the platform reports. */
const MAX_STEP_FACTOR = 1.6;

export interface WheelClassifier {
  classify(sample: WheelSample): WheelDevice;
}

/**
 * Trackpads emit many small, often fractional deltas (and horizontal components);
 * a mouse notch reports a legacy `wheelDelta` that is a multiple of 120 and does not
 * follow the trackpad's `wheelDelta === -3 * deltaY` signature. The first event of a
 * burst decides; the rest of the burst inherits it so momentum never flips modes.
 */
export function createWheelClassifier(): WheelClassifier {
  let lastTime = Number.NEGATIVE_INFINITY;
  let lastDevice: WheelDevice = 'trackpad';
  return {
    classify(sample) {
      const withinBurst = sample.timeStamp - lastTime < WHEEL_BURST_MS;
      lastTime = sample.timeStamp;
      if (withinBurst) return lastDevice;
      lastDevice = guessWheelDevice(sample);
      return lastDevice;
    },
  };
}

export function guessWheelDevice(sample: WheelSample): WheelDevice {
  if (sample.deltaMode !== 0) return 'mouse';
  if (sample.deltaX !== 0 && !sample.shiftKey) return 'trackpad';
  const legacy = sample.wheelDeltaY;
  if (legacy !== 0 && Number.isFinite(legacy)) {
    if (Math.abs(legacy + 3 * sample.deltaY) < 0.5) return 'trackpad';
    if (Math.abs(legacy) >= 120 && legacy % 120 === 0) return 'mouse';
  }
  // Display scaling (e.g. Windows 125%) shrinks a notch to 96 px: still one large integer step,
  // while a trackpad burst opens with small or fractional deltas.
  return Number.isInteger(sample.deltaY) && Math.abs(sample.deltaY) >= 50 ? 'mouse' : 'trackpad';
}

function toPixels(delta: number, deltaMode: number, pageHeight: number): number {
  if (deltaMode === 1) return delta * LINE_HEIGHT_PX;
  if (deltaMode === 2) return delta * pageHeight;
  return delta;
}

export function resolveWheelIntent(
  sample: WheelSample,
  device: WheelDevice,
  mode: CanvasWheelMode,
  pageHeight: number
): WheelIntent {
  const dx = toPixels(sample.deltaX, sample.deltaMode, pageHeight);
  const dy = toPixels(sample.deltaY, sample.deltaMode, pageHeight);
  const modifierZoom = sample.ctrlKey || sample.metaKey;

  if (modifierZoom) {
    // macOS pinch arrives as ctrl+wheel with small deltas; a real ctrl+mouse notch is large.
    const factor = device === 'trackpad'
      ? Math.exp(-dy * PINCH_ZOOM_RATE)
      : Math.pow(MOUSE_ZOOM_BASE, -dy);
    return { kind: 'zoom', factor: clampStep(factor) };
  }

  const wantsZoom = mode === 'zoom' || (mode === 'auto' && device === 'mouse');
  if (wantsZoom) {
    return { kind: 'zoom', factor: clampStep(Math.pow(MOUSE_ZOOM_BASE, -dy)) };
  }

  // Panning. A mouse wheel with Shift scrolls sideways, as everywhere else on the desktop.
  if (device === 'mouse' && sample.shiftKey && dx === 0) {
    return { kind: 'pan', dx: -dy, dy: 0 };
  }
  return { kind: 'pan', dx: -dx, dy: -dy };
}

function clampStep(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.min(MAX_STEP_FACTOR, Math.max(1 / MAX_STEP_FACTOR, factor));
}

/** Zoom by `factor` keeping the flow point under (`px`, `py`) fixed on screen. */
export function zoomAround(
  viewport: Viewport,
  factor: number,
  px: number,
  py: number,
  minZoom: number,
  maxZoom: number
): Viewport {
  const zoom = Math.min(maxZoom, Math.max(minZoom, viewport.zoom * factor));
  if (zoom === viewport.zoom) return viewport;
  const ratio = zoom / viewport.zoom;
  return {
    x: px - (px - viewport.x) * ratio,
    y: py - (py - viewport.y) * ratio,
    zoom,
  };
}

/** Screen-space UI scale that keeps chrome readable: constant size, bounded at the extremes. */
export function resolveInverseZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(3, Math.max(0.6, 1 / zoom));
}

/**
 * Resize handles must stay grabbable at the minimum zoom (0.1): fully screen-constant up to 10×.
 * Text chrome keeps the tighter `resolveInverseZoom` bound so labels do not dominate far-out views.
 */
export function resolveHandleScale(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(10, Math.max(0.6, 1 / zoom));
}
