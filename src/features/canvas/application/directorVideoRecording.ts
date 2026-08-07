export type DirectorVideoResolution = '720p' | '1080p';
export type DirectorVideoFps = 24 | 30;

export interface DirectorVideoFormat {
  mimeType: string;
  extension: 'mp4' | 'webm';
}

export interface DirectorRecordedVideo extends DirectorVideoFormat {
  blob: Blob;
  durationSeconds: number;
  width: number;
  height: number;
  fps: DirectorVideoFps;
}

export interface DirectorRecordingProgress {
  progress: number;
  elapsedSeconds: number;
  remainingSeconds: number;
}

interface RecorderLike {
  mimeType: string;
  state: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: { error?: Error }) => void) | null;
  start: (timeslice?: number) => void;
  stop: () => void;
}

interface StreamLike {
  getTracks: () => Array<{ stop: () => void }>;
}

export interface DirectorRecordingPlatform {
  now: () => number;
  scheduleFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
  captureStream: (canvas: HTMLCanvasElement, fps: number) => StreamLike;
  createRecorder: (stream: StreamLike, options: MediaRecorderOptions) => RecorderLike;
}

export interface RecordDirectorVideoOptions {
  canvas: HTMLCanvasElement;
  durationSeconds: number;
  resolution: DirectorVideoResolution;
  fps: DirectorVideoFps;
  format?: DirectorVideoFormat | null;
  signal?: AbortSignal;
  renderAtTime: (timeSeconds: number) => void | Promise<void>;
  setCleanExportMode: (enabled: boolean, size?: { width: number; height: number }) => void | Promise<void>;
  onProgress?: (progress: DirectorRecordingProgress) => void;
  platform?: DirectorRecordingPlatform;
}

const FORMAT_CANDIDATES: readonly DirectorVideoFormat[] = [
  { mimeType: 'video/mp4;codecs=avc1.42E01E', extension: 'mp4' },
  { mimeType: 'video/mp4', extension: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9', extension: 'webm' },
  { mimeType: 'video/webm;codecs=vp8', extension: 'webm' },
  { mimeType: 'video/webm', extension: 'webm' },
] as const;

export class DirectorRecordingCancelledError extends Error {
  constructor() {
    super('Director Studio video recording was cancelled.');
    this.name = 'DirectorRecordingCancelledError';
  }
}

export function getDirectorVideoResolutionSize(resolution: DirectorVideoResolution): { width: number; height: number } {
  return resolution === '1080p' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
}

export function selectDirectorVideoFormat(
  isTypeSupported: ((mimeType: string) => boolean) | null | undefined =
    typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
      ? MediaRecorder.isTypeSupported.bind(MediaRecorder)
      : null,
): DirectorVideoFormat | null {
  if (!isTypeSupported) return null;
  return FORMAT_CANDIDATES.find((candidate) => isTypeSupported(candidate.mimeType)) ?? null;
}

export function resolveDirectorVideoFormat(actualMimeType: string | null | undefined): DirectorVideoFormat {
  const normalized = actualMimeType?.toLowerCase() ?? '';
  return normalized.includes('mp4')
    ? { mimeType: actualMimeType || 'video/mp4', extension: 'mp4' }
    : { mimeType: actualMimeType || 'video/webm', extension: 'webm' };
}

function getDefaultPlatform(): DirectorRecordingPlatform {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is not available in this runtime.');
  }
  return {
    now: () => performance.now(),
    scheduleFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    captureStream: (canvas, fps) => {
      if (typeof canvas.captureStream !== 'function') {
        throw new Error('Canvas captureStream is not available in this runtime.');
      }
      return canvas.captureStream(fps);
    },
    createRecorder: (stream, options) => new MediaRecorder(stream as MediaStream, options) as unknown as RecorderLike,
  };
}

