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

/** Position a screen-space control without moving the document or losing reachable actions. */
export function placeNodeOverlay(
  anchor: OverlayRect,
  size: OverlaySize,
  viewport: OverlaySize,
  preferred: "top" | "bottom",
  gap = 16,
  inset = 12,
) {
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
