import {
  getAssetDisplaySource,
  readWorkspaceRecord,
  writeWorkspaceRecord,
} from '@/features/assets/application/assetMediaStorage';
import { resolveImageDisplayUrl } from './imageData';
import { isCanvasViewportInteractionActive } from './canvasViewportCommit';

/** Long-edge pixel tiers. A tier is only used when it is at least the displayed device pixels. */
export const CANVAS_IMAGE_THUMBNAIL_TIERS = [256, 512, 1024, 2048] as const;

export interface CanvasImageDisplayGeometry {
  /** CSS size of the box the image is drawn into, in canvas (unzoomed) pixels. */
  width: number;
  height: number;
  zoom: number;
  devicePixelRatio: number;
  /** Natural width / height. Required for exact `cover` sizing; `contain` without it is conservative. */
  aspectRatio?: number | null;
  fit?: 'contain' | 'cover';
}

/** Long edge of the displayed image in device pixels, never underestimated. */
export function resolveCanvasImageRequiredPixels({
  width,
  height,
  zoom,
  devicePixelRatio,
  aspectRatio,
  fit = 'contain',
}: CanvasImageDisplayGeometry): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom * ratio : 0;
  if (!(width > 0) || !(height > 0) || !(scale > 0)) return 0;
  const aspect = typeof aspectRatio === 'number' && Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : null;
  let longEdge: number;
  if (aspect === null) longEdge = Math.max(width, height);
  else if (fit === 'cover') longEdge = aspect >= 1 ? Math.max(width, height * aspect) : Math.max(height, width / aspect);
  else longEdge = aspect >= 1 ? Math.min(width, height * aspect) : Math.min(height, width / aspect);
  // Tolerate float noise (e.g. 400 * 1.1 * 2 = 880.0000000001) without rounding below the real need.
  return Math.ceil(longEdge * scale - 1e-6);
}

/** Smallest tier that does not undersample; `null` means only the original is sharp enough. */
export function selectCanvasImageThumbnailTier(requiredPixels: number): number | null {
  if (!(requiredPixels > 0)) return CANVAS_IMAGE_THUMBNAIL_TIERS[0];
  for (const tier of CANVAS_IMAGE_THUMBNAIL_TIERS) {
    if (tier >= requiredPixels) return tier;
  }
  return null;
}

export interface CanvasImageThumbnailResult {
  url: string;
  /** `original` when the source is no larger than the tier (or cannot be thumbnailed, e.g. GIF/SVG). */
  kind: 'thumbnail' | 'original';
  /** Natural source size; 0 when the source was not decoded. */
  width: number;
  height: number;
}

export interface CanvasImageThumbnailHandle {
  readonly promise: Promise<CanvasImageThumbnailResult>;
  /** Idempotent. Pending work nobody waits for is skipped; object URLs go to a bounded idle LRU. */
  release(): void;
}

export interface CanvasImageThumbnailStats {
  live: number;
  idle: number;
  heavyActive: number;
  heavyQueued: number;
  generated: number;
  durableHits: number;
  failures: number;
}

export interface RenderedCanvasImageThumbnail {
  width: number;
  height: number;
  /** `null` when the source long edge already fits the tier, or the format must not be rasterized. */
  thumbnail: Blob | null;
}

export interface CanvasImageThumbnailRecord {
  version: 1;
  width: number;
  height: number;
  blob?: Blob;
}

export interface CanvasImageThumbnailDeps {
  readSource(source: string): Promise<Blob>;
  hashBlob(blob: Blob): Promise<string>;
  render(blob: Blob, maxLongEdge: number): Promise<RenderedCanvasImageThumbnail>;
  readRecord(key: string): Promise<unknown>;
  writeRecord(key: string, record: CanvasImageThumbnailRecord): Promise<void>;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  resolveOriginalDisplayUrl(source: string): Promise<string>;
  /** Concurrent source reads/hashes/decodes. Bounds transient full-resolution memory. */
  heavyConcurrency?: number;
  maxIdleEntries?: number;
  maxFailures?: number;
  identityMaxEntries?: number;
  /** Total data-URL characters retained as identity memo keys. */
  identityCharBudget?: number;
  /** Cold decode/encode yields to a live viewport gesture; cache hits never wait. */
  beforeColdRender?: () => Promise<void>;
}

