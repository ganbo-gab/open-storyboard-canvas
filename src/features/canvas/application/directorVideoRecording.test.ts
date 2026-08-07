import { describe, expect, it, vi } from 'vitest';

import {
  DirectorRecordingCancelledError,
  recordDirectorVideo,
  resolveDirectorVideoFormat,
  selectDirectorVideoFormat,
  type DirectorRecordingPlatform,
} from './directorVideoRecording';

describe('Director Studio recording capability', () => {
  it('prefers real MP4 support and falls back to WebM with an honest extension', () => {
    expect(selectDirectorVideoFormat((mime) => mime === 'video/mp4')).toEqual({
      mimeType: 'video/mp4',
      extension: 'mp4',
    });
    expect(selectDirectorVideoFormat((mime) => mime.includes('vp8'))).toEqual({
      mimeType: 'video/webm;codecs=vp8',
      extension: 'webm',
    });
    expect(selectDirectorVideoFormat(() => false)).toBeNull();
    expect(resolveDirectorVideoFormat('video/webm;codecs=vp9').extension).toBe('webm');
  });

  it('records deterministic timeline frames and reports the recorder MIME', async () => {
    let now = 0;
    const stopTrack = vi.fn();
    const platform: DirectorRecordingPlatform = {
      now: () => now,
      scheduleFrame: (callback) => {
        const handle = setTimeout(() => {
          now += 60;
          callback(now);
        }, 0) as unknown as number;
        return handle;
      },
      cancelFrame: (handle) => clearTimeout(handle),
      captureStream: () => ({ getTracks: () => [{ stop: stopTrack }] }),
      createRecorder: () => {
        const recorder = {
          mimeType: 'video/webm;codecs=vp9',
          state: 'inactive',
          ondataavailable: null as ((event: { data: Blob }) => void) | null,
          onstop: null as (() => void) | null,
          onerror: null as ((event: { error?: Error }) => void) | null,
          start() { recorder.state = 'recording'; },
          stop() {
            recorder.state = 'inactive';
            recorder.ondataavailable?.({ data: new Blob(['video'], { type: recorder.mimeType }) });
            recorder.onstop?.();
          },
        };
        return recorder;
      },
    };
    const cleanModes: boolean[] = [];
    const renderedTimes: number[] = [];

    const result = await recordDirectorVideo({
      canvas: {} as HTMLCanvasElement,
      durationSeconds: 0.1,
      resolution: '720p',
      fps: 24,
      format: { mimeType: 'video/webm;codecs=vp9', extension: 'webm' },
      platform,
      renderAtTime: (time) => { renderedTimes.push(time); },
      setCleanExportMode: (enabled) => { cleanModes.push(enabled); },
    });

    expect(result.extension).toBe('webm');
    expect(result.mimeType).toContain('webm');
    expect(result.blob.size).toBeGreaterThan(0);
    expect(renderedTimes[0]).toBe(0);
    expect(renderedTimes[renderedTimes.length - 1]).toBe(0.1);
    expect(cleanModes).toEqual([true, false]);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('restores clean export state when cancelled before capture starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const cleanModes: boolean[] = [];

    await expect(recordDirectorVideo({
      canvas: {} as HTMLCanvasElement,
      durationSeconds: 1,
      resolution: '1080p',
      fps: 30,
      format: { mimeType: 'video/webm', extension: 'webm' },
      signal: controller.signal,
      platform: {} as DirectorRecordingPlatform,
      renderAtTime: () => undefined,
      setCleanExportMode: (enabled) => { cleanModes.push(enabled); },
    })).rejects.toBeInstanceOf(DirectorRecordingCancelledError);

    expect(cleanModes).toEqual([true, false]);
  });

  it('stops the recorder and stream when an in-flight recording is cancelled', async () => {
    const controller = new AbortController();
    const stopTrack = vi.fn();
    const stopRecorder = vi.fn();
    const cleanModes: boolean[] = [];
    const recorder = {
      mimeType: 'video/webm',
      state: 'inactive',
      ondataavailable: null as ((event: { data: Blob }) => void) | null,
      onstop: null as (() => void) | null,
      onerror: null as ((event: { error?: Error }) => void) | null,
      start() { recorder.state = 'recording'; },
      stop() {
        stopRecorder();
        recorder.state = 'inactive';
        recorder.onstop?.();
      },
    };
    const recording = recordDirectorVideo({
      canvas: {} as HTMLCanvasElement,
      durationSeconds: 1,
      resolution: '720p',
      fps: 24,
      format: { mimeType: 'video/webm', extension: 'webm' },
      signal: controller.signal,
      platform: {
        now: () => 0,
        scheduleFrame: () => 1,
        cancelFrame: vi.fn(),
        captureStream: () => ({ getTracks: () => [{ stop: stopTrack }] }),
        createRecorder: () => recorder,
      },
      renderAtTime: () => undefined,
      setCleanExportMode: (enabled) => { cleanModes.push(enabled); },
    });
    const rejection = expect(recording).rejects.toBeInstanceOf(DirectorRecordingCancelledError);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    controller.abort();

    await rejection;
    expect(stopRecorder).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(cleanModes).toEqual([true, false]);
  });

  it('stops all capture resources when rendering a frame fails', async () => {
    let now = 0;
    const stopTrack = vi.fn();
    const stopRecorder = vi.fn();
    const cleanModes: boolean[] = [];
    const recorder = {
      mimeType: 'video/webm',
      state: 'inactive',
      ondataavailable: null as ((event: { data: Blob }) => void) | null,
      onstop: null as (() => void) | null,
      onerror: null as ((event: { error?: Error }) => void) | null,
      start() { recorder.state = 'recording'; },
      stop() {
        stopRecorder();
        recorder.state = 'inactive';
        recorder.onstop?.();
      },
    };

    await expect(recordDirectorVideo({
      canvas: {} as HTMLCanvasElement,
      durationSeconds: 1,
      resolution: '720p',
      fps: 24,
      format: { mimeType: 'video/webm', extension: 'webm' },
      platform: {
        now: () => now,
        scheduleFrame: (callback) => {
          now = 100;
          queueMicrotask(() => callback(now));
          return 1;
        },
        cancelFrame: vi.fn(),
        captureStream: () => ({ getTracks: () => [{ stop: stopTrack }] }),
        createRecorder: () => recorder,
      },
      renderAtTime: (time) => {
        if (time > 0) throw new Error('render failed');
      },
      setCleanExportMode: (enabled) => { cleanModes.push(enabled); },
    })).rejects.toThrow('render failed');

    expect(stopRecorder).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(cleanModes).toEqual([true, false]);
  });

  it('removes abort wiring and stops capture when recorder start throws', async () => {
    const controller = new AbortController();
    const stopTrack = vi.fn();
    const stopRecorder = vi.fn();
    const cleanModes: boolean[] = [];
    const recorder = {
      mimeType: 'video/webm',
      state: 'inactive',
      ondataavailable: null as ((event: { data: Blob }) => void) | null,
      onstop: null as (() => void) | null,
      onerror: null as ((event: { error?: Error }) => void) | null,
      start() {
        recorder.state = 'recording';
        throw new Error('start failed');
      },
      stop() {
        stopRecorder();
        recorder.state = 'inactive';
        recorder.onstop?.();
      },
    };

    await expect(recordDirectorVideo({
      canvas: {} as HTMLCanvasElement,
      durationSeconds: 1,
      resolution: '720p',
      fps: 24,
      format: { mimeType: 'video/webm', extension: 'webm' },
      signal: controller.signal,
      platform: {
        now: () => 0,
        scheduleFrame: () => 1,
        cancelFrame: vi.fn(),
        captureStream: () => ({ getTracks: () => [{ stop: stopTrack }] }),
        createRecorder: () => recorder,
      },
      renderAtTime: () => undefined,
      setCleanExportMode: (enabled) => { cleanModes.push(enabled); },
    })).rejects.toThrow('start failed');

    controller.abort();
    expect(stopRecorder).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(cleanModes).toEqual([true, false]);
  });
});
