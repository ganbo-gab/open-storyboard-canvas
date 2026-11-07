import type { AssetKind, AssetRecord } from './assetCatalog';
import { saveAsset } from './assetCatalog';
import { readFileAsDataUrl, loadImageElement, reduceAspectRatio } from '@/features/canvas/application/imageData';

const textMimeTypes: Record<string, true> = {
  'application/json': true,
  'application/ld+json': true,
  'application/x-subrip': true,
};
const textExtensions: Record<string, true> = { txt: true, md: true, markdown: true, csv: true, json: true, srt: true, vtt: true };

/** Unknown binary files are not screenplay text or images merely because they were picked. */
export function assetFileKind(file: Pick<File, 'name' | 'type'>): AssetKind | null {
  const mime = file.type.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/') || textMimeTypes[mime] === true) return 'text';
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  return (!mime || mime === 'application/octet-stream') && textExtensions[extension] === true ? 'text' : null;
}

async function readVisualMetadata(source: string, kind: 'image' | 'video'): Promise<Record<string, unknown>> {
  if (kind === 'image') {
    const image = await loadImageElement(source);
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error('Image dimensions are unavailable');
    return { width: image.naturalWidth, height: image.naturalHeight,
      aspectRatio: reduceAspectRatio(image.naturalWidth, image.naturalHeight), resolution: `${image.naturalWidth}x${image.naturalHeight}` };
  }
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const video = document.createElement('video');
  const cleanup = () => { video.onloadedmetadata = null; video.onerror = null; video.removeAttribute('src'); video.load(); };
  video.preload = 'metadata';
  video.onloadedmetadata = () => {
    const width = video.videoWidth; const height = video.videoHeight; const duration = video.duration;
    cleanup();
    if (width <= 0 || height <= 0) { reject(new Error('Video dimensions are unavailable')); return; }
    resolve({ width, height, aspectRatio: reduceAspectRatio(width, height), resolution: `${width}x${height}`,
      ...(Number.isFinite(duration) ? { durationSeconds: duration } : {}) });
  };
  video.onerror = () => { cleanup(); reject(new Error('Cannot read video metadata')); };
  video.src = source;
  return await promise;
}

/** Durable upload boundary shared by file pickers, drops and future command consumers. */
export async function importAssetFile(file: File): Promise<AssetRecord> {
  const kind = assetFileKind(file);
  if (!kind) throw new Error('Unsupported asset file type');
  const source = kind === 'text' ? await file.text() : await readFileAsDataUrl(file);
  const visual = kind === 'image' || kind === 'video' ? await readVisualMetadata(source, kind) : {};
  return await saveAsset({ kind, source, name: file.name, origin: 'uploaded',
    metadata: { originalFileName: file.name, mime: file.type, size: file.size, ...visual } });
}