export interface CanvasImageThumbnailCache {
  acquire(source: string, tier: number): CanvasImageThumbnailHandle;
  /** `sha256:<hex>` for content-addressed sources, `source:<string>` for immutable paths/URLs, null for blob:. */
  resolveIdentity(source: string): Promise<string | null>;
  resolveOriginalDisplayUrl(source: string): Promise<string>;
  stats(): CanvasImageThumbnailStats;
}

const THUMBNAIL_KEY_PREFIX = 'canvas-thumbnail:v1:';
const ASSET_MEDIA_PATTERN = /^asset-media:[^:]+:([a-f0-9]{64})$/i;

export class CanvasImageThumbnailAbortError extends Error {
  constructor() {
    super('Canvas image thumbnail request was released');
    this.name = 'AbortError';
  }
}

export function canvasImageThumbnailRecordKey(identity: string, tier: number): string {
  return `${THUMBNAIL_KEY_PREFIX}${identity}:${tier}`;
}

function isThumbnailRecord(value: unknown): value is CanvasImageThumbnailRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CanvasImageThumbnailRecord>;
  return record.version === 1
    && typeof record.width === 'number'
    && typeof record.height === 'number'
    && (record.blob === undefined || (record.blob instanceof Blob && record.blob.size > 0));
}

function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const take = () => {
    if (active < concurrency) {
      active += 1;
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    queue.push(resolve);
    return promise;
  };
  // Hand the slot straight to the next waiter so a new caller cannot slip past the bound.
  const give = () => {
    const next = queue.shift();
    if (next) next();
    else active -= 1;
  };
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await take();
      try {
        return await task();
      } finally {
        give();
      }
    },
    get active() { return active; },
    get queued() { return queue.length; },
  };
}

interface Entry {
  key: string;
  refs: number;
  settled: boolean;
  url?: string;
  promise: Promise<CanvasImageThumbnailResult>;
}

