// @vitest-environment jsdom
import { act, createElement, forwardRef, useEffect, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_NODE_TYPES, isBlueprintNode, type BlueprintItem, type BlueprintNodeData } from '@/features/canvas/domain/canvasNodes';
import type { BlueprintSceneCaptureRevision, BlueprintSceneHandle, BlueprintSceneProps } from './BlueprintScene';
import type * as AssetCatalog from '@/features/assets/application/assetCatalog';
import type * as ImageData from '@/features/canvas/application/imageData';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { stageCommands } from '@/features/stage/application/stageCommands';
import { DirectorStudioShell } from './DirectorStudioShell';

const fixture = vi.hoisted(() => ({
  items: [] as BlueprintItem[],
  ready: false,
  revision: null as BlueprintSceneCaptureRevision | null,
  synchronize: true,
  translate: (key: string) => key,
  rendered: vi.fn<(items: BlueprintItem[]) => void>(),
  assets: new Map<string, AssetCatalog.AssetRecord>(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: fixture.translate }) }));
vi.mock('@/commands/image', () => ({ persistImageSource: async (source: string) => source }));
vi.mock('@/features/canvas/application/imageData', async (importOriginal) => ({
  ...await importOriginal<typeof ImageData>(),
  blobToDataUrl: vi.fn(async () => 'data:image/png;base64,Zml4dHVyZQ=='),
}));
vi.mock('@/features/assets/application/assetCatalog', async (importOriginal) => ({
  ...await importOriginal<typeof AssetCatalog>(),
  saveAsset: vi.fn(async (input: Parameters<typeof AssetCatalog.saveAsset>[0]) => {
    const asset: AssetCatalog.AssetRecord = { ...input, id: `fixture-capture-${fixture.assets.size}`, createdAt: 1, favorite: false };
    fixture.assets.set(asset.id, asset);
    return asset;
  }),
  resolveAsset: async (id: string) => fixture.assets.get(id) ?? null,
  deleteAssetReference: async (id: string) => { fixture.assets.delete(id); },
}));
vi.mock('./BlueprintScene', () => ({
  // Deliberately fixture-only pixels: this exercises the mounted production shell,
  // actual store command and capture bridge, not GPU/visual fidelity.
  BlueprintScene: forwardRef<BlueprintSceneHandle, BlueprintSceneProps>(function FixtureScene(props, ref) {
    useEffect(() => {
      if (fixture.synchronize) {
        if (!props.lighting) throw new Error('Shell must supply normalized lighting');
        fixture.items = props.items;
        fixture.revision = { inputs: {
          items: props.items, customActionPoses: props.customActionPoses, mode: props.mode ?? 'flat',
          panoramaUrl: props.panoramaUrl, cameraFov: props.cameraFov ?? 45,
          cameraDistance: props.cameraDistance ?? 10, lighting: props.lighting,
          motionProject: props.motionProject, meshDetail: 'full', width: props.width ?? 720, height: props.height ?? 440,
        } };
      }
      fixture.ready = true;
    }, [props.items, props.cameraFov, props.cameraDistance, props.lighting, props.motionProject, props.panoramaUrl, props.mode, props.customActionPoses, props.width, props.height]);
    useImperativeHandle(ref, () => ({
      getCaptureRevision: () => fixture.revision,
      captureFrame: async () => {
        fixture.rendered(fixture.items);
        return new Blob(['fixture-pixels'], { type: 'image/png' });
      },
      exportPng: () => null,
      resetCamera: () => {}, fitCamera: () => {}, focusItem: () => {},
      getSuggestedInsertPosition: () => ({ x: 0, y: 0, z: 0 }),
      getCameraSnapshot: () => null, getCanvas: () => null,
      applyMotionFrame: () => {}, setMotionPlaybackActive: () => {}, renderFrame: () => {},
      setExportMode: () => {}, enterPilot: () => {}, exitPilot: () => {},
      completeMotionRouteDraft: () => false, cancelMotionRouteDraft: () => {},
      getPersonPose: () => null, previewPersonPose: () => {},
    }), []);
    return null;
  }),
}));

