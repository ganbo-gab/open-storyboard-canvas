import { describe, expect, it, vi } from 'vitest';

import {
  CanvasImageThumbnailAbortError,
  canvasImageThumbnailRecordKey,
  createCanvasImageThumbnailCache,
  resolveCanvasImageRequiredPixels,
  selectCanvasImageThumbnailTier,
  type CanvasImageThumbnailDeps,
  type RenderedCanvasImageThumbnail,
} from './canvasImageThumbnails';

const HASH = 'a'.repeat(64);
const ASSET = `asset-media:image%2Fpng:${HASH}`;
const DATA_URL = 'data:image/png;base64,cGl4ZWxz';

function createHarness(overrides: Partial<CanvasImageThumbnailDeps> = {}, store = new Map<string, unknown>()) {
  let urls = 0;
  const revoked: string[] = [];
  const deps: CanvasImageThumbnailDeps = {
    readSource: vi.fn(async (source: string) => new Blob([source === DATA_URL || source === ASSET ? 'pixels' : source], { type: 'image/png' })),
    hashBlob: vi.fn(async (blob: Blob) => (await blob.text()) === 'pixels' ? HASH : 'b'.repeat(64)),
    render: vi.fn(async (_blob: Blob, tier: number): Promise<RenderedCanvasImageThumbnail> => ({
      width: 4096,
      height: 2304,
      thumbnail: new Blob([`thumb-${tier}`], { type: 'image/webp' }),
    })),
    readRecord: vi.fn(async (key: string) => store.get(key)),
    writeRecord: vi.fn(async (key: string, record: unknown) => { store.set(key, record); }),
    createObjectUrl: vi.fn(() => `blob:thumb-${++urls}`),
    revokeObjectUrl: vi.fn((url: string) => { revoked.push(url); }),
    resolveOriginalDisplayUrl: vi.fn(async (source: string) => `display:${source}`),
    ...overrides,
  };
  return { deps, store, revoked, cache: createCanvasImageThumbnailCache(deps) };
}

describe('canvas image thumbnail sizing', () => {
  it('measures displayed device pixels for contain and cover boxes', () => {
    expect(resolveCanvasImageRequiredPixels({ width: 400, height: 300, zoom: 1, devicePixelRatio: 2 })).toBe(800);
    expect(resolveCanvasImageRequiredPixels({ width: 400, height: 1, zoom: 1.1, devicePixelRatio: 2 })).toBe(880);
    // Contain with known aspect: a 16:9 image in a square box only uses the width.
    expect(resolveCanvasImageRequiredPixels({ width: 300, height: 300, zoom: 1, devicePixelRatio: 1, aspectRatio: 16 / 9 })).toBe(300);
    // Cover overflows the box along the long edge.
    expect(resolveCanvasImageRequiredPixels({ width: 300, height: 300, zoom: 1, devicePixelRatio: 1, aspectRatio: 2, fit: 'cover' })).toBe(600);
    expect(resolveCanvasImageRequiredPixels({ width: 300, height: 300, zoom: 1, devicePixelRatio: Number.NaN })).toBe(300);
    expect(resolveCanvasImageRequiredPixels({ width: 0, height: 300, zoom: 1, devicePixelRatio: 1 })).toBe(0);
  });

  it('selects the smallest tier that never undersamples, original beyond the largest tier', () => {
    expect(selectCanvasImageThumbnailTier(0)).toBe(256);
    expect(selectCanvasImageThumbnailTier(256)).toBe(256);
    expect(selectCanvasImageThumbnailTier(257)).toBe(512);
    expect(selectCanvasImageThumbnailTier(800)).toBe(1024);
    expect(selectCanvasImageThumbnailTier(2048)).toBe(2048);
    expect(selectCanvasImageThumbnailTier(2049)).toBeNull();
    // 1600px node at zoom 1 on a 2x display needs 3200 device pixels: original.
    expect(selectCanvasImageThumbnailTier(resolveCanvasImageRequiredPixels({ width: 1600, height: 900, zoom: 1, devicePixelRatio: 2 }))).toBeNull();
  });
});