export function createCanvasImageThumbnailCache(deps: CanvasImageThumbnailDeps): CanvasImageThumbnailCache {
  const heavy = createLimiter(Math.max(1, deps.heavyConcurrency ?? 2));
  const maxIdle = Math.max(0, deps.maxIdleEntries ?? 96);
  const maxFailures = Math.max(0, deps.maxFailures ?? 256);
  const identityMaxEntries = Math.max(1, deps.identityMaxEntries ?? 256);
  const identityCharBudget = Math.max(0, deps.identityCharBudget ?? 64 * 1024 * 1024);
  const entries = new Map<string, Entry>();
  const idle = new Map<string, Entry>();
  const failures = new Map<string, unknown>();
  const identities = new Map<string, Promise<string>>();
  let identityChars = 0;
  let generated = 0;
  let durableHits = 0;

  const forgetIdentity = (source: string) => {
    if (identities.delete(source)) identityChars -= source.length;
  };

  const resolveIdentity = async (source: string): Promise<string | null> => {
    const asset = ASSET_MEDIA_PATTERN.exec(source);
    if (asset) return `sha256:${asset[1].toLowerCase()}`;
    if (source.startsWith('blob:')) return null;
    if (!source.startsWith('data:')) return `source:${source}`;
    const memo = identities.get(source);
    if (memo) {
      identities.delete(source);
      identities.set(source, memo);
      return await memo;
    }
    // Hash decoded bytes, not the string: identical to persistAssetBlob, so a node migrated from a
    // data URL to its asset-media reference keeps hitting the same durable thumbnails.
    const pending = heavy.run(async () => `sha256:${await deps.hashBlob(await deps.readSource(source))}`);
    identities.set(source, pending);
    identityChars += source.length;
    for (const oldest of identities.keys()) {
      if (oldest === source || (identities.size <= identityMaxEntries && identityChars <= identityCharBudget)) break;
      forgetIdentity(oldest);
    }
    try {
      return await pending;
    } catch (error) {
      if (identities.get(source) === pending) forgetIdentity(source);
      throw error;
    }
  };

  const rememberFailure = (key: string, error: unknown) => {
    if (maxFailures === 0) return;
    failures.delete(key);
    failures.set(key, error);
    if (failures.size > maxFailures) failures.delete(failures.keys().next().value!);
  };

  const evictIdle = () => {
    while (idle.size > maxIdle) {
      const oldest: Entry = idle.values().next().value!;
      idle.delete(oldest.key);
      if (entries.get(oldest.key) === oldest) entries.delete(oldest.key);
      if (oldest.url) deps.revokeObjectUrl(oldest.url);
      oldest.url = undefined;
    }
  };

  const detach = (entry: Entry) => {
    entry.refs -= 1;
    if (entry.refs > 0 || !entry.settled || entries.get(entry.key) !== entry) return;
    idle.set(entry.key, entry);
    evictIdle();
  };

  const materialize = async (entry: Entry, source: string, record: CanvasImageThumbnailRecord): Promise<CanvasImageThumbnailResult> => {
    if (record.blob) {
      entry.url = deps.createObjectUrl(record.blob);
      return { url: entry.url, kind: 'thumbnail', width: record.width, height: record.height };
    }
    return { url: await deps.resolveOriginalDisplayUrl(source), kind: 'original', width: record.width, height: record.height };
  };

  const readDurable = async (key: string): Promise<CanvasImageThumbnailRecord | null> => {
    try {
      const value = await deps.readRecord(key);
      return isThumbnailRecord(value) ? value : null;
    } catch (error) {
      console.warn('[canvasImageThumbnails] durable thumbnail read failed; regenerating', { key, error });
      return null;
    }
  };

  const writeDurable = async (identity: string, tier: number, record: CanvasImageThumbnailRecord) => {
    const writes: Array<[string, CanvasImageThumbnailRecord]> = [[canvasImageThumbnailRecordKey(identity, tier), record]];
    const longEdge = Math.max(record.width, record.height);
    // Every tier at or above the natural size is the original: remember that without another decode.
    if (longEdge > 0) {
      for (const larger of CANVAS_IMAGE_THUMBNAIL_TIERS) {
        if (larger > tier && larger >= longEdge) {
          writes.push([canvasImageThumbnailRecordKey(identity, larger), { version: 1, width: record.width, height: record.height }]);
        }
      }
    }
    const results = await Promise.allSettled(writes.map(([key, value]) => deps.writeRecord(key, value)));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    // The generated pixels are real; only durability is lost, so the session result stays valid.
    if (failed) console.warn('[canvasImageThumbnails] durable thumbnail write failed', { identity, tier, error: failed.reason });
  };

  const createEntry = (key: string, source: string, identity: string, tier: number): Entry => {
    // `load` first awaits the durable read, so `entry` is initialized before the body touches it.
    const load = async (): Promise<CanvasImageThumbnailResult> => {
      const durable = await readDurable(key);
      if (durable) {
        durableHits += 1;
        return await materialize(entry, source, durable);
      }
      return await heavy.run(async () => {
        await deps.beforeColdRender?.();
        if (entry.refs === 0) {
          // Detach synchronously so a later acquirer starts fresh instead of joining an aborted job.
          if (entries.get(key) === entry) entries.delete(key);
          throw new CanvasImageThumbnailAbortError();
        }
        const blob = await deps.readSource(source);
        await deps.beforeColdRender?.();
        if (entry.refs === 0) {
          if (entries.get(key) === entry) entries.delete(key);
          throw new CanvasImageThumbnailAbortError();
        }
        const rendered = await deps.render(blob, tier);
        if (!(rendered.width >= 0) || !(rendered.height >= 0)) throw new Error('Thumbnail renderer returned an invalid size');
        const record: CanvasImageThumbnailRecord = rendered.thumbnail
          ? { version: 1, width: rendered.width, height: rendered.height, blob: rendered.thumbnail }
          : { version: 1, width: rendered.width, height: rendered.height };
        if (rendered.thumbnail) generated += 1;
        await writeDurable(identity, tier, record);
        return await materialize(entry, source, record);
      });
    };
    const entry: Entry = { key, refs: 0, settled: false, promise: load() };
    entry.promise.then(
      () => {
        entry.settled = true;
        if (entry.refs === 0 && entries.get(key) === entry) {
          idle.set(key, entry);
          evictIdle();
        }
      },
      (error: unknown) => {
        if (entries.get(key) === entry) entries.delete(key);
        if (!(error instanceof CanvasImageThumbnailAbortError)) rememberFailure(key, error);
      },
    );
    entries.set(key, entry);
    return entry;
  };

  const acquire = (source: string, tier: number): CanvasImageThumbnailHandle => {
    let released = false;
    let entry: Entry | undefined;
    const promise = (async (): Promise<CanvasImageThumbnailResult> => {
      if (!(CANVAS_IMAGE_THUMBNAIL_TIERS as readonly number[]).includes(tier)) throw new Error(`Unsupported thumbnail tier ${tier}`);
      const identity = await resolveIdentity(source);
      if (released) throw new CanvasImageThumbnailAbortError();
      if (identity === null) {
        return { url: await deps.resolveOriginalDisplayUrl(source), kind: 'original', width: 0, height: 0 };
      }
      const key = canvasImageThumbnailRecordKey(identity, tier);
      if (failures.has(key)) throw failures.get(key);
      const attached = entries.get(key) ?? createEntry(key, source, identity, tier);
      attached.refs += 1;
      idle.delete(key);
      entry = attached;
      return await attached.promise;
    })();
    return {
      promise,
      release() {
        if (released) return;
        released = true;
        if (entry) detach(entry);
      },
    };
  };

  return {
    acquire,
    resolveIdentity,
    resolveOriginalDisplayUrl: deps.resolveOriginalDisplayUrl,
    stats: () => ({
      live: [...entries.values()].filter((entry) => entry.refs > 0).length,
      idle: idle.size,
      heavyActive: heavy.active,
      heavyQueued: heavy.queued,
      generated,
      durableHits,
      failures: failures.size,
    }),
  };
}

