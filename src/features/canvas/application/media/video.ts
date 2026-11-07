import type * as MediaBunny from 'mediabunny';
import type { AudioCodec, Conversion, ConversionOptions, Input, InputAudioTrack, InputTrack, InputVideoTrack, OutputFormat, VideoCodec } from 'mediabunny';
import { canvasToPng, readMediaBlob, waitForMediaTask } from './resources';
import { checkMediaEditAbort, MediaEditError, validateMediaTimeRange, type EditedMedia, type MediaEditCapability, type MediaEditOperation, type MediaEditOptions, type ProcessedMedia } from './types';

type Bunny = typeof MediaBunny;
type VideoOperation = Extract<MediaEditOperation, { kind: `video.${string}` }>;
interface VideoInput { bunny: Bunny; input: Input; video: InputVideoTrack; audio: InputAudioTrack | null; duration: number; width: number; height: number }

async function openVideo(source: string, signal?: AbortSignal): Promise<VideoInput> {
  // Codec processing is optional and heavy: keep Mediabunny out of the initial application bundle.
  checkMediaEditAbort(signal);
  const bunny = await waitForMediaTask(import('mediabunny'), signal);
  const blob = await readMediaBlob(source, signal);
  const input = new bunny.Input({ source: new bunny.BlobSource(blob), formats: bunny.ALL_FORMATS });
  const abort = () => input.dispose();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    checkMediaEditAbort(signal);
    if (!await waitForMediaTask(input.canRead(), signal)) throw new MediaEditError('unsupported-container');
    const video = await waitForMediaTask(input.getPrimaryVideoTrack(), signal);
    if (!video) throw new MediaEditError('no-video-track');
    const audio = await waitForMediaTask(input.getPrimaryAudioTrack(), signal);
    const [duration, width, height] = await waitForMediaTask(Promise.all([input.computeDuration(), video.getDisplayWidth(), video.getDisplayHeight()]), signal);
    checkMediaEditAbort(signal);
    return { bunny, input, video, audio, duration, width, height };
  } catch (cause) {
    input.dispose();
    checkMediaEditAbort(signal);
    if (cause instanceof MediaEditError) throw cause;
    throw new MediaEditError('unsupported-container', { cause });
  } finally { signal?.removeEventListener('abort', abort); }
}

function selectFormat(bunny: Bunny, video: VideoCodec | null, audio: AudioCodec | null): OutputFormat {
  // WebM retains VP8/VP9/Opus; MP4 covers AVC/HEVC/AAC. Never silently drop an unsupported track.
  const formats = [new bunny.WebMOutputFormat(), new bunny.Mp4OutputFormat()];
  const format = formats.find((candidate) => (!video || candidate.getSupportedVideoCodecs().includes(video)) && (!audio || candidate.getSupportedAudioCodecs().includes(audio)));
  if (!format) throw new MediaEditError('unsupported-container');
  return format;
}

function requireConversionTracks(conversion: Conversion): void {
  const unexpected = conversion.discardedTracks.find((track) => track.reason !== 'discarded_by_user');
  if (!conversion.isValid || unexpected) {
    const reason = unexpected?.reason;
    if (unexpected?.reason === 'undecodable_source_codec') throw new MediaEditError(unexpected.track.isVideoTrack() ? 'no-video-decoder' : 'no-audio-decoder');
    if (reason === 'no_encodable_target_codec') throw new MediaEditError(unexpected?.track.isAudioTrack() ? 'no-audio-encoder' : 'no-video-encoder');
    throw new MediaEditError('unsupported-container');
  }
}

async function pickVideoEncoder(opened: VideoInput, width: number, height: number): Promise<VideoCodec> {
  if (typeof VideoEncoder === 'undefined') throw new MediaEditError('no-webcodecs');
  if (!await opened.video.canDecode()) throw new MediaEditError('no-video-decoder');
  const sourceCodec = await opened.video.getCodec();
  const audioCodec = await opened.audio?.getCodec() ?? null;
  const candidates: VideoCodec[] = sourceCodec ? [sourceCodec, 'avc', 'vp9', 'vp8'] : ['avc', 'vp9', 'vp8'];
  for (const codec of candidates) {
    try {
      selectFormat(opened.bunny, codec, audioCodec);
      if (await opened.bunny.canEncodeVideo(codec, { width, height })) return codec;
    } catch (error) { if (!(error instanceof MediaEditError)) throw error; }
  }
  throw new MediaEditError('no-video-encoder');
}

async function trimEndNeedsTranscode(opened: VideoInput, track: InputTrack, end: number): Promise<boolean> {
  // Mediabunny's copy boundaryTolerance guards the start, but expand-mode copying
  // can still retain the entire final packet. Never expose content past the request.
  const packet = await new opened.bunny.EncodedPacketSink(track).getPacket(end, { metadataOnly: true });
  return !!packet && packet.timestamp < end - 1e-9 && packet.timestamp + packet.duration > end + 1e-9;
}