describe('canvas image thumbnail identity', () => {
  it('uses content hashes so a data URL and its persisted asset-media reference share thumbnails', async () => {
    const { cache } = createHarness();
    expect(await cache.resolveIdentity(ASSET)).toBe(`sha256:${HASH}`);
    expect(await cache.resolveIdentity(DATA_URL)).toBe(`sha256:${HASH}`);
    expect(await cache.resolveIdentity('/app/images/abc.png')).toBe('source:/app/images/abc.png');
    expect(await cache.resolveIdentity('blob:http://localhost/x')).toBeNull();
  });

  it('memoizes data URL hashes within a bounded budget', async () => {
    const { cache, deps } = createHarness();
    await cache.resolveIdentity(DATA_URL);
    await cache.resolveIdentity(DATA_URL);
    expect(deps.hashBlob).toHaveBeenCalledTimes(1);
    const bounded = createHarness({ identityMaxEntries: 1 });
    await bounded.cache.resolveIdentity(DATA_URL);
    await bounded.cache.resolveIdentity('data:image/png;base64,b3RoZXI=');
    await bounded.cache.resolveIdentity(DATA_URL);
    // The first entry was evicted by the second, so it is hashed again rather than retained.
    expect(bounded.deps.hashBlob).toHaveBeenCalledTimes(3);
  });
});