export async function recordDirectorVideo(options: RecordDirectorVideoOptions): Promise<DirectorRecordedVideo> {
  const format = options.format ?? selectDirectorVideoFormat();
  if (!format) {
    throw new Error('This runtime cannot record MP4 or WebM video.');
  }
  const durationSeconds = Math.max(0.05, options.durationSeconds);
  const size = getDirectorVideoResolutionSize(options.resolution);
  const platform = options.platform ?? getDefaultPlatform();
  let stream: StreamLike | null = null;
  let frameHandle: number | null = null;
  let recorder: RecorderLike | null = null;
  let cancelled = options.signal?.aborted === true;
  let abortHandler: (() => void) | null = null;

  try {
    await options.setCleanExportMode(true, size);
    if (options.signal?.aborted) throw new DirectorRecordingCancelledError();
    await options.renderAtTime(0);
    if (options.signal?.aborted) throw new DirectorRecordingCancelledError();
    stream = platform.captureStream(options.canvas, options.fps);
    recorder = platform.createRecorder(stream, { mimeType: format.mimeType, videoBitsPerSecond: 12_000_000 });
    const chunks: Blob[] = [];
    const startedAt = platform.now();

    const result = await new Promise<DirectorRecordedVideo>((resolve, reject) => {
      let settled = false;
      const finishWithError = (error: Error) => {
        if (settled) return;
        settled = true;
        if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
        reject(error);
      };
      abortHandler = () => {
        cancelled = true;
        if (recorder?.state === 'inactive') {
          finishWithError(new DirectorRecordingCancelledError());
          return;
        }
        try {
          recorder?.stop();
        } catch {
          finishWithError(new DirectorRecordingCancelledError());
        }
      };
      options.signal?.addEventListener('abort', abortHandler, { once: true });

      recorder!.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder!.onerror = (event) => {
        finishWithError(event.error ?? new Error('MediaRecorder failed.'));
        try {
          if (recorder?.state !== 'inactive') recorder?.stop();
        } catch {
          // The original recorder error remains the useful failure.
        }
      };
      recorder!.onstop = () => {
        if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
        if (settled) return;
        if (cancelled) {
          finishWithError(new DirectorRecordingCancelledError());
          return;
        }
        const actualFormat = resolveDirectorVideoFormat(recorder?.mimeType || chunks[0]?.type || format.mimeType);
        const blob = new Blob(chunks, { type: actualFormat.mimeType });
        if (blob.size === 0) {
          finishWithError(new Error('The recorder produced an empty video.'));
          return;
        }
        if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
        settled = true;
        resolve({
          ...actualFormat,
          blob,
          durationSeconds,
          width: size.width,
          height: size.height,
          fps: options.fps,
        });
      };

      const tick = async () => {
        if (settled || cancelled) return;
        const elapsedSeconds = Math.max(0, (platform.now() - startedAt) / 1000);
        const timelineTime = Math.min(durationSeconds, elapsedSeconds);
        try {
          await options.renderAtTime(timelineTime);
        } catch (error) {
          finishWithError(error instanceof Error ? error : new Error('Failed to render a recording frame.'));
          try {
            if (recorder?.state !== 'inactive') recorder?.stop();
          } catch {
            // The render error remains the useful failure.
          }
          return;
        }
        if (settled || cancelled) return;
        options.onProgress?.({
          progress: Math.min(1, timelineTime / durationSeconds),
          elapsedSeconds: timelineTime,
          remainingSeconds: Math.max(0, durationSeconds - timelineTime),
        });
        if (elapsedSeconds >= durationSeconds) {
          if (recorder?.state !== 'inactive') recorder?.stop();
          return;
        }
        frameHandle = platform.scheduleFrame(() => { void tick(); });
      };

      try {
        recorder!.start(250);
        frameHandle = platform.scheduleFrame(() => { void tick(); });
      } catch (error) {
        finishWithError(error instanceof Error ? error : new Error('MediaRecorder could not start.'));
        try {
          if (recorder?.state !== 'inactive') recorder?.stop();
        } catch {
          // The start error remains the useful failure.
        }
      }
    });

    return result;
  } finally {
    if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
    if (frameHandle !== null) platform.cancelFrame(frameHandle);
    try {
      if (recorder?.state !== 'inactive') recorder?.stop();
    } catch {
      // Stream and export-mode cleanup must still run.
    }
    stream?.getTracks().forEach((track) => track.stop());
    await options.setCleanExportMode(false);
  }
}

export function downloadDirectorVideo(video: DirectorRecordedVideo, baseName = 'director-studio-preview'): void {
  const source = URL.createObjectURL(video.blob);
  const anchor = document.createElement('a');
  anchor.href = source;
  anchor.download = `${baseName}.${video.extension}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(source), 0);
}

export async function directorVideoBlobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('Could not encode the recorded video.'));
    reader.onerror = () => reject(reader.error ?? new Error('Could not encode the recorded video.'));
    reader.readAsDataURL(blob);
  });
}
