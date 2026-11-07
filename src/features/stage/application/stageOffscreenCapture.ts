import * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { assertStageCaptureActive } from './stageCapture';
import { canvasToPng } from '@/features/canvas/application/media/resources';

export interface StageCaptureImageOptions { frameAspect?: number | null; targetWidth?: number; targetHeight?: number }

/** Offscreen readback never changes the live camera, canvas size or playback loop. */
export async function renderStageOffscreenImage(
  renderer: InstanceType<typeof THREE.WebGLRenderer>,
  scene: InstanceType<typeof THREE.Scene>,
  camera: InstanceType<typeof THREE.PerspectiveCamera>,
  options: StageCaptureImageOptions = {},
  signal?: AbortSignal,
): Promise<Blob> {
  assertStageCaptureActive(signal);
  if (renderer.getContext().isContextLost()) throw new Error('Stage graphics context is unavailable.');
  const source = renderer.domElement;
  const aspect = options.frameAspect && options.frameAspect > 0 ? options.frameAspect : source.width / Math.max(1, source.height);
  const width = Math.round(options.targetWidth ?? (options.targetHeight ? options.targetHeight * aspect : source.width));
  const height = Math.round(options.targetHeight ?? width / aspect);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > renderer.capabilities.maxTextureSize || height > renderer.capabilities.maxTextureSize) throw new Error('Stage capture dimensions exceed the graphics context limits.');
  const outputCamera = camera.clone();
  // Match a centered aspect crop without moving the actual camera.
  const targetAspect = width / height;
  if (targetAspect > outputCamera.aspect) outputCamera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(outputCamera.fov) / 2) * outputCamera.aspect / targetAspect));
  outputCamera.aspect = targetAspect;
  outputCamera.updateProjectionMatrix();
  // Three deliberately skips display tone mapping for ordinary render targets.
  // Preserve HDR until the supported OutputPass converts to display RGB exactly once.
  const sceneTarget = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: true, samples: Math.min(4, renderer.capabilities.maxSamples) });
  sceneTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
  const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false });
  target.texture.colorSpace = THREE.NoColorSpace;
  const outputPass = new OutputPass();
  const previousTarget = renderer.getRenderTarget();
  const previousCubeFace = renderer.getActiveCubeFace();
  const previousMipmap = renderer.getActiveMipmapLevel();
  const viewport = renderer.getViewport(new THREE.Vector4());
  const scissor = renderer.getScissor(new THREE.Vector4());
  const scissorTest = renderer.getScissorTest();
  const autoClear = renderer.autoClear;
  const pixels = new Uint8Array(width * height * 4);
  try {
    renderer.setRenderTarget(sceneTarget);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissorTest(false);
    renderer.autoClear = true;
    renderer.render(scene, outputCamera);
    outputPass.render(renderer, target, sceneTarget);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  } finally {
    renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmap);
    renderer.setViewport(viewport);
    renderer.setScissor(scissor);
    renderer.setScissorTest(scissorTest);
    renderer.autoClear = autoClear;
    target.dispose();
    sceneTarget.dispose();
    outputPass.dispose();
  }
  assertStageCaptureActive(signal);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Stage image encoding is unavailable.');
  const image = context.createImageData(width, height);
  const stride = width * 4;
  for (let row = 0; row < height; row += 1) image.data.set(pixels.subarray((height - row - 1) * stride, (height - row) * stride), row * stride);
  context.putImageData(image, 0, 0);
  const blob = await canvasToPng(canvas);
  assertStageCaptureActive(signal);
  return blob;
}
