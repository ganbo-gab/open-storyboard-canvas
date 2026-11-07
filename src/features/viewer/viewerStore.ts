import type { ReactNode } from 'react';
import { create } from 'zustand';

/** An action offered for the media currently shown in the global viewer. */
export interface MediaViewerAction {
  id: string;
  label: string;
  icon?: ReactNode;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /** Short reason shown when `disabled` is true. */
  disabledReason?: string;
  run: () => void | Promise<void>;
}

export interface MediaViewerFact {
  label: string;
  value: string;
}

/**
 * One item in the global viewer. `source` is either a plain URL or a durable asset handle
 * (`asset-media:` etc.) resolved through `useAssetDisplaySource`.
 */
export interface MediaViewerItem {
  id: string;
  kind: 'image' | 'video' | 'audio';
  source: string;
  title?: string;
  /** Prompt or text that produced the media; the viewer offers copy. */
  prompt?: string;
  facts?: readonly MediaViewerFact[];
  /** Full action list for the info panel (rendered as labelled two-column buttons). */
  actions?: readonly MediaViewerAction[];
  /** Prominent actions at the bottom of the info panel, e.g. 重新编辑 / 再次生成. */
  primaryActions?: readonly MediaViewerAction[];
}

interface MediaViewerState {
  items: readonly MediaViewerItem[];
  index: number;
  open: boolean;
}

export const useMediaViewerStore = create<MediaViewerState>(() => ({
  items: [],
  index: 0,
  open: false,
}));

/** Opens the app-level viewer over the current page without changing the route. */
export function openMediaViewer(items: readonly MediaViewerItem[], index = 0): void {
  if (items.length === 0) return;
  const clamped = Math.min(Math.max(index, 0), items.length - 1);
  useMediaViewerStore.setState({ items, index: clamped, open: true });
}

export function closeMediaViewer(): void {
  useMediaViewerStore.setState({ open: false });
}

export function stepMediaViewer(delta: number): void {
  const { items, index } = useMediaViewerStore.getState();
  if (items.length === 0) return;
  const next = Math.min(Math.max(index + delta, 0), items.length - 1);
  useMediaViewerStore.setState({ index: next });
}
