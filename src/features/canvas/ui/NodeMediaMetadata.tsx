import { useMemo } from 'react';
import { normalizeAssetMetadata } from '@/features/assets/application/assetMetadata';

/** Displays declared metadata only; a resolution label never invents pixel dimensions. */
export function NodeMediaMetadata({ data, fallback }: { data: unknown; fallback?: string }) {
  const metadata = useMemo(() => normalizeAssetMetadata(data), [data]);
  const label = [metadata.aspectRatio || fallback, metadata.resolution].filter(Boolean).join(' · ');
  const details = [label, metadata.width && metadata.height ? `${metadata.width} × ${metadata.height}px` : '', metadata.model].filter(Boolean).join('\n');
  return <span title={details}>{label}</span>;
}
