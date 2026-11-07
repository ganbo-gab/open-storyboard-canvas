import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, VideoSampleSink } from 'mediabunny';
import { getMediaEditCapability, processMediaEdit } from './index';
import { canvasToPng } from './resources';
import { MediaEditError, type EditedMedia, type MediaEditOperation, type MediaEditProcessing } from './types';

export interface MediaSmokeOutput {
  operation: MediaEditOperation['kind'];
  processing: MediaEditProcessing;
  kind: EditedMedia['kind'];
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  decodedSamples: number;
}
export interface MediaSmokeReport {
  outputs: MediaSmokeOutput[];
  unsupported: { operation: MediaEditOperation['kind']; reason: string }[];
  sourceBytesUnchanged: boolean;
  canceledBeforeWork: boolean;
}

function requireSmoke(condition: boolean, detail: string): asserts condition {
  if (!condition) throw new Error(`Media smoke: ${detail}`);
}
async function fixture(name: 'fixture-video.webm' | 'fixture-av.webm' | 'fixture-audio.wav'): Promise<Blob> {
  // Explicit URLs allow Vite to serve/copy these real test-only fixtures without a filesystem API.
  const urls = {
    'fixture-video.webm': new URL('./fixture-video.webm', import.meta.url),
    'fixture-av.webm': new URL('./fixture-av.webm', import.meta.url),
    'fixture-audio.wav': new URL('./fixture-audio.wav', import.meta.url),
  };
  const response = await fetch(urls[name]);
  requireSmoke(response.ok, `fixture read ${name}`);
  return await response.blob();
}
async function decodeOutput(output: EditedMedia, context: AudioContext): Promise<number> {
  const bytes = await output.blob.arrayBuffer();
  requireSmoke(bytes.byteLength > 0, 'empty output');
  if (output.kind === 'image') {
    requireSmoke(output.blob.type === 'image/png', 'image MIME');
    requireSmoke(new Uint8Array(bytes)[0] === 0x89, 'PNG signature');
    const bitmap = await createImageBitmap(output.blob);
    try { requireSmoke(bitmap.width === output.width && bitmap.height === output.height, 'decoded image dimensions'); }
    finally { bitmap.close(); }
    return 1;
  }
  if (output.blob.type === 'audio/wav') {
    requireSmoke(new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF', 'WAV signature');
    const buffer = await context.decodeAudioData(bytes);
    requireSmoke(Math.abs(buffer.duration - (output.durationSeconds ?? -1)) <= 1 / buffer.sampleRate, 'decoded WAV duration');
    return buffer.length;
  }
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(output.blob) });
  try {
    requireSmoke(await input.canRead(), 'encoded output container');
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (output.kind === 'audio') requireSmoke(!video && !!audio && output.blob.type.startsWith('audio/'), 'audio-only output');
    else requireSmoke(!!video && output.blob.type.startsWith('video/'), 'video output');
    let count = 0;
    if (video) {
      requireSmoke(await video.getDisplayWidth() === output.width && await video.getDisplayHeight() === output.height, 'encoded video dimensions');
      for await (const sample of new VideoSampleSink(video).samples()) { count++; sample.close(); }
    }
    if (audio) for await (const sample of new AudioSampleSink(audio).samples()) { count++; sample.close(); }
    requireSmoke(count > 0, 'no output samples decoded');
    const duration = await input.computeDuration();
    requireSmoke(Math.abs(duration - (output.durationSeconds ?? -1)) <= 0.002, 'encoded output duration');
    return count;
  } finally { input.dispose(); }
}

/**
 * Nonvisual browser smoke: import this module from an isolated Vite origin, then
 * await runMediaDecodeSmoke(). No providers, graph edits, persistence, or FFmpeg.
 * Required complete surface: PNG bitmap/canvas, Web Audio + OfflineAudioContext,
 * VP8 decoder/encoder and Opus decoder. Unsupported paths are reported, not faked.
 */
