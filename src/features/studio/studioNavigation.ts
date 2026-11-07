import type { HistorySource } from '@/features/library/history/history';
import type { StudioView } from './appLocation';

export type HistoryNavigationTarget = Exclude<HistorySource, { surface: 'unavailable' }>;
export type StudioNavigationRequest =
  | { kind: 'history'; target: HistoryNavigationTarget }
  | { kind: 'page'; view: Exclude<StudioView, 'canvas'> };
type Listener = (request: StudioNavigationRequest) => void;
const listeners = new Set<Listener>();

/** Canvas dialogs and studio pages ask the shell to navigate; they never manipulate route hashes. */
export function requestHistoryNavigation(target: HistoryNavigationTarget): void {
  for (const listener of listeners) listener({ kind: 'history', target });
}

export function requestStudioPageNavigation(view: Exclude<StudioView, 'canvas'>): void {
  for (const listener of listeners) listener({ kind: 'page', view });
}

export function subscribeStudioNavigation(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
