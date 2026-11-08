/**
 * DOM hit-testing shared by the canvas gesture engine, menus and drop handling.
 * Screen-space chrome (menus, toolbars, composers) is marked with `data-canvas-overlay`;
 * gestures that start there never pan, select or open canvas menus.
 */
export const CANVAS_OVERLAY_ATTRIBUTE = 'data-canvas-overlay';

export function isOverlayTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(`[${CANVAS_OVERLAY_ATTRIBUTE}]`));
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
}

export function getNodeIdFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('.react-flow__node[data-id]')?.dataset.id ?? null;
}

/** Text the user selected inside the canvas (used by the "selected text" context menu). */
export function readSelectedText(container: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return '';
  const text = selection.toString().trim();
  if (!text) return '';
  for (const node of [selection.anchorNode, selection.focusNode]) {
    const element = node instanceof Element ? node : node?.parentElement;
    if (element && (isOverlayTarget(element) || element.closest('button, select, [role="button"]'))) return '';
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (container.contains(selection.getRangeAt(index).commonAncestorContainer)) return text;
  }
  const { anchorNode, focusNode } = selection;
  return (anchorNode && container.contains(anchorNode)) || (focusNode && container.contains(focusNode))
    ? text
    : '';
}
