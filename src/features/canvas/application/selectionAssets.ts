import { saveAsset, type AssetKind } from '@/features/assets/application/assetCatalog';
import { persistAssetMedia } from '@/features/assets/application/assetMediaStorage';
import { normalizeAssetMetadata } from '@/features/assets/application/assetMetadata';
import { useProjectStore } from '@/stores/projectStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import { resolveNodeDisplayName } from '../domain/nodeDisplay';

export interface DownloadableCanvasMedia {
  nodeId: string;
  kind: AssetKind;
  source: string;
  fileStem: string;
}

function readNodeAsset(node: CanvasNode): { kind: AssetKind; source: string } | null {
  const data = node.data;
  for (const [keys, kind] of [[['imageUrl'], 'image'], [['localVideoUrl', 'videoUrl'], 'video'], [['localAudioUrl', 'audioUrl'], 'audio']] as const) {
    const source = keys.map((key) => data[key]).find((value) => typeof value === 'string' && value.trim());
    if (typeof source === 'string' && source.trim()) return { kind, source };
  }
  if (node.type === CANVAS_NODE_TYPES.textAnnotation || node.type === CANVAS_NODE_TYPES.jsonCard) {
    const source = typeof data.rawContent === 'string' && data.rawContent.trim() ? data.rawContent : data.content;
    if (typeof source === 'string' && source.trim()) return { kind: 'text', source };
  }
  return null;
}

/** Session-only, embedded and executable sources are never exported or saved as durable assets. */
export function isDurableSelectionMediaSource(source: string): boolean {
  if (!source || source !== source.trim() || /[\u0000-\u001f\u007f]/.test(source)) return false;
  if (/^asset-media:(?:image|video|audio)(?:%2F|\/)[^:]+:[a-f0-9]{64}$/i.test(source)) return true;
  if (/^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(source)) return true;
  try {
    const url = new URL(source);
    return ['http:', 'https:', 'asset:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

export async function saveNodesToAssets(nodeIds: string[], options: { name?: string; tags?: string[] } = {}): Promise<{ assetIds: string[]; skipped: string[] }> {
  const nodes = new Map(useCanvasStore.getState().nodes.map((node) => [node.id, node]));
  const projectId = useProjectStore.getState().currentProjectId ?? undefined;
  const assetIds: string[] = []; const skipped: string[] = [];
  for (const nodeId of new Set(nodeIds)) {
    const node = nodes.get(nodeId); const media = node ? readNodeAsset(node) : null;
    if (!node || !media || (media.kind !== 'text' && !isDurableSelectionMediaSource(media.source))) { skipped.push(nodeId); continue; }
    // Snapshot source/configuration before awaiting persistence. Remote sources become local media refs.
    const name = options.name?.trim() || resolveNodeDisplayName(node.type, node.data);
    const metadata = normalizeAssetMetadata(node.data);
    const tags = [...new Set(options.tags ?? [])];
    const source = media.kind === 'text' ? media.source : await persistAssetMedia(media.source, true, media.kind);
    const asset = await saveAsset({ kind: media.kind, source, name, origin: 'canvas', nodeId, projectId, tags,
      metadata: { ...metadata, tags } });
    assetIds.push(asset.id);
  }
  return { assetIds, skipped };
}

/** Collapsed secondary results are excluded from batch export, not deleted from the graph. */
export function collectDownloadableMedia(nodeIds: string[]): DownloadableCanvasMedia[] {
  const ids = new Set(nodeIds);
  return useCanvasStore.getState().nodes.flatMap((node): DownloadableCanvasMedia[] => {
    if (!ids.has(node.id) || node.hidden) return [];
    const media = readNodeAsset(node);
    if (!media || (media.kind !== 'text' && !isDurableSelectionMediaSource(media.source))) return [];
    const fileName = typeof node.data.generatedFileName === 'string' ? node.data.generatedFileName : resolveNodeDisplayName(node.type, node.data);
    const fileStem = fileName.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || node.id;
    return [{ nodeId: node.id, kind: media.kind, source: media.source, fileStem }];
  });
}
