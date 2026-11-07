export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface OverlaySize {
  width: number;
  height: number;
}

export interface OverlayPlacement {
  x: number;
  y: number;
  width: number;
  maxHeight: number;
}

/** Position a screen-space control without moving the document or losing reachable actions. */
export function placeNodeOverlay(
  anchor: OverlayRect,
  size: OverlaySize,
  viewport: OverlaySize,
  preferred: "top" | "bottom",
  gap = 16,
  inset = 12,
): OverlayPlacement {
  const width = Math.min(size.width, Math.max(0, viewport.width - inset * 2));
  const height = Math.min(
    size.height,
    Math.max(0, viewport.height - inset * 2),
  );
  const above = anchor.y - gap - height;
  const below = anchor.y + anchor.height + gap;
  const first = preferred === "top" ? above : below;
  const second = preferred === "top" ? below : above;
  const fits = (y: number) =>
    y >= inset && y + height <= viewport.height - inset;
  const y = fits(first)
    ? first
    : fits(second)
      ? second
      : Math.max(inset, viewport.height - inset - height);
  const x = Math.max(
    inset,
    Math.min(
      anchor.x + anchor.width / 2 - width / 2,
      viewport.width - inset - width,
    ),
  );
  return { x, y, width, maxHeight: Math.max(0, viewport.height - inset * 2) };
}

/** Gap the anchored panels leave between their trigger and themselves. */
const PANEL_GAP = 6;

/**
 * Node tool panels position themselves at the trigger's left edge, `PANEL_GAP` below its bottom.
 * Return the trigger rect to hand them so a `panel`-sized panel stays on screen: vertically
 * unchanged when it fits below, flipped above when it fits there, else pinned to the bottom
 * inset; horizontally slid left so its right edge stays inside the viewport.
 */
export function placePanelAnchor(
  trigger: OverlayRect,
  panel: OverlaySize,
  viewport: OverlaySize,
  inset = 8,
): OverlayRect {
  const x = panel.width > 0
    ? Math.max(inset, Math.min(trigger.x, viewport.width - inset - panel.width))
    : trigger.x;
  const below = trigger.y + trigger.height + PANEL_GAP;
  if (panel.height <= 0 || below + panel.height <= viewport.height - inset) return { ...trigger, x };
  const above = trigger.y - PANEL_GAP - panel.height;
  const top = above >= inset ? above : Math.max(inset, viewport.height - inset - panel.height);
  // The panel adds PANEL_GAP to the bottom edge it is given.
  return { ...trigger, x, y: top - PANEL_GAP - trigger.height };
}