describe('canvas image thumbnail cache', () => {
  it('defers cold image work during an interaction and skips it if the node left the viewport', async () => {
    const wait = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const { cache, deps } = createHarness({ beforeColdRender: () => { waiting.resolve(); return wait.promise; } });
    const handle = cache.acquire(ASSET, 512);
    const result = expect(handle.promise).rejects.toBeInstanceOf(CanvasImageThumbnailAbortError);
    await waiting.promise;
    expect(deps.readSource).not.toHaveBeenCalled(); expect(deps.render).not.toHaveBeenCalled();
    handle.release(); wait.resolve(); await result;
    expect(deps.render).not.toHaveBeenCalled();
  });
  it('generates once, persists durably, and serves a reloaded session without decoding', async () => {
    const { cache, deps, store } = createHarness();
    const handle = cache.acquire(ASSET, 512);
    await expect(handle.promise).resolves.toEqual({ url: 'blob:thumb-1', kind: 'thumbnail', width: 4096, height: 2304 });
    expect(deps.render).toHaveBeenCalledTimes(1);
    expect(store.get(canvasImageThumbnailRecordKey(`sha256:${HASH}`, 512))).toMatchObject({ version: 1, width: 4096, height: 2304 });

    const reloaded = createHarness({}, store);
    const restored = reloaded.cache.acquire(DATA_URL, 512);
    await expect(restored.promise).resolves.toMatchObject({ kind: 'thumbnail', width: 4096 });
    expect(reloaded.deps.render).not.toHaveBeenCalled();
    expect(reloaded.cache.stats().durableHits).toBe(1);
  });

  it('shares one in-flight job between concurrent requests for the same source and tier', async () => {
    const { cache, deps } = createHarness();
    const results = await Promise.all([cache.acquire(ASSET, 1024).promise, cache.acquire(ASSET, 1024).promise]);
    expect(results[0].url).toBe(results[1].url);
    expect(deps.render).toHaveBeenCalledTimes(1);
    expect(deps.createObjectUrl).toHaveBeenCalledTimes(1);
  });

  it('records sources no larger than the tier as original, including every larger tier', async () => {
    const render = vi.fn(async (): Promise<RenderedCanvasImageThumbnail> => ({ width: 300, height: 200, thumbnail: null }));
    const { cache, deps, store } = createHarness({ render });
    await expect(cache.acquire(ASSET, 512).promise).resolves.toEqual({ url: `display:${ASSET}`, kind: 'original', width: 300, height: 200 });
    for (const tier of [1024, 2048]) expect(store.get(canvasImageThumbnailRecordKey(`sha256:${HASH}`, tier))).toEqual({ version: 1, width: 300, height: 200 });
    await expect(cache.acquire(ASSET, 2048).promise).resolves.toMatchObject({ kind: 'original' });
    expect(render).toHaveBeenCalledTimes(1);
    expect(deps.createObjectUrl).not.toHaveBeenCalled();
  });

  it('skips decoding when every requester released before the job started', async () => {
    const gate = Promise.withResolvers<RenderedCanvasImageThumbnail>();
    const render = vi.fn(async (_blob: Blob, tier: number) => (tier === 256 ? await gate.promise : { width: 1, height: 1, thumbnail: null }));
    const { cache } = createHarness({ render, heavyConcurrency: 1 });
    const blocking = cache.acquire('/first.png', 256);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    const queued = cache.acquire('/second.png', 512);
    const settled = queued.promise.catch((error: unknown) => error);
    await vi.waitFor(() => expect(cache.stats().heavyQueued).toBe(1));
    queued.release();
    gate.resolve({ width: 4096, height: 4096, thumbnail: new Blob(['t']) });
    await blocking.promise;
    expect(await settled).toBeInstanceOf(CanvasImageThumbnailAbortError);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('bounds concurrent heavy decodes', async () => {
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const render = vi.fn(async (): Promise<RenderedCanvasImageThumbnail> => {
      active += 1;
      peak = Math.max(peak, active);
      const gate = Promise.withResolvers<void>();
      gates.push(gate.resolve);
      await gate.promise;
      active -= 1;
      return { width: 4096, height: 4096, thumbnail: new Blob(['t']) };
    });
    const { cache } = createHarness({ render, heavyConcurrency: 2 });
    const all = Promise.all(Array.from({ length: 6 }, (_, index) => cache.acquire(`/image-${index}.png`, 512).promise));
    await vi.waitFor(() => expect(cache.stats()).toMatchObject({ heavyActive: 2, heavyQueued: 4 }));
    for (let finished = 0; finished < 6; finished += 1) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
      gates.shift()?.();
    }
    await all;
    expect(render).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2);
  });

  it('revokes only idle object URLs beyond the LRU bound', async () => {
    const { cache, revoked } = createHarness({ maxIdleEntries: 1 });
    const live = cache.acquire('/live.png', 512);
    const liveUrl = (await live.promise).url;
    for (const name of ['/a.png', '/b.png', '/c.png']) {
      const handle = cache.acquire(name, 512);
      await handle.promise;
      handle.release();
      handle.release();
    }
    expect(revoked).toHaveLength(2);
    expect(revoked).not.toContain(liveUrl);
    expect(cache.stats()).toMatchObject({ live: 1, idle: 1 });
    // Re-acquiring an evicted entry is a durable hit with a fresh URL, not a revoked one.
    const again = cache.acquire('/a.png', 512);
    const { url } = await again.promise;
    expect(revoked).not.toContain(url);
  });

  it('surfaces decode errors without fabricating a result and does not retry them in a loop', async () => {
    const failure = new Error('decode failed');
    const render = vi.fn(async (): Promise<RenderedCanvasImageThumbnail> => { throw failure; });
    const { cache, deps, store } = createHarness({ render });
    await expect(cache.acquire(ASSET, 512).promise).rejects.toBe(failure);
    await expect(cache.acquire(ASSET, 512).promise).rejects.toBe(failure);
    expect(render).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
    expect(deps.createObjectUrl).not.toHaveBeenCalled();
  });

  it('keeps a real generated thumbnail when only durable persistence fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cache } = createHarness({ writeRecord: vi.fn(async () => { throw new Error('quota'); }) });
    await expect(cache.acquire(ASSET, 256).promise).resolves.toMatchObject({ kind: 'thumbnail' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('regenerates when a durable record is malformed', async () => {
    const store = new Map<string, unknown>([[canvasImageThumbnailRecordKey(`sha256:${HASH}`, 512), { version: 1, width: 'x' }]]);
    const { cache, deps } = createHarness({}, store);
    await expect(cache.acquire(ASSET, 512).promise).resolves.toMatchObject({ kind: 'thumbnail' });
    expect(deps.render).toHaveBeenCalledTimes(1);
  });

  it('rejects missing persisted media instead of returning a placeholder', async () => {
    const { cache } = createHarness({ readSource: vi.fn(async () => { throw new Error('Persisted asset media is missing'); }) });
    await expect(cache.acquire(ASSET, 512).promise).rejects.toThrow('Persisted asset media is missing');
  });
});
