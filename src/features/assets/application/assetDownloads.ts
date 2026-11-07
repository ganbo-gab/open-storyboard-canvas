import { downloadSourcesFor } from './assetCatalog';
import { getAssetDisplaySource } from './assetMediaStorage';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import type { AssetDownloadSource } from './assetCatalog';

export interface AssetDownload {
  id: string;
  name: string;
  url: string;
}

/** Text is content, not a path/URL; encoding retains Unicode, whitespace and literal media prefixes. */
export async function prepareAssetDownload(asset: AssetDownloadSource): Promise<AssetDownload> {
  if (asset.kind === 'text') return {
    id: asset.id,
    name: /\.(txt|md|markdown|json|csv|srt|vtt)$/i.test(asset.name) ? asset.name : `${asset.name}.txt`,
    url: `data:text/plain;charset=utf-8,${encodeURIComponent(asset.source)}`,
  };
  return { id: asset.id, name: asset.name, url: resolveImageDisplayUrl(await getAssetDisplaySource(asset.source)) };
}

export async function downloadAsset(asset: AssetDownloadSource): Promise<void> {
  const prepared = await prepareAssetDownload(asset);
  const anchor = document.createElement('a');
  anchor.href = prepared.url;
  anchor.download = prepared.name;
  anchor.rel = 'noreferrer';
  document.body.append(anchor);
  try { anchor.click(); }
  finally { anchor.remove(); }
}

export async function downloadAssets(ids: readonly string[]): Promise<void> {
  for (const asset of await downloadSourcesFor(ids)) await downloadAsset(asset);
}
