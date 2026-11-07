import { readMediaBlob, waitForMediaTask } from './resources';
import { checkMediaEditAbort, MediaEditError, validateMediaTimeRange, type MediaEditOperation, type MediaEditOptions, type ProcessedMedia } from './types';

export interface PcmAudio {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

/** PCM16 RIFF/WAVE. Frame bounds are half-open, shared split boundaries never overlap. */
export function audioBufferToWav(buffer: PcmAudio, startFrame = 0, endFrame = buffer.length): Blob {
  const { sampleRate, numberOfChannels: channels } = buffer;
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame <= startFrame || endFrame > buffer.length
    || !Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(channels) || channels < 1 || channels > 65535) throw new MediaEditError('invalid-range');
  const blockAlign = channels * 2;
  const size = (endFrame - startFrame) * blockAlign;
  if (size > 0xffffffff - 36) throw new MediaEditError('invalid-range');
  const bytes = new ArrayBuffer(44 + size);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, 'RIFF'); view.setUint32(4, 36 + size, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, size, true);
  const channelData = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  let offset = 44;
  for (let frame = startFrame; frame < endFrame; frame++) {
    for (const data of channelData) {
      const value = data[frame];
      const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export interface AudioSegment { startFrame: number; endFrame: number }
export function getAudioSplitSegments(buffer: Pick<PcmAudio, 'length' | 'sampleRate'>, atSeconds: number[]): AudioSegment[] {
  const duration = buffer.length / buffer.sampleRate;
  const frames = [0];
  for (const time of atSeconds) {
    const frame = Math.round(time * buffer.sampleRate);
    if (!Number.isFinite(time) || time <= 0 || time >= duration || frame <= frames[frames.length - 1] || frame >= buffer.length) throw new MediaEditError('invalid-range');
    frames.push(frame);
  }
  frames.push(buffer.length);
  return frames.slice(1).map((endFrame, index) => ({ startFrame: frames[index], endFrame }));
}

export async function processAudioEdit(source: string, operation: Extract<MediaEditOperation, { kind: `audio.${string}` }>, options: MediaEditOptions): Promise<ProcessedMedia> {
  if (typeof AudioContext === 'undefined') throw new MediaEditError('no-audio-decoder');
  checkMediaEditAbort(options.signal);
  let context: AudioContext;
  try { context = new AudioContext(); }
  catch (cause) { throw new MediaEditError('no-audio-decoder', { cause }); }
  let offline: OfflineAudioContext | undefined;
  let playback: AudioBufferSourceNode | undefined;
  const abort = () => {
    try { playback?.stop(); }
    catch { /* A source that has already stopped has no remaining playback to cancel. */ }
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const blob = await readMediaBlob(source, options.signal, true);
    let buffer: AudioBuffer;
    try { buffer = await waitForMediaTask(context.decodeAudioData(await waitForMediaTask(blob.arrayBuffer(), options.signal)), options.signal); }
    catch (cause) { checkMediaEditAbort(options.signal); throw new MediaEditError('no-audio-decoder', { cause }); }
    checkMediaEditAbort(options.signal);
    options.onProgress?.(0.25);
    if (operation.kind === 'audio.rate') {
      if (typeof OfflineAudioContext === 'undefined') throw new MediaEditError('no-audio-decoder');
      offline = new OfflineAudioContext(buffer.numberOfChannels, Math.max(1, Math.round(buffer.length / operation.rate)), buffer.sampleRate);
      playback = offline.createBufferSource();
      playback.buffer = buffer;
      playback.playbackRate.value = operation.rate;
      playback.connect(offline.destination);
      playback.start();
      buffer = await waitForMediaTask(offline.startRendering(), options.signal);
      checkMediaEditAbort(options.signal);
      return { processing: 'decoded-pcm', outputs: [{ kind: 'audio', blob: audioBufferToWav(buffer), durationSeconds: buffer.length / buffer.sampleRate }] };
    }
    let segments: AudioSegment[];
    if (operation.kind === 'audio.slice') {
      validateMediaTimeRange(operation.startSeconds, operation.endSeconds, buffer.duration);
      const startFrame = Math.round(operation.startSeconds * buffer.sampleRate);
      const endFrame = Math.round(operation.endSeconds * buffer.sampleRate);
      if (startFrame >= endFrame) throw new MediaEditError('invalid-range');
      segments = [{ startFrame, endFrame }];
    } else segments = getAudioSplitSegments(buffer, operation.atSeconds);
    return { processing: 'decoded-pcm', outputs: segments.map(({ startFrame, endFrame }, index) => {
      checkMediaEditAbort(options.signal);
      const blob = audioBufferToWav(buffer, startFrame, endFrame);
      options.onProgress?.(0.25 + 0.7 * (index + 1) / segments.length);
      return { kind: 'audio', blob, durationSeconds: (endFrame - startFrame) / buffer.sampleRate,
        sourceRange: { startSeconds: startFrame / buffer.sampleRate, endSeconds: endFrame / buffer.sampleRate } };
    }) };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    playback?.disconnect();
    await context.close().catch(() => undefined);
  }
}
