// @vitest-environment jsdom
import { act, createElement, createRef, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { BlueprintItem } from '@/features/canvas/domain/canvasNodes';
import { BlueprintScene, type BlueprintSceneHandle } from './BlueprintScene';

const fixture = vi.hoisted(() => ({
  translate: (key: string) => key,
  frames: [] as Array<{ x: number[]; fov: number }>,
  encoding: null as Promise<void> | null,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: fixture.translate }) }));
vi.mock('three', async (importOriginal) => ({
  ...await importOriginal<typeof THREE>(),
  // Only the GPU/PNG boundary is a fixture; real scene effects, meshes and camera run.
  WebGLRenderer: class {
    domElement = document.createElement('canvas');
    shadowMap = { enabled: false, type: 0 };
    setClearColor() {} setPixelRatio() {} render() {} dispose() {}
    setSize(width: number, height: number) { this.domElement.width = width; this.domElement.height = height; }
  },
}));
vi.mock('@/features/stage/application/stageOffscreenCapture', () => ({
  renderStageOffscreenImage: async (_renderer: unknown, scene: InstanceType<typeof THREE.Scene>, camera: InstanceType<typeof THREE.PerspectiveCamera>) => {
    const groups: InstanceType<typeof THREE.Group>[] = scene.children.filter((child: InstanceType<typeof THREE.Object3D>) => child.isGroup);
    fixture.frames.push({ x: groups.flatMap((group) => group.children.map((child: InstanceType<typeof THREE.Object3D>) => child.position.x)), fov: camera.fov });
    await fixture.encoding;
    return new Blob(['fixture-offscreen-pixels'], { type: 'image/png' });
  },
}));

const ref = createRef<BlueprintSceneHandle>();
let root: Root | undefined;
let host: HTMLDivElement;
let pending: Promise<'published' | 'rejected'> | undefined;
const item: BlueprintItem = { id: 'box', category: 'object', label: 'Box', color: '#fff', x: 0, y: 0, pos3d: { x: 0, y: 0, z: 0 } };
function Harness({ items, fov, captureOnCommit = false }: { items: BlueprintItem[]; fov: number; captureOnCommit?: boolean }) {
  useLayoutEffect(() => {
    if (captureOnCommit && ref.current) pending = ref.current.captureFrame({ view: 'current' }).then(() => 'published', () => 'rejected');
  }, [items, fov, captureOnCommit]);
  return createElement(BlueprintScene, { ref, items, cameraFov: fov, selectedItemId: null, onItemsChange: () => {}, onSelectedItemChange: () => {} });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  fixture.frames.length = 0; fixture.encoding = null; pending = undefined;
});
afterEach(async () => {
  await act(async () => { root?.unmount(); root = undefined; });
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('BlueprintScene acknowledged renderer inputs', () => {
  it('orbits with left drag over an object without selecting or moving it when navigation is active', async () => {
    const onItemsChange = vi.fn(), onSelectionChange = vi.fn(), onSelectedItemChange = vi.fn();
    await act(async () => { root?.render(createElement(BlueprintScene, { ref, items: [item], orbitNavigation: true,
      width: 800, height: 600, selectedItemId: 'box', selectedItemIds: ['box'], onItemsChange, onSelectionChange, onSelectedItemChange })); });
    if (!ref.current) throw new Error('Scene not mounted');
    const before = ref.current.getCameraSnapshot();
    const viewport = host.querySelector('.nodrag');
    if (!viewport) throw new Error('Viewport missing');
    await act(async () => {
      fireEvent(viewport, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 400, clientY: 300 }));
      fireEvent(viewport, new MouseEvent('pointermove', { bubbles: true, button: 0, buttons: 1, clientX: 460, clientY: 330 }));
      fireEvent(viewport, new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 460, clientY: 330 }));
    });
    expect(ref.current.getCameraSnapshot()?.position).not.toEqual(before?.position);
    expect(ref.current.getCameraSnapshot()?.target).toEqual(before?.target);
    expect(onItemsChange).not.toHaveBeenCalled(); expect(onSelectionChange).not.toHaveBeenCalled(); expect(onSelectedItemChange).not.toHaveBeenCalled();
  });

  it('rejects capture between a React commit and mesh/camera effects, then captures acknowledged transforms', async () => {
    const items = [item];
    await act(async () => { root?.render(createElement(Harness, { items, fov: 45 })); });
    await act(async () => {
      root?.render(createElement(Harness, { items: [{ ...item, pos3d: { x: 7, y: 0, z: 0 } }], fov: 70, captureOnCommit: true }));
    });
    expect({ result: await pending, frames: fixture.frames }).toEqual({ result: 'rejected', frames: [] });
    if (!ref.current) throw new Error('Scene not mounted');
    await ref.current.captureFrame({ view: 'current' });
    expect(fixture.frames).toEqual([{ x: [7], fov: 70 }]);
  });
  it('requires a camera acknowledgment even when mesh inputs have not changed', async () => {
    const items = [item];
    await act(async () => { root?.render(createElement(Harness, { items, fov: 45 })); });
    await act(async () => { root?.render(createElement(Harness, { items, fov: 80, captureOnCommit: true })); });
    expect({ result: await pending, frames: fixture.frames }).toEqual({ result: 'rejected', frames: [] });
    if (!ref.current) throw new Error('Scene not mounted');
    await ref.current.captureFrame({ view: 'current' });
    expect(fixture.frames).toEqual([{ x: [0], fov: 80 }]);
  });

  it('revokes old viewport-generation tokens even when replacement inputs are identical', async () => {
    const items = [item];
    await act(async () => { root?.render(createElement(Harness, { items, fov: 45 })); });
    const previous = ref.current;
    const revision = previous?.getCaptureRevision();
    if (!previous || !revision) throw new Error('Scene did not acknowledge its inputs');
    await act(async () => { root?.unmount(); });
    expect(previous.getCaptureRevision()).toBeNull();
    root = createRoot(host);
    await act(async () => { root?.render(createElement(Harness, { items, fov: 45 })); });
    const replacement = ref.current;
    if (!replacement) throw new Error('Replacement scene not mounted');
    expect(replacement.getCaptureRevision()).not.toBe(revision);
    await expect(replacement.captureFrame({ view: 'current', revision })).rejects.toThrow();
    expect(fixture.frames).toEqual([]);
    await replacement.captureFrame({ view: 'current' });
    expect(fixture.frames).toEqual([{ x: [0], fov: 45 }]);
  });

  it('does not return an image encoded after its rendered revision was superseded', async () => {
    const items = [item];
    await act(async () => { root?.render(createElement(Harness, { items, fov: 45 })); });
    if (!ref.current) throw new Error('Scene not mounted');
    const gate = Promise.withResolvers<void>();
    fixture.encoding = gate.promise;
    const result = ref.current.captureFrame({ view: 'current' }).then(() => 'published', () => 'rejected');
    await act(async () => { root?.render(createElement(Harness, { items, fov: 75 })); });
    gate.resolve();
    expect(await result).toBe('rejected');
    fixture.encoding = null;
    if (!ref.current) throw new Error('Scene not mounted');
    await ref.current.captureFrame({ view: 'current' });
    expect(fixture.frames.at(-1)).toEqual({ x: [0], fov: 75 });
  });
});
