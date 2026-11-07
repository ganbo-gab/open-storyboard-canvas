import { readFile } from 'node:fs/promises';
import { Conversion, Output } from 'mediabunny';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processAudioEdit, type PcmAudio } from './audio';
import { processImageEdit } from './image';
import { processVideoEdit } from './video';

async function audioSource(): Promise<string> {
  const bytes = await readFile(new URL('./fixture-audio.wav', import.meta.url));
  return `data:audio/wav;base64,${bytes.toString('base64')}`;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('media decoder lifetime', () => {
  it('releases an audio context on decode failure', async () => {
    const close = vi.fn(async () => undefined);
    vi.stubGlobal('AudioContext', class {
      close = close;
      async decodeAudioData() { throw new Error('undecodable'); }
    });
    await expect(processAudioEdit(await audioSource(), { kind: 'audio.slice', startSeconds: 0, endSeconds: 0.1 }, {}))
      .rejects.toMatchObject({ code: 'no-audio-decoder' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('settles cancellation and closes the audio context without waiting for decoding to finish', async () => {
    const controller = new AbortController();
    let decodingStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { decodingStarted = resolve; });
    let finishDecode: (buffer: PcmAudio) => void = () => undefined;
    const decoding = new Promise<PcmAudio>((resolve) => { finishDecode = resolve; });
    const close = vi.fn(async () => undefined);
    vi.stubGlobal('AudioContext', class {
      close = close;
      decodeAudioData() { decodingStarted(); return decoding; }
    });
    const pending = processAudioEdit(await audioSource(), { kind: 'audio.slice', startSeconds: 0, endSeconds: 0.1 }, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(close).toHaveBeenCalledOnce();
    // Late native completion must not restart work or close the context a second time.
    finishDecode({ length: 8000, sampleRate: 8000, numberOfChannels: 1, getChannelData: () => new Float32Array(8000) });
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes an image bitmap delivered after cancellation', async () => {
    const controller = new AbortController();
    let decodingStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { decodingStarted = resolve; });
    const close = vi.fn();
    let finishDecode: (bitmap: Pick<ImageBitmap, 'width' | 'height' | 'close'>) => void = () => undefined;
    const decoding = new Promise<Pick<ImageBitmap, 'width' | 'height' | 'close'>>((resolve) => { finishDecode = resolve; });
    vi.stubGlobal('createImageBitmap', () => { decodingStarted(); return decoding; });
    const pending = processImageEdit('data:image/png;base64,AQID', { kind: 'image.transform', rotate: 90 }, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    finishDecode({ width: 2, height: 1, close });
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
  });

  it('settles cancellation during conversion initialization and releases the late output', async () => {
    const bytes = await readFile(new URL('./fixture-video.webm', import.meta.url));
    const controller = new AbortController();
    let initialized: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { initialized = resolve; });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const initialize = Conversion.init.bind(Conversion);
    vi.spyOn(Conversion, 'init').mockImplementation(async (...args) => {
      const conversion = await initialize(...args);
      initialized();
      await blocked;
      return conversion;
    });
    const cancel = vi.spyOn(Output.prototype, 'cancel');
    const pending = processVideoEdit(`data:video/webm;base64,${bytes.toString('base64')}`, { kind: 'video.trim', startSeconds: 0, endSeconds: 0.2 }, { signal: controller.signal });
    await started;
    controller.abort();
    try { await expect(pending).rejects.toMatchObject({ code: 'aborted' }); }
    finally { release(); }
    await Promise.resolve();
    expect(cancel).toHaveBeenCalled();
  });
});
