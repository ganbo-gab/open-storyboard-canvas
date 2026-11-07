import type { CanvasNode } from './canvasNodes';

export type ProjectMediaKind = 'image' | 'video' | 'audio';
export interface MissingProjectMediaReference {
  status: 'missing';
  source: string;
  reason: 'unavailable-blob' | 'unresolved-image-pool' | 'unresolved-asset-id' | 'persistence-failed';
  message?: string;
}
export type ProjectMediaReference =
  | { status: 'ready'; assetId: string; source: string; legacyMissing?: MissingProjectMediaReference }
  | MissingProjectMediaReference;
export interface ProjectMediaRequest { source: string; assetId?: string; kind: ProjectMediaKind; nodeId: string; field: string; name: string }
export interface ProjectMediaResolution { assetId: string; source: string }
/** Return only after the asset index and its bytes have been durably committed. Null means unavailable. */
export type ProjectMediaResolver = (request: ProjectMediaRequest) => Promise<ProjectMediaResolution | null>;

const mediaFields: Record<string, true | undefined> = { imageUrl: true, previewImageUrl: true, thumbnailUrl: true, sourceImageUrl: true, snapshotUrl: true, backgroundImageUrl: true, backgroundPanoramaUrl: true, coverUrl: true, refImageUrl: true, videoUrl: true, localVideoUrl: true, audioUrl: true, localAudioUrl: true };
const mediaContainers: Record<string, true | undefined> = { frames: true, items: true, referenceImages: true, directorStudioProjects: true, snapshot: true, snapshotHistory: true };
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function isReference(value: unknown): value is ProjectMediaReference {
  const data = record(value);
  return !!data && typeof data.source === 'string' && (data.status === 'ready'
    ? typeof data.assetId === 'string' && !!data.assetId
    : data.status === 'missing' && ['unavailable-blob', 'unresolved-image-pool', 'unresolved-asset-id', 'persistence-failed'].includes(String(data.reason)));
}

/** Media migration is field-aware: prose, JSON output, arbitrary metadata and provider URLs are not media. */
export async function migrateCanvasNodeMedia(nodes: CanvasNode[], resolve: ProjectMediaResolver): Promise<CanvasNode[]> {
  return await Promise.all(nodes.map(async (node) => {
    const existing = record(node.data.mediaReferences) ?? {};
    const references: Record<string, ProjectMediaReference> = {};
    let sourceChanged = false;
    let nodeData = node.data;
    const primaryField = node.type === 'videoNode' ? 'videoUrl' : node.type === 'audioNode' ? 'audioUrl' : 'imageUrl';
    if (typeof node.data.assetId === 'string' && node.data.assetId
      && !(typeof node.data[primaryField] === 'string' && node.data[primaryField])) {
      const missing: MissingProjectMediaReference = { status: 'missing', source: `asset-id:${node.data.assetId}`, reason: 'unresolved-asset-id' };
      try {
        const result = await resolve({ assetId: node.data.assetId, source: '', nodeId: node.id, field: primaryField,
          kind: primaryField === 'audioUrl' ? 'audio' : primaryField === 'videoUrl' ? 'video' : 'image', name: node.id });
        if (result && result.assetId && result.source && !/^(?:blob|data):/i.test(result.source)) {
          nodeData = { ...node.data, [primaryField]: result.source };
          references[primaryField] = { status: 'ready', ...result };
          sourceChanged = true;
        } else references[primaryField] = missing;
      } catch (error) {
        references[primaryField] = { ...missing, message: error instanceof Error ? error.message : String(error) };
      }
    }
    const visit = async (value: unknown, path: string, key = '', parent = ''): Promise<unknown> => {
      const media = mediaFields[key] || (key === 'url' && /(?:^|\.)referenceImages\[\d+\]$/.test(parent)) || /(?:^|\.)snapshotHistory\[\d+\]$/.test(path);
      if (media && typeof value === 'string' && value) {
        const prior = references[path] ?? existing[path];
        // Missing media is retried on a later open; successful durable references are stable.
        if (isReference(prior) && prior.status === 'ready' && prior.source === value) {
          references[path] = prior;
          return value;
        }
        if (value.startsWith('__img_ref__:')) {
          references[path] = { status: 'missing', source: value, reason: 'unresolved-image-pool' };
          return value;
        }
        const kind: ProjectMediaKind = /audio/i.test(key) ? 'audio' : /video/i.test(key) ? 'video' : 'image';
        let legacyMissing = isReference(prior) && prior.status === 'missing' && prior.source !== value ? prior : undefined;
        const candidates = legacyMissing ? [legacyMissing.source, value] : [value];
        for (const source of candidates) {
          let missing: MissingProjectMediaReference = { status: 'missing', source, reason: /^blob:/i.test(source) ? 'unavailable-blob' : 'persistence-failed' };
          try {
            const result = await resolve({ source, kind, nodeId: node.id, field: path,
              name: typeof node.data.displayName === 'string' ? node.data.displayName : typeof node.data.sourceFileName === 'string' ? node.data.sourceFileName : node.id });
            if (result && result.assetId && result.source && !/^(?:blob|data):/i.test(result.source)) {
              references[path] = { status: 'ready', ...result, ...(legacyMissing && source === value ? { legacyMissing } : {}) };
              sourceChanged ||= result.source !== value;
              return result.source;
            }
          } catch (error) {
            missing = { ...missing, message: error instanceof Error ? error.message : String(error) };
          }
          if (source !== value) legacyMissing = missing;
          else references[path] = missing;
        }
        return value; // Original evidence is never discarded, including expired blob URLs.
      }
      if (path && !mediaContainers[key]) return value;
      if (Array.isArray(value)) return await Promise.all(value.map((entry, index) => visit(entry, `${path}[${index}]`, key, path)));
      const data = record(value);
      if (!data) return value;
      const entries = Object.entries(data);
      return Object.fromEntries(await Promise.all(entries.map(async ([field, entry]) => [field, await visit(entry, path ? `${path}.${field}` : field, field, path)])));
    };
    const data = await visit(nodeData, '') as CanvasNode['data'];
    if (Object.keys(references).length) data.mediaReferences = references;
    const primary = references.imageUrl ?? references.videoUrl ?? references.audioUrl;
    if (primary?.status === 'ready') data.assetId = primary.assetId;
    if (!sourceChanged && data.assetId === node.data.assetId
      && Object.keys(references).length === Object.keys(existing).length
      && Object.entries(references).every(([field, reference]) => JSON.stringify(reference) === JSON.stringify(existing[field]))) return node;
    return { ...node, data };
  }));
}
