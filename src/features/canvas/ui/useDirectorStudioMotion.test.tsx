// @vitest-environment jsdom
// User-facing edits must honor the shared stage command safety rules.
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useDirectorStudioMotion } from '@/features/canvas/ui/useDirectorStudioMotion';
import { createEmptyDirectorMotionProject } from '@/features/canvas/application/directorMotion';
import { prepareStageCommands } from '@/features/stage/application/stageOperations';
import type { BlueprintNodeData } from '@/features/canvas/domain/canvasNodes';

vi.mock('@/features/canvas/application/errorDialog', () => ({ showErrorDialog: vi.fn(async () => undefined) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

function fixture(withCamera = false) {
  const motionProject = createEmptyDirectorMotionProject();
  motionProject.durationSeconds = 12;
  if (withCamera) motionProject.cameraTrack = [{ id: 'camera-start', time: 0, easing: 'linear', position: { x: 4, y: 2, z: 5 }, target: { x: 0, y: 1, z: 0 }, fov: 50 }];
  motionProject.objectTracks.actor = [0, 8, 10].map((time) => ({
    id: `frame-${time}`, time, easing: 'linear',
    position: { x: time, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
  }));
  const data: BlueprintNodeData = {
    mode: 'flat', aspectRatio: '16:9', referenceImages: [], motionProject,
    items: [{ id: 'actor', label: 'Actor', category: 'person', presetId: 'man', color: '#fff', x: 260, y: 130 }],
  };
  const onUpdateNodeData = vi.fn<(patch: Partial<BlueprintNodeData>) => void>();
  const hook = renderHook(() => useDirectorStudioMotion({
    data, previewEnabled: false, selectedItem: data.items[0], editorRef: { current: null },
    onUpdateNodeData, onUpdateItemAction: vi.fn(),
  }));
  return { data, hook, onUpdateNodeData };
}

it('duration control preserves the same truncation protection as StageCommands', () => {
  const { data, hook, onUpdateNodeData } = fixture();
  expect(() => prepareStageCommands(data, [{ type: 'playback.update', duration: 5 }])).toThrow(/shortening/);
  act(() => hook.result.current.updateMotionDuration(5));
  expect(onUpdateNodeData, 'unsafe shortening must not silently replace the existing track').not.toHaveBeenCalled();
});

it('drawing a route at 0–4 seconds preserves the authored frames at 8 and 10 seconds', () => {
  const { hook, onUpdateNodeData } = fixture();
  act(() => hook.result.current.startMotionRouteDraft({ kind: 'object', trackId: 'actor', method: 'line' }));
  act(() => hook.result.current.completeMotionRouteDraft([{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 1 }]));
  const ids = onUpdateNodeData.mock.calls.at(-1)?.[0].motionProject?.objectTracks.actor.map((frame) => frame.id);
  expect(ids).toEqual(expect.arrayContaining(['frame-8', 'frame-10']));
});

it('cuts a spatial track at the playhead without dropping its later authored frames', () => {
  const { hook, onUpdateNodeData } = fixture();
  act(() => hook.result.current.splitAtTime('object', 'actor', 4));
  const track = onUpdateNodeData.mock.calls.at(-1)?.[0].motionProject?.objectTracks.actor;
  expect(track?.map((frame) => frame.time)).toEqual([0, 4, 8, 10]);
  expect(track?.find((frame) => frame.time === 4)?.position.x).toBe(4);
});

it('copies a spatial range with new frame identities while retaining the original track', () => {
  const { hook, onUpdateNodeData } = fixture();
  act(() => hook.result.current.copyMotionTrack('object', 'actor', 1, 11));
  const track = onUpdateNodeData.mock.calls.at(-1)?.[0].motionProject?.objectTracks.actor ?? [];
  expect(track.map((frame) => frame.id)).toEqual(expect.arrayContaining(['frame-0', 'frame-8', 'frame-10']));
  expect(new Set(track.map((frame) => frame.id)).size).toBe(6);
});

it('camera gestures update one existing frame and explicitly switch target, point and free modes', () => {
  const { data, hook, onUpdateNodeData } = fixture(true);
  const apply = () => {
    const patch = onUpdateNodeData.mock.calls.at(-1)?.[0];
    if (!patch?.motionProject) throw new Error('Expected one stage edit');
    data.motionProject = patch.motionProject;
    hook.rerender();
    return patch.motionProject.cameraTrack[0];
  };
  act(() => { expect(hook.result.current.setCameraLookAt({ mode: 'target', targetId: 'actor' })).toBe(true); });
  expect(apply()).toMatchObject({ id: 'camera-start', trackTargetId: 'actor', trackTargetBodyPart: 'torso' });
  act(() => { hook.result.current.setCameraLookAt({ mode: 'free', rotation: { x: 0.2, y: 0.3, z: 0.9 } }); });
  expect(apply()).toMatchObject({ id: 'camera-start', trackTargetId: null, freeRotation: { x: 0.2, y: 0.3, z: 0.9 } });
  act(() => { hook.result.current.setCameraLookAt({ mode: 'point', point: { x: 8, y: 3, z: -1 } }); });
  const frame = apply();
  expect(frame).toMatchObject({ id: 'camera-start', trackTargetId: null, target: { x: 8, y: 3, z: -1 } });
  expect(frame.freeRotation).toBeUndefined();
  expect(onUpdateNodeData).toHaveBeenCalledTimes(3);
});
