import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate';
import { z } from 'zod';

interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const MAX_BYTES = 32 * 1024 * 1024;
const envelopeSchema = z.strictObject({ version: z.literal(1), bytes: z.number().int().min(0).max(MAX_BYTES), gzip: z.string().max(MAX_BYTES * 2) });
const packedKey = (key: string) => `${key}:packed:v1`;
function encode(value: string): string {
  const bytes = strToU8(value);
  if (bytes.length > MAX_BYTES) throw new Error('Agent record exceeds the storage size limit.');
  const gzip = gzipSync(bytes, { level: 1 });
  let binary = '';
  for (let offset = 0; offset < gzip.length; offset += 8192) binary += String.fromCharCode(...gzip.subarray(offset, offset + 8192));
  return JSON.stringify({ version: 1, bytes: bytes.length, gzip: btoa(binary) });
}
function decode(value: string): string {
  const packed = envelopeSchema.parse(JSON.parse(value));
  const gzip = Uint8Array.from(atob(packed.gzip), character => character.charCodeAt(0));
  if (gzip.length < 18 || new DataView(gzip.buffer).getUint32(gzip.length - 4, true) !== packed.bytes) throw new Error('Invalid Agent storage size.');
  const result = gunzipSync(gzip, { out: new Uint8Array(packed.bytes) });
  const verified = gzipSync(result, { level: 1 });
  if (new DataView(verified.buffer).getUint32(verified.length - 8, true) !== new DataView(gzip.buffer).getUint32(gzip.length - 8, true)) throw new Error('Invalid Agent storage checksum.');
  return strFromU8(result);
}

/** Lossless storage only: history, idempotency and SDK recovery payloads are never summarized.
 * The separate versioned key prevents older apps from overwriting packed records.
 * Commit and read back before removing legacy bytes; failed migration leaves them intact. */
export function createAgentCompressedStorage(storage: StoragePort): StoragePort {
  const cache = new Map<string, { packed: string; text: string }>();
  const save = (key: string, value: string) => {
    const packed = encode(value), target = packedKey(key);
    storage.setItem(target, packed);
    if (storage.getItem(target) !== packed) throw new Error('Agent storage write could not be verified.');
    cache.set(key, { packed, text: value });
    try { storage.removeItem(key); } catch { /* New committed record remains authoritative. */ }
  };
  return {
    getItem(key) {
      const packed = storage.getItem(packedKey(key));
      if (packed !== null) {
        const previous = cache.get(key);
        if (previous?.packed === packed) return previous.text;
        const text = decode(packed);
        cache.set(key, { packed, text });
        return text;
      }
      const legacy = storage.getItem(key);
      if (legacy !== null) {
        try { save(key, legacy); } catch { /* Keep readable legacy data if storage is still full. */ }
      }
      return legacy;
    },
    setItem: save,
    removeItem(key) {
      storage.removeItem(packedKey(key));
      storage.removeItem(key);
      cache.delete(key);
    },
  };
}
