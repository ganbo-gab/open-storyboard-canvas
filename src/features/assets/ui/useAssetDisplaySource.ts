import { useEffect, useState } from 'react';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { getAssetDisplaySource } from '../application/assetMediaStorage';

export interface AssetDisplaySource {
  /** Playable/displayable URL; null while an asset-media handle hydrates, after failure, or without a source. */
  url: string | null;
  error: string | null;
}

const isAssetMediaReference = (source: string) => source.startsWith('asset-media:');

/**
 * Display URL for a durable media source (asset-media handle, desktop path, URL, data/blob URL).
 * Asset-media handles are IndexedDB keys, never valid `src` values, so they hydrate asynchronously.
 */
export function useAssetDisplaySource(source: string | null | undefined): AssetDisplaySource {
  const durable = source?.trim() ?? '';
  const [hydrated, setHydrated] = useState<{ source: string; url: string | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!isAssetMediaReference(durable)) return;
    let active = true;
    void getAssetDisplaySource(durable).then(
      (value) => { if (active) setHydrated({ source: durable, url: resolveImageDisplayUrl(value), error: null }); },
      (cause: unknown) => { if (active) setHydrated({ source: durable, url: null, error: cause instanceof Error ? cause.message : String(cause) }); },
    );
    return () => { active = false; };
  }, [durable]);

  if (!durable) return { url: null, error: null };
  if (!isAssetMediaReference(durable)) return { url: resolveImageDisplayUrl(durable), error: null };
  return hydrated?.source === durable ? { url: hydrated.url, error: hydrated.error } : { url: null, error: null };
}
