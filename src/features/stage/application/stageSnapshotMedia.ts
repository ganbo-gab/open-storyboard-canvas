import { persistImageSource } from '@/commands/image';
import type { BlueprintSceneExportOptions } from '@/features/canvas/ui/BlueprintScene';

const MAX_SNAPSHOT_HISTORY = 10;

/** Ordered screenshot URLs in the existing stage document; no separate history store. */
export function normalizeSnapshotHistory(current: string | null | undefined, history: unknown): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const append = (value: unknown) => {
    if (typeof value !== 'string' || !value.length || seen.has(value)) return;
    seen.add(value); urls.push(value);
  };
  if (Array.isArray(history)) history.forEach(append);
  append(current);
  return urls.slice(-MAX_SNAPSHOT_HISTORY);
}
export function appendSnapshotHistory(history: unknown, current: string | null | undefined): string[] {
  const previous = normalizeSnapshotHistory(null, history).filter((url) => url !== current);
  return (current ? [...previous, current] : previous).slice(-MAX_SNAPSHOT_HISTORY);
}
export function isDataImageUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^data:image\//i.test(value);
}
export async function persistDirectorStudioImageSource(source: string): Promise<string> {
  return isDataImageUrl(source) ? persistImageSource(source) : source;
}
export async function persistSnapshotHistory(history: string[]): Promise<string[]> {
  return await Promise.all(history.map(persistDirectorStudioImageSource));
}
export function screenshotExportOptions(ratio: number | null, base: number, viewport: { width: number; height: number }): BlueprintSceneExportOptions {
  if (!ratio) return { targetWidth: Math.max(1, Math.round(base * viewport.width / viewport.height)), targetHeight: base };
  return { frameAspect: ratio, targetWidth: ratio >= 1 ? Math.round(base * ratio) : base, targetHeight: ratio >= 1 ? base : Math.round(base / ratio) };
}
/** Pending text edits need one React/renderer opportunity before an export. */
export async function waitForNextStageFrame(): Promise<void> {
  if (typeof window === 'undefined') return;
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, 50);
    window.requestAnimationFrame(() => { window.clearTimeout(timeout); resolve(); });
  });
}
