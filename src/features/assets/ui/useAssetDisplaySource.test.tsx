// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  pending: new Map<string, { resolve(url: string): void; reject(error: Error): void }>(),
}));

vi.mock('../application/assetMediaStorage', () => ({
  getAssetDisplaySource: (source: string) => new Promise<string>((resolve, reject) => {
    storage.pending.set(source, { resolve, reject });
  }),
}));

import { useAssetDisplaySource } from './useAssetDisplaySource';

const VIDEO = `asset-media:video%2Fwebm:${'a'.repeat(64)}`;
const AUDIO = `asset-media:audio%2Fwav:${'b'.repeat(64)}`;

afterEach(() => {
  cleanup();
  storage.pending.clear();
});

describe('useAssetDisplaySource', () => {
  it('never exposes a persisted media handle as a playable URL before it is hydrated', async () => {
    const { result } = renderHook(() => useAssetDisplaySource(VIDEO));
    expect(result.current).toEqual({ url: null, error: null });

    await act(async () => storage.pending.get(VIDEO)?.resolve('blob:session-video'));
    expect(result.current).toEqual({ url: 'blob:session-video', error: null });
  });

  it('drops the previous media URL as soon as the source changes', async () => {
    const { result, rerender } = renderHook(({ source }) => useAssetDisplaySource(source), { initialProps: { source: VIDEO } });
    await act(async () => storage.pending.get(VIDEO)?.resolve('blob:session-video'));

    rerender({ source: AUDIO });
    expect(result.current.url).toBeNull();

    await act(async () => storage.pending.get(AUDIO)?.resolve('blob:session-audio'));
    expect(result.current.url).toBe('blob:session-audio');
  });

  it('reports missing persisted media instead of rendering a broken element', async () => {
    const { result } = renderHook(() => useAssetDisplaySource(AUDIO));
    await act(async () => storage.pending.get(AUDIO)?.reject(new Error('Persisted asset media is missing')));
    expect(result.current.url).toBeNull();
    expect(result.current.error).toMatch(/missing/);
  });

  it('passes through sources that browsers can load directly', () => {
    expect(renderHook(() => useAssetDisplaySource('https://media.example/clip.mp4')).result.current.url).toBe('https://media.example/clip.mp4');
    expect(renderHook(() => useAssetDisplaySource(null)).result.current).toEqual({ url: null, error: null });
  });
});
