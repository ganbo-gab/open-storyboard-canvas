import { isTauri } from '@tauri-apps/api/core';
import { loadAudioSourceDataUrl } from '@/commands/image';
import { getAssetDisplaySource } from '@/features/assets/application/assetMediaStorage';
import { resolveImageDisplayUrl } from '../imageData';
import { checkMediaEditAbort, MediaEditError } from './types';

/** Native decode/init APIs are not abortable. Settle promptly and release late resources. */
export function waitForMediaTask<T>(task: Promise<T>, signal?: AbortSignal, releaseLate?: (value: T) => void | Promise<void>): Promise<T> {
  if (!signal) return task;
  // This application targets ES2020 and older WebKit without Promise.withResolvers.
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const abort = () => {
      signal.removeEventListener('abort', abort);
      aborted = true;
      reject(new MediaEditError('aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void task.then((value) => {
      signal.removeEventListener('abort', abort);
      if (!aborted) { resolve(value); return; }
      try {
        const released = releaseLate?.(value);
        if (released) void released.catch(() => undefined);
      } catch { /* The canceled caller has already settled; never leak a cleanup rejection. */ }
    }, (cause: unknown) => {
      signal.removeEventListener('abort', abort);
      if (!aborted) reject(cause);
    });
    if (signal.aborted) abort();
  });
}
export async function readMediaBlob(source: string, signal?: AbortSignal, audio = false): Promise<Blob> {
  checkMediaEditAbort(signal);
  try {
    const display = resolveImageDisplayUrl(await waitForMediaTask(getAssetDisplaySource(source), signal));
    const response = await fetch(display, { signal });
    if (!response.ok) throw new MediaEditError('read-failed');
    const blob = await waitForMediaTask(response.blob(), signal);
    if (!blob.size) throw new MediaEditError('read-failed');
    checkMediaEditAbort(signal);
    return blob;
  } catch (cause) {
    checkMediaEditAbort(signal);
    if (audio && isTauri() && !/^(https?:|data:|blob:|asset-media:)/i.test(source)) {
      try {
        const dataUrl = await waitForMediaTask(loadAudioSourceDataUrl(source), signal);
        const response = await fetch(dataUrl, { signal });
        const blob = await waitForMediaTask(response.blob(), signal);
        checkMediaEditAbort(signal);
        if (response.ok && blob.size) return blob;
      } catch (fallbackCause) {
        checkMediaEditAbort(signal);
        throw new MediaEditError('read-failed', { cause: fallbackCause });
      }
    }
    throw new MediaEditError('read-failed', { cause });
  }
}

export function canvasToPng(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' });
  // Callback adapter also runs on older WebKit without Promise.withResolvers.
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new MediaEditError('processing-failed'));
  }, 'image/png'));
}