let root: Root | undefined;
let host: HTMLDivElement;
function data(): BlueprintNodeData {
  const node = useCanvasStore.getState().nodes.find((entry) => entry.id === 'stage');
  if (!isBlueprintNode(node)) throw new Error('Fixture stage missing');
  return node.data;
}
function Harness() {
  const scene = useCanvasStore((state) => state.nodes.find((node) => node.id === 'stage'));
  if (!isBlueprintNode(scene)) throw new Error('Fixture stage missing');
  return createElement(DirectorStudioShell, {
    sourceNodeId: scene.id, data: scene.data, referenceImages: [], selectedItemId: null,
    onSelectedItemChange: () => {}, onItemsChange: () => {}, onUpdateNodeData: () => {},
    onAddSnapshotToCanvas: () => {}, onClose: () => {},
  });
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  useProjectStore.setState({ currentProjectId: null });
  fixture.assets.clear(); fixture.rendered.mockClear(); fixture.ready = false; fixture.synchronize = true;
  fixture.revision = null;
  useCanvasStore.setState({ nodes: [{ id: 'stage', type: CANVAS_NODE_TYPES.blueprint, position: { x: 0, y: 0 }, data: {
    mode: 'flat', aspectRatio: '16:9', items: [{ id: 'box', category: 'object', label: 'Box', color: '#fff', x: 0, y: 0, pos3d: { x: 0, y: 0, z: 0 } }], referenceImages: [],
  } }], edges: [], revision: 0, history: { past: [], future: [] } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root?.render(createElement(Harness)); });
  await act(async () => { await vi.waitFor(() => expect(fixture.ready).toBe(true)); });
});
afterEach(async () => {
  await act(async () => { root?.unmount(); root = undefined; });
  host.remove(); vi.unstubAllGlobals();
});

describe('mounted stage shell capture readiness', () => {
  it('rejects immediate execute→capture before React and mesh synchronization instead of publishing stale pixels', async () => {
    const previousItems = fixture.items;
    await act(async () => {
      stageCommands.execute('stage', { type: 'object.update', itemId: 'box', patch: { pos3d: { x: 8, y: 0, z: 0 } } });
      const committed = useCanvasStore.getState();
      expect(data().items).not.toBe(previousItems);
      expect(fixture.items).toBe(previousItems);
      const result = await stageCommands.capture('stage').then(() => 'published', () => 'rejected');
      expect({
        result, assets: fixture.assets.size,
        renderedX: fixture.rendered.mock.calls.map(([items]) => items[0].pos3d?.x),
      }).toEqual({ result: 'rejected', assets: 0, renderedX: [] });
      expect(useCanvasStore.getState().nodes).toBe(committed.nodes);
      expect(useCanvasStore.getState().history).toBe(committed.history);
    });
    await expect(stageCommands.capture('stage')).resolves.toMatchObject({ assetId: 'fixture-capture-0' });
    expect(fixture.rendered).toHaveBeenLastCalledWith(data().items);
    expect(fixture.items[0].pos3d?.x).toBe(8);
  });
  it('rejects current shell data while the renderer still owns the preceding mesh inputs', async () => {
    const previousItems = fixture.items;
    fixture.synchronize = false;
    await act(async () => {
      stageCommands.execute('stage', { type: 'object.update', itemId: 'box', patch: { pos3d: { x: 9, y: 0, z: 0 } } });
    });
    expect(data().items).not.toBe(previousItems);
    expect(fixture.items).toBe(previousItems);
    const committed = useCanvasStore.getState();
    const result = await stageCommands.capture('stage').then(() => 'published', () => 'rejected');
    expect({
      result, assets: fixture.assets.size,
      renderedX: fixture.rendered.mock.calls.map(([items]) => items[0].pos3d?.x),
    }).toEqual({ result: 'rejected', assets: 0, renderedX: [] });
    expect(useCanvasStore.getState().nodes).toBe(committed.nodes);
    expect(useCanvasStore.getState().history).toBe(committed.history);
  });
});
