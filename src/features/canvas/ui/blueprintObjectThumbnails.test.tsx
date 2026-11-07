// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThreeModule from 'three';

import { DIRECTOR_STUDIO_MODEL_CATALOG } from '@/features/canvas/domain/directorStudioModelCatalog';

const rendererCalls = vi.hoisted(() => ({ created: 0, render: vi.fn(), dataUrl: vi.fn(() => 'data:image/png;base64,mesh-preview') }));
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof ThreeModule>();
  class ThumbnailRenderer {
    domElement = Object.assign(document.createElement('canvas'), { toDataURL: rendererCalls.dataUrl });
    renderLists = { dispose: vi.fn() };
    outputColorSpace: unknown;
    constructor() { rendererCalls.created += 1; }
    setSize = vi.fn();
    setPixelRatio = vi.fn();
    setClearColor = vi.fn();
    render = rendererCalls.render;
    dispose = vi.fn();
  }
  return { ...actual, WebGLRenderer: ThumbnailRenderer };
});

beforeEach(() => {
  vi.resetModules();
  rendererCalls.created = 0;
  rendererCalls.render.mockReset();
  rendererCalls.dataUrl.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Director Studio mesh thumbnails', () => {
  const model = DIRECTOR_STUDIO_MODEL_CATALOG.find((item) => item.presetId === 'wall-window')!;

  it('uses a category icon without creating a WebGL context when unavailable', async () => {
    vi.stubGlobal('WebGL2RenderingContext', undefined);
    // Module reset deliberately tests the renderer's capability boundary.
    const { DirectorStudioModelThumbnail } = await import('./DirectorStudioModelThumbnail');
    const { container } = render(<DirectorStudioModelThumbnail model={model} />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(rendererCalls.created).toBe(0);
  });

  it('renders actual factory meshes with one renderer and caches preset/color combinations', async () => {
    vi.stubGlobal('WebGL2RenderingContext', class {});
    // Static import cannot reset the renderer/cache between capability cases.
    const { DirectorStudioModelThumbnail } = await import('./DirectorStudioModelThumbnail');
    rendererCalls.render.mockImplementation((scene, camera) => {
      const rendered = scene.children.find((child: { name: string }) => child.name === model.presetId);
      expect(rendered?.userData.blueprintPresetId).toBe(model.presetId);
      expect(rendered?.userData.blueprintGenericFallback).toBe(false);
      expect(rendered.children.length).toBeGreaterThan(1);
      expect(camera.isOrthographicCamera).toBe(true);
    });
    const first = render(<DirectorStudioModelThumbnail model={model} />);
    await waitFor(() => expect(first.container.querySelector('img')).not.toBeNull());
    expect(rendererCalls.created).toBe(1);
    expect(rendererCalls.render).toHaveBeenCalledTimes(1);
    expect(rendererCalls.dataUrl).toHaveBeenCalledTimes(1);
    expect(first.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,mesh-preview');
    render(<DirectorStudioModelThumbnail model={model} />);
    expect(rendererCalls.render).toHaveBeenCalledTimes(1);
    render(<DirectorStudioModelThumbnail model={{ ...model, color: '#f97316' }} />);
    expect(rendererCalls.created).toBe(1);
    expect(rendererCalls.render).toHaveBeenCalledTimes(2);
  });
});
