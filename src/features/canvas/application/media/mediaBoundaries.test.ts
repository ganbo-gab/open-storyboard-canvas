import { readFile } from 'node:fs/promises';
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMediaEditCapability } from './index';
import { processVideoEdit } from './video';
import { MediaEditError } from './types';

async function videoSource(): Promise<string> {
  const bytes = await readFile(new URL('./fixture-video.webm', import.meta.url));
  return `data:video/webm;base64,${bytes.toString('base64')}`;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('actual media boundaries', () => {
  it('never emits media past a non-packet-aligned trim end', async () => {
    vi.stubGlobal('VideoDecoder', undefined);
    vi.stubGlobal('VideoEncoder', undefined);
    const result = await processVideoEdit(await videoSource(), { kind: 'video.trim', startSeconds: 0, endSeconds: 0.155 }, {})
      .catch((error: unknown) => { if (error instanceof MediaEditError) return error; throw error; });
    if (result instanceof MediaEditError) {
      expect(['no-webcodecs', 'no-video-decoder', 'no-video-encoder']).toContain(result.code);
      return;
    }
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(result.outputs[0].blob) });
    try { expect(await input.computeDuration()).toBeLessThanOrEqual(0.156); }
    finally { input.dispose(); }
  });

  it('keeps an exactly packet-aligned trim as stream-copy without encoder APIs', async () => {
    vi.stubGlobal('VideoDecoder', undefined);
    vi.stubGlobal('VideoEncoder', undefined);
    const result = await processVideoEdit(await videoSource(), { kind: 'video.trim', startSeconds: 0, endSeconds: 0.2 }, {});
    expect(result.processing).toBe('stream-copy');
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(result.outputs[0].blob) });
    try {
      expect(await input.computeDuration()).toBeCloseTo(0.2, 3);
      expect(await input.getPrimaryVideoTrack()).not.toBeNull();
      expect(await input.getPrimaryAudioTrack()).toBeNull();
    } finally { input.dispose(); }
  });

  it('separates real encoded tracks without losing audio pre-roll or rewriting packets', async () => {
    vi.stubGlobal('VideoDecoder', undefined); vi.stubGlobal('VideoEncoder', undefined);
    vi.stubGlobal('AudioDecoder', undefined); vi.stubGlobal('AudioEncoder', undefined);
    const bytes = await readFile(new URL('./fixture-av.webm', import.meta.url));
    const source = `data:video/webm;base64,${bytes.toString('base64')}`;
    const original = new Input({ formats: ALL_FORMATS, source: new BlobSource(await (await fetch(source)).blob()) });
    const result = await processVideoEdit(source, { kind: 'video.separateAudio' }, {});
    expect(result.processing).toBe('stream-copy');
    expect(result.outputs.map((output) => [output.kind, output.blob.type])).toEqual([['video', 'video/webm'], ['audio', 'audio/webm']]);
    try {
      for (const output of result.outputs) {
        const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(output.blob) });
        try {
          const originalTrack = output.kind === 'video' ? await original.getPrimaryVideoTrack() : await original.getPrimaryAudioTrack();
          const track = output.kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
          expect(originalTrack).not.toBeNull(); expect(track).not.toBeNull();
          if (!originalTrack || !track) throw new Error('Missing fixture/output track');
          const originalPackets = [];
          for await (const packet of new EncodedPacketSink(originalTrack).packets()) originalPackets.push({ timestamp: packet.timestamp, data: Array.from(packet.data) });
          const packets = [];
          for await (const packet of new EncodedPacketSink(track).packets()) packets.push({ timestamp: packet.timestamp, data: Array.from(packet.data) });
          expect(packets).toEqual(originalPackets);
          expect(await input.getTracks()).toHaveLength(1);
        } finally { input.dispose(); }
      }
    } finally { original.dispose(); }
  });

  it('does not claim image source support without decoding its bytes', async () => {
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('unsupported image'); }));
    expect(await getMediaEditCapability('image.transform', 'data:image/png;base64,AQID'))
      .toMatchObject({ supported: false });
  });

  it('reports an unavailable audio context as a capability result rather than throwing', async () => {
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('audio context unavailable'); } });
    expect(await getMediaEditCapability('audio.slice', 'data:audio/wav;base64,AQID'))
      .toEqual({ supported: false, reason: 'no-audio-decoder' });
  });
});
