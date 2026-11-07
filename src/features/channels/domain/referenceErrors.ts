import type { JobRef } from '../runtime/types';

export function isPublicReferenceUrl(source: string): boolean {
  try {
    const url = new URL(source);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

export class ReferenceNeedsPublicUrlError extends Error {
  readonly code = 'reference.needsPublicUrl';
  readonly slotKey: string;
  /** Only image slots can be offered to the configured image host. */
  readonly slotKind: JobRef['kind'];
  constructor(ref: Pick<JobRef, 'slot' | 'kind'>) {
    const slot = ref.slot ?? ref.kind;
    super(`参考槽位 ${slot} 需要上游可访问的 HTTP(S) URL；本地素材不会自动上传。`);
    this.name = 'ReferenceNeedsPublicUrlError';
    this.slotKey = slot;
    this.slotKind = ref.kind;
  }
}

export interface ReferenceUrlFailure {
  slotKey: string;
  /** Absent on records persisted before the kind was carried; such failures offer no upload. */
  slotKind?: JobRef['kind'];
}

function isSlotKind(value: unknown): value is JobRef['kind'] {
  return value === 'image' || value === 'video' || value === 'audio';
}

/** Reads the failure structurally: the thrown value may come through a gateway that re-wraps classes. */
export function referenceUrlFailureOf(error: unknown): ReferenceUrlFailure | null {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'reference.needsPublicUrl') return null;
  if (!('slotKey' in error) || typeof error.slotKey !== 'string') return null;
  const slotKind = 'slotKind' in error && isSlotKind(error.slotKind) ? error.slotKind : undefined;
  return slotKind ? { slotKey: error.slotKey, slotKind } : { slotKey: error.slotKey };
}
