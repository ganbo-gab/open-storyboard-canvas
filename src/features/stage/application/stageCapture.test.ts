import { describe, expect, it, vi } from 'vitest';
import { assertStageCaptureDataCurrent, createStageCaptureBridge, STAGE_FOUR_VIEWS, type StageCaptureAdapter, type StageCaptureRequest } from './stageCapture';
import type { BlueprintNodeData } from '@/features/canvas/domain/canvasNodes';
import { createEmptyDirectorMotionProject } from '@/features/canvas/application/directorMotion';

interface FixtureScene { time: number; playing: boolean; camera: string; preview: string; export: boolean; pose: number }
const initial: FixtureScene = { time: 2.5, playing: true, camera: 'user-orbit-roll', preview: 'route', export: false, pose: 0.3 };

/** Fixture renderer only: lifecycle evidence, not real Three.js/visual capture evidence. */
function fixture() {
  const state = structuredClone(initial);
  const persisted = new Map<string, Blob>();
  const rendered: StageCaptureRequest[] = [];
  const adapter: StageCaptureAdapter<FixtureScene> = {
    snapshot: () => structuredClone(state),
    suspend: () => { state.playing = false; },
    render: async (request) => {
      state.time = request.timeSeconds ?? state.time;
      state.camera = request.view;
      state.preview = 'shot';
      state.export = true;
      state.pose = 1;
      rendered.push(request);
      return new Blob([`fixture-render:${request.view}:${state.time}`], { type: 'image/png' });
    },
    restore: (snapshot) => { Object.assign(state, snapshot); },
    persistImage: async (image) => {
      expect(state).toEqual(initial);
      const assetId = `fixture-asset-${persisted.size}`;
      persisted.set(assetId, image);
      return { assetId };
    },
    discardImage: async (id) => { persisted.delete(id); },
  };
  return { state, persisted, rendered, adapter };
}

describe('stage capture lifecycle with explicitly fixture renderer', () => {
  it('captures four views at one time and restores full scene/playback before persistence', async () => {
    const f = fixture();
    const bridge = createStageCaptureBridge(f.adapter);
    const images = await bridge.captureFourViews!(5);
    expect(images.map((image) => image.view)).toEqual(STAGE_FOUR_VIEWS);
    expect(f.rendered).toEqual(STAGE_FOUR_VIEWS.map((view) => ({ view, timeSeconds: 5 })));
    expect(f.state).toEqual(initial);
    expect(f.persisted.size).toBe(4);
  });
  it('restores prior state on renderer failure and releases capture ownership', async () => {
    const f = fixture();
    const render = f.adapter.render;
    f.adapter.render = vi.fn(async (request, state, signal) => {
      await render(request, state, signal);
      throw new Error('fixture GPU readback failed');
    });
    const bridge = createStageCaptureBridge(f.adapter);
    await expect(bridge.captureAt!(5)).rejects.toThrow(/GPU/);
    expect(f.state).toEqual(initial);
    expect(f.persisted.size).toBe(0);
    f.adapter.render = render;
    await expect(bridge.captureAt!(3)).resolves.toEqual({ assetId: 'fixture-asset-0' });
  });
  it('waits for in-flight render before restoring cancellation, rejects overlaps and does not publish late pixels', async () => {
    const f = fixture();
    const render = f.adapter.render;
    const gate = Promise.withResolvers<void>();
    f.adapter.render = async (request, state, signal) => {
      const image = await render(request, state, signal);
      await gate.promise;
      f.state.camera = 'late-render-write';
      return image;
    };
    const bridge = createStageCaptureBridge(f.adapter);
    const controller = new AbortController();
    const capture = bridge.captureAt!(5, controller.signal);
    const rejected = expect(capture).rejects.toMatchObject({ name: 'AbortError' });
    await expect(bridge.capture()).rejects.toThrow(/in progress/);
    controller.abort();
    gate.resolve();
    await rejected;
    expect(f.state).toEqual(initial);
    expect(f.persisted.size).toBe(0);
    f.adapter.render = render;
    await bridge.capture();
    expect(f.state).toEqual(initial);
  });
  it('does not touch a pre-cancelled scene and cleans partial four-view assets when persistence fails', async () => {
    const f = fixture();
    const snapshot = vi.spyOn(f.adapter, 'snapshot');
    const controller = new AbortController(); controller.abort();
    const bridge = createStageCaptureBridge(f.adapter);
    await expect(bridge.capture(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(snapshot).not.toHaveBeenCalled();
    const persist = f.adapter.persistImage;
    f.adapter.persistImage = async (image, request, signal) => {
      if (request.view === 'back') throw new Error('fixture disk full');
      return persist(image, request, signal);
    };
    await expect(bridge.captureFourViews!(4)).rejects.toThrow(/disk full/);
    expect(f.state).toEqual(initial);
    expect(f.persisted.size).toBe(0);
  });
  it('removes an asset whose persistence completed after cancellation without changing prior scene state', async () => {
    const f = fixture();
    const controller = new AbortController();
    const persist = f.adapter.persistImage;
    f.adapter.persistImage = async (image, request, signal) => {
      const result = await persist(image, request, signal);
      controller.abort();
      return result;
    };
    const bridge = createStageCaptureBridge(f.adapter);
    await expect(bridge.captureAt!(4, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.persisted.size).toBe(0);
    expect(f.state).toEqual(initial);
  });
});

describe('stage capture committed document inputs', () => {
  const data: BlueprintNodeData = { mode: 'flat', aspectRatio: '16:9', items: [], referenceImages: [] };


  it('rejects stale items, camera tracks, camera settings and output dimensions independently', () => {
    for (const current of [
      { ...data, items: [...data.items] },
      { ...data, motionProject: createEmptyDirectorMotionProject() },
      { ...data, camera: { fov: 70, lensDistance: 8, activePreset: 'custom' } },
      { ...data, aspectRatio: '1:1' },
    ]) {
      expect(() => assertStageCaptureDataCurrent(data, current)).toThrow();
    }
  });
});
