/**
 * Long-axis span of an alignment guide, clipped to the live Flow viewport.
 *
 * Guides used to run from -GUIDE_LEGACY_EXTENT to +GUIDE_LEGACY_EXTENT flow units. In the large-graph drag fixture that
 * extreme geometry measurably raised per-frame update cost (the responsible rendering stage was not isolated). The
 * span now covers only the visible range plus a small screen-space margin. Its start sits a whole number of
 * user-space dash periods after the legacy start, so the authored dash pattern keeps the legacy user-space phase; the
 * span grows outward only and never leaves the legacy interval.
 */

/** Legacy long-axis half extent (flow units); its negative end is the dash-phase origin. */
export const GUIDE_LEGACY_EXTENT = 1_000_000;
/**
 * User-space dash period: the sum of the authored `stroke-dasharray: 4 3` on `.canvas-alignment-guides line`
 * (canvas.css). Keep both in step.
 */
export const GUIDE_DASH_PERIOD = 4 + 3;
/** Screen-space (CSS px) overhang past each viewport edge so line ends are never visible. */
export const GUIDE_VIEWPORT_PADDING_PX = 8;

const LEGACY_START = -GUIDE_LEGACY_EXTENT;

/** Visible flow coordinate at screen offset `screen` along one axis, or NaN for an unusable viewport. */
function flowAt(screen: number, translate: number, zoom: number, size: number): number {
  if (!(size > 0) || !Number.isFinite(size) || !(zoom > 0) || !Number.isFinite(zoom) || !Number.isFinite(translate)) {
    return Number.NaN;
  }
  return (screen - translate) / zoom;
}

/**
 * Phase-aligned start of the guide span along one axis (`translate`/`size` are that axis' Flow transform component
 * and pane size). NaN when the pane is unmeasured or the transform is unusable; the span is empty unless start < end.
 */
export function resolveGuideSpanStart(translate: number, zoom: number, size: number): number {
  const visible = flowAt(-GUIDE_VIEWPORT_PADDING_PX, translate, zoom, size);
  const start = LEGACY_START + GUIDE_DASH_PERIOD * Math.floor((visible - LEGACY_START) / GUIDE_DASH_PERIOD);
  return Math.max(LEGACY_START, start);
}

/** Outward end of the guide span along one axis; see {@link resolveGuideSpanStart}. */
export function resolveGuideSpanEnd(translate: number, zoom: number, size: number): number {
  const visible = flowAt(size + GUIDE_VIEWPORT_PADDING_PX, translate, zoom, size);
  const end = LEGACY_START + GUIDE_DASH_PERIOD * Math.ceil((visible - LEGACY_START) / GUIDE_DASH_PERIOD);
  return Math.min(GUIDE_LEGACY_EXTENT, end);
}
