import { persistVideoSource } from '@/commands/image';
import type { VideoNodeData } from '@/features/canvas/domain/canvasNodes';

const DEFAULT_VIDEO_ASPECT_RATIO = '16:9';
const VIDEO_METADATA_TIMEOUT_MS = 8000;

interface VideoFileMetadata {
  aspectRatio: string;
  durationSeconds: number | null;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read video file'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      result ? resolve(result) : reject(new Error('Failed to read video file'));
    };
    reader.readAsDataURL(file);
  });
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.round(left));
  let b = Math.abs(Math.round(right));
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

function formatVideoAspectRatio(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return DEFAULT_VIDEO_ASPECT_RATIO;
  }

  const divisor = greatestCommonDivisor(width, height);
  const ratioWidth = Math.max(1, Math.round(width / divisor));
  const ratioHeight = Math.max(1, Math.round(height / divisor));
  return `${ratioWidth}:${ratioHeight}`;
}

function readVideoFileMetadata(file: File): Promise<VideoFileMetadata> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    let isDone = false;

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };

    const finish = (metadata: VideoFileMetadata) => {
      if (isDone) {
        return;
      }
      isDone = true;
      window.clearTimeout(timeoutId);
      cleanup();
      resolve(metadata);
    };

    const timeoutId = window.setTimeout(() => {
      finish({
        aspectRatio: DEFAULT_VIDEO_ASPECT_RATIO,
        durationSeconds: null,
      });
    }, VIDEO_METADATA_TIMEOUT_MS);

    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : null;
      finish({
        aspectRatio: formatVideoAspectRatio(video.videoWidth, video.videoHeight),
        durationSeconds: duration,
      });
    };
    video.onerror = () => {
      finish({
        aspectRatio: DEFAULT_VIDEO_ASPECT_RATIO,
        durationSeconds: null,
      });
    };
    video.src = objectUrl;
  });
}

export async function prepareVideoNodeDataFromFile(file: File): Promise<Partial<VideoNodeData>> {
  const metadataPromise = readVideoFileMetadata(file);
  const localVideoUrl = await readFileAsDataUrl(file).then((dataUrl) => persistVideoSource(dataUrl));
  const metadata = await metadataPromise;

  return {
    videoUrl: localVideoUrl,
    localVideoUrl,
    thumbnailUrl: null,
    aspectRatio: metadata.aspectRatio,
    durationSeconds: metadata.durationSeconds,
    sourceFileName: file.name,
    sourceType: 'upload',
    sourcePrompt: '',
    sourceReferenceCount: 0,
    generatedFileName: null,
    generatedNamingMode: 'default',
    generatedSequence: null,
    generatedDateStamp: null,
    isGenerating: false,
    generationStartedAt: null,
    generationElapsedMs: null,
    generationJobId: null,
    generationProviderId: null,
    generationClientSessionId: null,
    generationError: null,
    generationErrorDetails: null,
    generationRetryResultUrl: null,
    generationRetryRequestedAt: null,
  };
}
