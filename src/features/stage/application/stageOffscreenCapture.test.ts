import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { renderStageOffscreenImage } from './stageOffscreenCapture';

/** Fixture GPU API only; actual image decoding/rendering is a mounted-browser smoke. */
function rendererFixture(failAt: 'render' | 'readback' | 'cancel', controller: AbortController) {
  const previousTarget = new THREE.WebGLRenderTarget(4, 4);
  const state = { target: previousTarget, cubeFace: 2, mipmap: 1, viewport: new THREE.Vector4(1, 2, 3, 4), scissor: new THREE.Vector4(5, 6, 7, 8), scissorTest: true };
  const renderer = {
    domElement: { width: 16, height: 9 },
    capabilities: { maxTextureSize: 4096, maxSamples: 4 },
    outputColorSpace: THREE.SRGBColorSpace,
    autoClear: false,
    getContext: () => ({ isContextLost: () => false }),
    getRenderTarget: () => state.target,
    getActiveCubeFace: () => state.cubeFace,
    getActiveMipmapLevel: () => state.mipmap,
    getViewport: (value: InstanceType<typeof THREE.Vector4>) => value.copy(state.viewport),
    getScissor: (value: InstanceType<typeof THREE.Vector4>) => value.copy(state.scissor),
    getScissorTest: () => state.scissorTest,
    setRenderTarget: (target: InstanceType<typeof THREE.WebGLRenderTarget>, cubeFace = 0, mipmap = 0) => { state.target = target; state.cubeFace = cubeFace; state.mipmap = mipmap; },
    setViewport: (value: number | InstanceType<typeof THREE.Vector4>, y?: number, width?: number, height?: number) => {
      if (typeof value === 'number') state.viewport.set(value, y, width, height);
      else state.viewport.copy(value);
    },
    setScissor: (value: InstanceType<typeof THREE.Vector4>) => { state.scissor.copy(value); },
    setScissorTest: (value: boolean) => { state.scissorTest = value; },
    render: () => { if (failAt === 'render') throw new Error('fixture render error'); },
    readRenderTargetPixels: () => {
      if (failAt === 'readback') throw new Error('fixture readback error');
      controller.abort();
    },
  };
  return { renderer, state, previousTarget };
}

describe('offscreen renderer ownership restoration', () => {
  it.each(['render', 'readback', 'cancel'] as const)('restores target/viewport/scissor/autoclear and leaves live camera unchanged after %s', async (failure) => {
    const controller = new AbortController();
    const { renderer, state, previousTarget } = rendererFixture(failure, controller);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 500);
    camera.position.set(2, 3, 4); camera.rotation.set(0.1, 0.2, 0.3);
    const previousCamera = camera.clone();
    const dispose = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose');
    try {
      await expect(renderStageOffscreenImage(renderer, scene, camera, { targetWidth: 16, targetHeight: 9 }, controller.signal)).rejects.toThrow(failure === 'cancel' ? /cancelled/ : /fixture/);
      expect(state.target).toBe(previousTarget);
      expect(state.cubeFace).toBe(2); expect(state.mipmap).toBe(1);
      expect(state.viewport.toArray()).toEqual([1, 2, 3, 4]);
      expect(state.scissor.toArray()).toEqual([5, 6, 7, 8]);
      expect(state.scissorTest).toBe(true); expect(renderer.autoClear).toBe(false);
      expect(camera.position.toArray()).toEqual(previousCamera.position.toArray());
      expect(camera.quaternion.toArray()).toEqual(previousCamera.quaternion.toArray());
      expect(camera.projectionMatrix.toArray()).toEqual(previousCamera.projectionMatrix.toArray());
      expect(dispose).toHaveBeenCalledTimes(2);
    } finally { dispose.mockRestore(); previousTarget.dispose(); }
  });
});