async function convert(opened: VideoInput, format: OutputFormat, config: Omit<ConversionOptions, 'input' | 'output'>, options: MediaEditOptions, allowTranscode: boolean): Promise<{ blob: Blob; copied: boolean }> {
  const { bunny, input } = opened;
  let conversion: Conversion | undefined;
  let copied = !allowTranscode;
  const abort = () => { void conversion?.cancel().catch(() => undefined); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const create = async (copy: ConversionOptions['copy']) => {
      checkMediaEditAbort(options.signal);
      const target = new bunny.BufferTarget();
      const output = new bunny.Output({ format, target });
      const cancelOutput = () => { void output.cancel().catch(() => undefined); };
      options.signal?.addEventListener('abort', cancelOutput, { once: true });
      try {
        const initialized = await waitForMediaTask(bunny.Conversion.init({ input, output, tracks: 'primary', showWarnings: false, ...config, copy }), options.signal, (late) => late.cancel());
        return { initialized, target };
      } catch (cause) {
        await output.cancel().catch(() => undefined);
        throw cause;
      } finally { options.signal?.removeEventListener('abort', cancelOutput); }
    };
    // Untrimmed tracks retain negative codec-priming packets (e.g. Opus); exact trims do not expand.
    const boundaryTolerance = config.trim ? 0 : Infinity;
    let prepared = await create({ mode: 'forced', boundaryTolerance, shiftTolerance: 0 });
    conversion = prepared.initialized;
    if (allowTranscode && (!conversion.isValid || conversion.discardedTracks.some((track) => track.reason !== 'discarded_by_user'))) {
      await conversion.cancel();
      prepared = await create({ mode: 'preferred', boundaryTolerance, shiftTolerance: 0 });
      conversion = prepared.initialized;
      copied = false;
    } else copied = true;
    requireConversionTracks(conversion);
    checkMediaEditAbort(options.signal);
    conversion.onProgress = (fraction) => { options.onProgress?.(fraction); };
    await waitForMediaTask(conversion.execute(), options.signal);
    checkMediaEditAbort(options.signal);
    const bytes = prepared.target.buffer;
    if (!bytes?.byteLength) throw new MediaEditError('processing-failed');
    const mime = config.video && 'discard' in config.video && config.video.discard === true ? format.mimeType.replace(/^video\//, 'audio/') : format.mimeType;
    return { blob: new Blob([bytes], { type: mime }), copied };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (conversion && conversion.state !== 'done' && conversion.state !== 'canceled') await conversion.cancel();
  }
}

async function describeOutput(bunny: Bunny, blob: Blob, kind: 'audio' | 'video', signal?: AbortSignal): Promise<EditedMedia> {
  const input = new bunny.Input({ formats: bunny.ALL_FORMATS, source: new bunny.BlobSource(blob) });
  const abort = () => input.dispose();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    checkMediaEditAbort(signal);
    const video = await waitForMediaTask(input.getPrimaryVideoTrack(), signal);
    const audio = await waitForMediaTask(input.getPrimaryAudioTrack(), signal);
    if (kind === 'video' && !video) throw new MediaEditError('processing-failed');
    if (kind === 'audio' && !audio) throw new MediaEditError('processing-failed');
    return { kind, blob, durationSeconds: await waitForMediaTask(input.computeDuration(), signal), ...(video ? { width: await waitForMediaTask(video.getDisplayWidth(), signal), height: await waitForMediaTask(video.getDisplayHeight(), signal) } : {}) };
  } finally { signal?.removeEventListener('abort', abort); input.dispose(); }
}

