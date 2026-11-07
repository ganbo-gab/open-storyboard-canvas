import { canvasToPng, readMediaBlob, waitForMediaTask } from './resources';
import { checkMediaEditAbort, MediaEditError, type MediaEditCapability, type MediaEditOperation, type MediaEditOptions, type ProcessedMedia } from './types';

export function getTransformedImageDimensions(width: number, height: number, rotate: 0 | 90 | 180 | 270): { width: number; height: number } {
  return rotate === 90 || rotate === 270 ? { width: height, height: width } : { width, height };
}

async function decodeImage(blob: Blob, signal?: AbortSignal): Promise<{ image: CanvasImageSource; width: number; height: number; close(): void }> {
  checkMediaEditAbort(signal);
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap;
    try { bitmap = await waitForMediaTask(createImageBitmap(blob), signal, (late) => late.close()); }
    catch (cause) { checkMediaEditAbort(signal); throw new MediaEditError('no-image-decoder', { cause }); }
    if (signal?.aborted) { bitmap.close(); checkMediaEditAbort(signal); }
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  if (typeof Image === 'undefined') throw new MediaEditError('no-image-decoder');
  const image = new Image();
  const url = URL.createObjectURL(blob);
  let abort = () => { image.src = ''; };
  // Image loading must work on WebKit versions predating Promise.withResolvers.
  const promise = new Promise<void>((resolve, reject) => {
    abort = () => { image.src = ''; reject(new MediaEditError('aborted')); };
    image.onload = () => resolve();
    image.onerror = () => reject(new MediaEditError('no-image-decoder'));
    signal?.addEventListener('abort', abort, { once: true });
    image.src = url;
  });
  try {
    await promise;
    checkMediaEditAbort(signal);
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => { image.src = ''; URL.revokeObjectURL(url); } };
  } catch (error) { image.src = ''; URL.revokeObjectURL(url); throw error; }
  finally { image.onload = null; image.onerror = null; signal?.removeEventListener('abort', abort); }
}


export async function getImageEditCapability(source?: string, options: MediaEditOptions = {}): Promise<MediaEditCapability> {
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') return { supported: false, reason: 'no-canvas' };
  if (!source) return { supported: true };
  try {
    const decoded = await decodeImage(await readMediaBlob(source, options.signal), options.signal);
    try { return { supported: decoded.width > 0 && decoded.height > 0, reason: decoded.width > 0 && decoded.height > 0 ? undefined : 'no-image-decoder' }; }
    finally { decoded.close(); }
  } catch (cause) { return { supported: false, reason: cause instanceof MediaEditError ? cause.code : 'no-image-decoder' }; }
}
export async function processImageEdit(source: string, operation: Extract<MediaEditOperation, { kind: 'image.transform' }>, options: MediaEditOptions): Promise<ProcessedMedia> {
  const decoded = await decodeImage(await readMediaBlob(source, options.signal), options.signal);
  let canvas: HTMLCanvasElement | OffscreenCanvas | undefined;
  try {
    const { width, height } = getTransformedImageDimensions(decoded.width, decoded.height, operation.rotate);
    if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') throw new MediaEditError('no-canvas');
    canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new MediaEditError('no-canvas');
    context.translate(width / 2, height / 2);
    // Flips apply in the displayed (rotated) coordinate system.
    context.scale(operation.flipX ? -1 : 1, operation.flipY ? -1 : 1);
    context.rotate(operation.rotate * Math.PI / 180);
    context.drawImage(decoded.image, -decoded.width / 2, -decoded.height / 2);
    checkMediaEditAbort(options.signal);
    const blob = await waitForMediaTask(canvasToPng(canvas), options.signal);
    checkMediaEditAbort(options.signal);
    return { processing: 'image-transform', outputs: [{ kind: 'image', blob, width, height }] };
  } finally {
    decoded.close();
    if (canvas) canvas.width = canvas.height = 0;
  }
}
