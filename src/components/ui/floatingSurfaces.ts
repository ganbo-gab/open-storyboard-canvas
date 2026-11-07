/** Transient siblings replace one another; an owned child picker may remain above its parent. */
export const FLOATING_SURFACE_OPEN = 'ui:floating-surface-open';
export const MODAL_SURFACE_OPEN = 'ui:modal-surface-open';
export function announceFloatingSurface(surface: HTMLElement, trigger: Element | null = document.activeElement): void {
  document.dispatchEvent(new CustomEvent(FLOATING_SURFACE_OPEN, { detail: { surface, trigger } }));
}
export function isFloatingSurfaceEvent(event: Event): event is CustomEvent<{ surface: HTMLElement; trigger: Element | null }> {
  return event instanceof CustomEvent && event.type === FLOATING_SURFACE_OPEN;
}
