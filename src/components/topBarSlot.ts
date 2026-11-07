import { useSyncExternalStore } from 'react';

/**
 * The app top bar exposes one element where the active page portals its own actions
 * (the canvas puts its agent launcher there), so the window has a single top bar.
 */
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setTopBarActionsSlot(element: HTMLElement | null) {
  if (slot === element) return;
  slot = element;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTopBarActionsSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}
