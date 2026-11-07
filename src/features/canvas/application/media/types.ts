export type MediaEditOperation =
  | { kind: 'image.transform'; rotate: 0 | 90 | 180 | 270; flipX?: boolean; flipY?: boolean }
  | { kind: 'video.captureFrame'; timeSeconds: number }
  | { kind: 'video.trim'; startSeconds: number; endSeconds: number }
  | { kind: 'video.crop'; rect: { x: number; y: number; width: number; height: number } }
  | { kind: 'video.separateAudio' }
  | { kind: 'audio.slice'; startSeconds: number; endSeconds: number }
  | { kind: 'audio.split'; atSeconds: number[] }
  | { kind: 'audio.rate'; rate: number };

export interface MediaEditCapability { supported: boolean; reason?: string }
export type MediaEditErrorCode =
  | 'aborted' | 'invalid-operation' | 'invalid-range' | 'wrong-node-kind' | 'missing-node'
  | 'missing-source' | 'stale-source' | 'no-webcodecs' | 'no-video-encoder'
  | 'no-video-decoder' | 'no-audio-decoder' | 'no-audio-encoder' | 'no-audio-track' | 'no-video-track'
  | 'no-image-decoder' | 'unsupported-container' | 'no-canvas' | 'read-failed' | 'processing-failed' | 'persistence-failed';
export class MediaEditError extends Error {
  readonly cause?: unknown;
  constructor(public readonly code: MediaEditErrorCode, options?: { cause?: unknown }) {
    super(code);
    this.name = 'MediaEditError';
    this.cause = options?.cause;
  }
}
export interface MediaEditOptions { signal?: AbortSignal; onProgress?(fraction: number): void }
export type MediaEditProcessing = 'stream-copy' | 're-encode' | 'decoded-pcm' | 'image-transform';
export interface MediaEditResult { nodeIds: string[]; processing: MediaEditProcessing }
export interface EditedMedia {
  kind: 'image' | 'video' | 'audio';
  blob: Blob;
  width?: number;
  height?: number;
  durationSeconds?: number;
  /** Source-time bounds, in seconds; split segments are ordered and contiguous. */
  sourceRange?: { startSeconds: number; endSeconds: number };
}
export interface ProcessedMedia { outputs: EditedMedia[]; processing: MediaEditProcessing }
export function checkMediaEditAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MediaEditError('aborted');
}
export function validateMediaEditOperation(operation: MediaEditOperation): void {
  if (!operation || typeof operation !== 'object') throw new MediaEditError('invalid-operation');
  switch (operation.kind) {
    case 'image.transform':
      if (![0, 90, 180, 270].includes(operation.rotate)
        || (operation.flipX !== undefined && typeof operation.flipX !== 'boolean')
        || (operation.flipY !== undefined && typeof operation.flipY !== 'boolean')) throw new MediaEditError('invalid-operation');
      return;
    case 'video.captureFrame':
      if (!Number.isFinite(operation.timeSeconds) || operation.timeSeconds < 0) throw new MediaEditError('invalid-range');
      return;
    case 'video.trim':
    case 'audio.slice':
      validateMediaTimeRange(operation.startSeconds, operation.endSeconds);
      return;
    case 'video.crop': {
      const rect = operation.rect;
      if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
        || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
        || rect.x + rect.width > 1 || rect.y + rect.height > 1) throw new MediaEditError('invalid-range');
      return;
    }
    case 'video.separateAudio': return;
    case 'audio.split':
      if (!Array.isArray(operation.atSeconds) || operation.atSeconds.length === 0
        || operation.atSeconds.some((time, index, times) => !Number.isFinite(time) || time <= 0 || (index > 0 && time <= times[index - 1]))) throw new MediaEditError('invalid-range');
      return;
    case 'audio.rate':
      if (!Number.isFinite(operation.rate) || operation.rate < 0.5 || operation.rate > 2) throw new MediaEditError('invalid-range');
      return;
    default: throw new MediaEditError('invalid-operation');
  }
}
export function validateMediaTimeRange(start: number, end: number, duration = Infinity): void {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration) throw new MediaEditError('invalid-range');
}
