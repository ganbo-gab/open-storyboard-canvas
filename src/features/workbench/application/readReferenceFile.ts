import type { WorkbenchReference } from '../domain/types';

export const isReferenceFile = (file: File) => /^(image|video|audio)\//.test(file.type);

/** Reads a picked/dropped/pasted media file into a draft reference (data URL; the store externalizes it). */
export function readReferenceFile(file: File): Promise<WorkbenchReference> {
  if (!isReferenceFile(file)) return Promise.reject(new Error('Unsupported reference file type'));
  const { promise, resolve, reject } = Promise.withResolvers<WorkbenchReference>();
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error);
  reader.onload = () =>
    resolve({
      id: crypto.randomUUID(),
      kind: file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'image',
      source: String(reader.result),
      name: file.name,
    });
  reader.readAsDataURL(file);
  return promise;
}
