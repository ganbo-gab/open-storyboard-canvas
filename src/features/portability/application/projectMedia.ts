import type { ProjectRecord } from '@/commands/projectState';

const MEDIA_VALUE_KEYS = new Set([
  'imageUrl',
  'previewImageUrl',
  'thumbnailUrl',
  'sourceImageUrl',
  'snapshotUrl',
  'backgroundImageUrl',
  'backgroundPanoramaUrl',
  'coverUrl',
  'refImageUrl',
  'videoUrl',
  'localVideoUrl',
  'audioUrl',
  'localAudioUrl',
]);

const MEDIA_LIST_KEYS = new Set(['snapshotHistory', 'imagePool']);

function parseJson(value: string | null | undefined, fallback: unknown): unknown {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function visitMediaValues(
  value: unknown,
  visitor: (source: string, role: string) => string,
  path: string
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => visitMediaValues(item, visitor, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    const isBlueprintReferenceUrl = key === 'url' && /(?:^|\.)referenceImages\[\d+\]$/.test(path);
    if ((MEDIA_VALUE_KEYS.has(key) || isBlueprintReferenceUrl) && typeof child === 'string' && child) {
      next[key] = visitor(child, childPath);
    } else if (MEDIA_LIST_KEYS.has(key) && Array.isArray(child)) {
      next[key] = child.map((item, index) => (
        typeof item === 'string' && item
          ? visitor(item, `${childPath}[${index}]`)
          : visitMediaValues(item, visitor, `${childPath}[${index}]`)
      ));
    } else {
      next[key] = visitMediaValues(child, visitor, childPath);
    }
  }
  return next;
}

export interface ProjectMediaSource {
  source: string;
  roles: string[];
}

export function collectProjectMediaSources(record: ProjectRecord): ProjectMediaSource[] {
  const rolesBySource = new Map<string, Set<string>>();
  const collect = (source: string, role: string): string => {
    const roles = rolesBySource.get(source) ?? new Set<string>();
    roles.add(role);
    rolesBySource.set(source, roles);
    return source;
  };
  visitMediaValues(parseJson(record.nodesJson, []), collect, 'nodes');
  visitMediaValues(parseJson(record.historyJson, {}), collect, 'history');
  const pool = parseJson(record.imagePoolJson, record.imagePool ?? []);
  if (Array.isArray(pool)) {
    pool.forEach((source, index) => {
      if (typeof source === 'string' && source) collect(source, `imagePool[${index}]`);
    });
  }
  return Array.from(rolesBySource, ([source, roles]) => ({ source, roles: [...roles] }));
}

export function replaceProjectMediaSources(
  record: ProjectRecord,
  replacements: ReadonlyMap<string, string>
): ProjectRecord {
  const replace = (source: string): string => replacements.get(source) ?? source;
  const nodes = visitMediaValues(parseJson(record.nodesJson, []), replace, 'nodes');
  const history = visitMediaValues(parseJson(record.historyJson, {}), replace, 'history');
  const rawPool = parseJson(record.imagePoolJson, record.imagePool ?? []);
  const imagePool = Array.isArray(rawPool)
    ? rawPool.map((source) => typeof source === 'string' ? replace(source) : source)
    : [];
  return {
    ...record,
    nodesJson: JSON.stringify(nodes),
    historyJson: JSON.stringify(history),
    imagePoolJson: JSON.stringify(imagePool),
    imagePool: imagePool.filter((source): source is string => typeof source === 'string'),
  };
}

export function inferMediaType(source: string, mime = ''): 'image' | 'video' | 'audio' | 'binary' {
  const normalized = `${mime};${source}`.toLowerCase();
  if (normalized.includes('image/')) return 'image';
  if (normalized.includes('video/')) return 'video';
  if (normalized.includes('audio/')) return 'audio';
  if (/\.(png|jpe?g|webp|gif|bmp|avif)(?:[?#]|$)/.test(normalized)) return 'image';
  if (/\.(mp4|mov|webm|mkv|m4v)(?:[?#]|$)/.test(normalized)) return 'video';
  if (/\.(mp3|wav|m4a|aac|ogg|flac)(?:[?#]|$)/.test(normalized)) return 'audio';
  return 'binary';
}