export async function processVideoEdit(source: string, operation: VideoOperation, options: MediaEditOptions): Promise<ProcessedMedia> {
  const opened = await openVideo(source, options.signal);
  const abort = () => opened.input.dispose();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    checkMediaEditAbort(options.signal);
    const { bunny, video, audio, duration, width, height } = opened;
    if (operation.kind === 'video.captureFrame') {
      if (operation.timeSeconds >= duration) throw new MediaEditError('invalid-range');
      if (!await waitForMediaTask(video.canDecode(), options.signal)) throw new MediaEditError(typeof VideoDecoder === 'undefined' ? 'no-webcodecs' : 'no-video-decoder');
      const frame = await waitForMediaTask(new bunny.CanvasSink(video, { poolSize: 1 }).getCanvas(operation.timeSeconds), options.signal, (late) => {
        if (late) late.canvas.width = late.canvas.height = 0;
      });
      if (!frame) throw new MediaEditError('invalid-range');
      try {
        const blob = await waitForMediaTask(canvasToPng(frame.canvas), options.signal);
        checkMediaEditAbort(options.signal);
        return { processing: 'image-transform', outputs: [{ kind: 'image', blob, width: frame.canvas.width, height: frame.canvas.height }] };
      } finally { frame.canvas.width = frame.canvas.height = 0; }
    }
    const videoCodec = await video.getCodec();
    const audioCodec = await audio?.getCodec() ?? null;
    if (!videoCodec || (audio && !audioCodec)) throw new MediaEditError('unsupported-container');
    if (operation.kind === 'video.separateAudio') {
      if (!audio) throw new MediaEditError('no-audio-track');
      const videoResult = await convert(opened, selectFormat(bunny, videoCodec, null), { audio: { discard: true } }, { ...options, onProgress: (fraction) => options.onProgress?.(fraction / 2) }, false);
      const audioResult = await convert(opened, selectFormat(bunny, null, audioCodec), { video: { discard: true } }, { ...options, onProgress: (fraction) => options.onProgress?.(0.5 + fraction / 2) }, false);
      return { processing: 'stream-copy', outputs: [await describeOutput(bunny, videoResult.blob, 'video', options.signal), await describeOutput(bunny, audioResult.blob, 'audio', options.signal)] };
    }
    if (operation.kind === 'video.trim') {
      validateMediaTimeRange(operation.startSeconds, operation.endSeconds, duration);
      const [videoEndNeedsTranscode, audioEndNeedsTranscode] = await waitForMediaTask(Promise.all([
        trimEndNeedsTranscode(opened, video, operation.endSeconds),
        audio ? trimEndNeedsTranscode(opened, audio, operation.endSeconds) : false,
      ]), options.signal);
      const result = await convert(opened, selectFormat(bunny, videoCodec, audioCodec), {
        trim: { start: operation.startSeconds, end: operation.endSeconds },
        video: { forceTranscode: videoEndNeedsTranscode },
        audio: { forceTranscode: audioEndNeedsTranscode },
      }, options, true);
      const output = await describeOutput(bunny, result.blob, 'video', options.signal);
      output.sourceRange = { startSeconds: operation.startSeconds, endSeconds: operation.endSeconds };
      return { processing: result.copied ? 'stream-copy' : 're-encode', outputs: [output] };
    }
    const rect = operation.rect;
    const crop = { left: Math.round(rect.x * width), top: Math.round(rect.y * height), width: Math.round(rect.width * width), height: Math.round(rect.height * height) };
    if (crop.width < 1 || crop.height < 1) throw new MediaEditError('invalid-range');
    const codec = await waitForMediaTask(pickVideoEncoder(opened, crop.width, crop.height), options.signal);
    const result = await convert(opened, selectFormat(bunny, codec, audioCodec), { video: { crop, codec, forceTranscode: true } }, options, true);
    return { processing: 're-encode', outputs: [await describeOutput(bunny, result.blob, 'video', options.signal)] };
  } catch (cause) {
    checkMediaEditAbort(options.signal);
    if (cause instanceof MediaEditError) throw cause;
    throw new MediaEditError('processing-failed', { cause });
  } finally { options.signal?.removeEventListener('abort', abort); opened.input.dispose(); }
}

export async function getVideoEditCapability(kind: VideoOperation['kind'], source?: string, options: MediaEditOptions = {}): Promise<MediaEditCapability> {
  if (options.signal?.aborted) return { supported: false, reason: 'aborted' };
  if (!source) {
    if (kind === 'video.separateAudio' || kind === 'video.trim') return { supported: true };
    if (typeof VideoDecoder === 'undefined') return { supported: false, reason: 'no-webcodecs' };
    if (kind === 'video.crop' && typeof VideoEncoder === 'undefined') return { supported: false, reason: 'no-video-encoder' };
    return { supported: true };
  }
  let opened: VideoInput | undefined;
  const abort = () => opened?.input.dispose();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    opened = await openVideo(source, options.signal);
    const { bunny, video, audio } = opened;
    if (kind === 'video.separateAudio' || kind === 'video.trim') {
      const videoCodec = await video.getCodec();
      const audioCodec = await audio?.getCodec() ?? null;
      if (!videoCodec || (audio && !audioCodec)) throw new MediaEditError('unsupported-container');
      if (kind === 'video.separateAudio') {
        if (!audio) throw new MediaEditError('no-audio-track');
        selectFormat(bunny, videoCodec, null); selectFormat(bunny, null, audioCodec);
      } else selectFormat(bunny, videoCodec, audioCodec);
    } else if (kind === 'video.captureFrame') {
      if (!await waitForMediaTask(video.canDecode(), options.signal)) throw new MediaEditError(typeof VideoDecoder === 'undefined' ? 'no-webcodecs' : 'no-video-decoder');
    } else await waitForMediaTask(pickVideoEncoder(opened, opened.width, opened.height), options.signal);
    return { supported: true };
  } catch (error) { return { supported: false, reason: error instanceof MediaEditError ? error.code : 'unsupported-container' }; }
  finally { options.signal?.removeEventListener('abort', abort); opened?.input.dispose(); }
}