export async function runMediaDecodeSmoke(): Promise<MediaSmokeReport> {
  const urls: string[] = [];
  const context = new AudioContext();
  const report: MediaSmokeReport = { outputs: [], unsupported: [], sourceBytesUnchanged: false, canceledBeforeWork: false };
  try {
    const [video, av, audio] = await Promise.all([fixture('fixture-video.webm'), fixture('fixture-av.webm'), fixture('fixture-audio.wav')]);
    const canvas = new OffscreenCanvas(2, 1);
    const drawing = canvas.getContext('2d');
    requireSmoke(!!drawing, 'image fixture canvas');
    drawing.fillStyle = '#ff0000'; drawing.fillRect(0, 0, 1, 1);
    drawing.fillStyle = '#0000ff'; drawing.fillRect(1, 0, 1, 1);
    const image = await canvasToPng(canvas);
    canvas.width = canvas.height = 0;
    const blobs = { video, av, audio, image };
    const originalHashes = await Promise.all(Object.values(blobs).map(async (blob) => new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())).join(',')));
    const sources = { video: URL.createObjectURL(video), av: URL.createObjectURL(av), audio: URL.createObjectURL(audio), image: URL.createObjectURL(image) };
    urls.push(...Object.values(sources));
    const operations: { source: string; operation: MediaEditOperation }[] = [
      { source: sources.image, operation: { kind: 'image.transform', rotate: 90, flipY: true } },
      { source: sources.video, operation: { kind: 'video.captureFrame', timeSeconds: 0.25 } },
      { source: sources.video, operation: { kind: 'video.trim', startSeconds: 0, endSeconds: 0.2 } },
      { source: sources.video, operation: { kind: 'video.trim', startSeconds: 0.25, endSeconds: 0.755 } },
      { source: sources.video, operation: { kind: 'video.crop', rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } } },
      { source: sources.av, operation: { kind: 'video.separateAudio' } },
      { source: sources.audio, operation: { kind: 'audio.slice', startSeconds: 0.125, endSeconds: 0.625 } },
      { source: sources.audio, operation: { kind: 'audio.split', atSeconds: [0.125, 0.625] } },
      { source: sources.audio, operation: { kind: 'audio.rate', rate: 0.5 } },
      { source: sources.audio, operation: { kind: 'audio.rate', rate: 2 } },
    ];
    for (const { source, operation } of operations) {
      const capability = await getMediaEditCapability(operation.kind, source);
      if (!capability.supported) {
        report.unsupported.push({ operation: operation.kind, reason: capability.reason ?? 'unsupported-container' });
        continue;
      }
      let processed;
      try { processed = await processMediaEdit(source, operation); }
      catch (error) {
        // Trim capability cannot promise encoders for a not-yet-specified boundary.
        if (operation.kind === 'video.trim' && error instanceof MediaEditError
          && ['no-webcodecs', 'no-video-decoder', 'no-audio-decoder', 'no-video-encoder', 'no-audio-encoder'].includes(error.code)) {
          report.unsupported.push({ operation: operation.kind, reason: error.code });
          continue;
        }
        throw error;
      }
      for (const output of processed.outputs) {
        if (operation.kind === 'video.trim') requireSmoke(Math.abs((output.durationSeconds ?? -1) - (operation.endSeconds - operation.startSeconds)) <= 0.002, 'precise trim duration');
        if (operation.kind === 'video.crop') requireSmoke(output.width === 32 && output.height === 24, 'crop dimensions');
        if (operation.kind === 'image.transform') {
          requireSmoke(output.width === 1 && output.height === 2, 'rotation dimensions');
          const bitmap = await createImageBitmap(output.blob);
          const check = new OffscreenCanvas(1, 2);
          try {
            const pixels = check.getContext('2d');
            requireSmoke(!!pixels, 'pixel validation canvas');
            pixels.drawImage(bitmap, 0, 0);
            const data = pixels.getImageData(0, 0, 1, 2).data;
            requireSmoke(data[2] === 255 && data[4] === 255, 'display-space mirror pixels');
          } finally { bitmap.close(); check.width = check.height = 0; }
        }
        report.outputs.push({ operation: operation.kind, processing: processed.processing, kind: output.kind, mime: output.blob.type,
          bytes: output.blob.size, width: output.width, height: output.height, durationSeconds: output.durationSeconds,
          decodedSamples: await decodeOutput(output, context) });
      }
      if (operation.kind === 'audio.split') requireSmoke(Math.abs(processed.outputs.reduce((sum, output) => sum + (output.durationSeconds ?? 0), 0) - 1) <= 0.0001, 'split covers all source samples');
      if (operation.kind === 'audio.rate') requireSmoke(Math.abs((processed.outputs[0].durationSeconds ?? -1) - 1 / operation.rate) <= 0.0001, 'playback speed export duration');
    }
    const nextHashes = await Promise.all(Object.values(blobs).map(async (blob) => new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())).join(',')));
    report.sourceBytesUnchanged = originalHashes.every((hash, index) => hash === nextHashes[index]);
    requireSmoke(report.sourceBytesUnchanged, 'source immutability');
    const controller = new AbortController(); controller.abort();
    try { await processMediaEdit(sources.video, { kind: 'video.captureFrame', timeSeconds: 0 }, { signal: controller.signal }); }
    catch (error) { report.canceledBeforeWork = error instanceof MediaEditError && error.code === 'aborted'; }
    requireSmoke(report.canceledBeforeWork, 'pre-canceled service');
    return report;
  } finally {
    urls.forEach((url) => URL.revokeObjectURL(url));
    await context.close();
  }
}