async function readCanvasImageSource(source: string): Promise<Blob> {
  if (source.startsWith('asset-media:')) {
    const blob = await readWorkspaceRecord<Blob>('media', source);
    if (!blob) throw new Error('Persisted asset media is missing');
    return blob;
  }
  const response = await fetch(source.startsWith('data:') ? source : resolveImageDisplayUrl(source));
  if (!response.ok) throw new Error(`Cannot read image source (status ${response.status})`);
  const blob = await response.blob();
  if (!blob.size) throw new Error('Image source is empty');
  if (blob.type && !blob.type.startsWith('image/') && blob.type !== 'application/octet-stream') {
    throw new Error(`Image source returned ${blob.type}`);
  }
  return blob;
}

async function hashCanvasImageBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function encodeCanvasImageBitmap(bitmap: ImageBitmap, width: number, height: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas is unavailable for thumbnail encoding');
    context.drawImage(bitmap, 0, 0, width, height);
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas is unavailable for thumbnail encoding');
    context.drawImage(bitmap, 0, 0, width, height);
    const { promise, resolve, reject } = Promise.withResolvers<Blob>();
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Thumbnail encoding failed'))), 'image/webp', 0.92);
    return await promise;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** One full decode, one high-quality resample, then the full bitmap is closed immediately. */
async function renderCanvasImageThumbnail(blob: Blob, maxLongEdge: number): Promise<RenderedCanvasImageThumbnail> {
  // Animated GIFs would freeze and SVGs would rasterize: keep their original rendering.
  if (blob.type === 'image/gif' || blob.type === 'image/svg+xml') return { width: 0, height: 0, thumbnail: null };
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    if (!width || !height) throw new Error('Decoded image has no pixels');
    const longEdge = Math.max(width, height);
    if (longEdge <= maxLongEdge) return { width, height, thumbnail: null };
    const scale = maxLongEdge / longEdge;
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const resized = await createImageBitmap(bitmap, { resizeWidth: targetWidth, resizeHeight: targetHeight, resizeQuality: 'high' });
    try {
      return { width, height, thumbnail: await encodeCanvasImageBitmap(resized, targetWidth, targetHeight) };
    } finally {
      resized.close();
    }
  } finally {
    bitmap.close();
  }
}

/** Display URL for the untouched original: hydrates browser asset-media, converts desktop paths. */
export async function resolveCanvasImageOriginalDisplayUrl(source: string): Promise<string> {
  return resolveImageDisplayUrl(await getAssetDisplaySource(source));
}

export const canvasImageThumbnailCache = createCanvasImageThumbnailCache({
  beforeColdRender: async () => {
    while (isCanvasViewportInteractionActive()) await new Promise<void>((resolve) => setTimeout(resolve, 80));
  },
  readSource: readCanvasImageSource,
  hashBlob: hashCanvasImageBlob,
  render: renderCanvasImageThumbnail,
  readRecord: (key) => readWorkspaceRecord<unknown>('media', key),
  writeRecord: (key, record) => writeWorkspaceRecord('media', key, record),
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  resolveOriginalDisplayUrl: resolveCanvasImageOriginalDisplayUrl,
});
