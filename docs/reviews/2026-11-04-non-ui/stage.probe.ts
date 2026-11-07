// @vitest-environment jsdom
// Audit-only failing examples; imports the unchanged production hook.
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useDirectorStudioMotion } from '@/features/canvas/ui/useDirectorStudioMotion';
import { createEmptyDirectorMotionProject } from '@/features/canvas/application/directorMotion';
import { prepareStageCommands } from '@/features/stage/application/stageOperations';
import type { BlueprintNodeData } from '@/features/canvas/domain/canvasNodes';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

function fixture() {
  const motionProject = createEmptyDirectorMotionProject();
  motionProject.durationSeconds = 12;
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
  const patch = onUpdateNodeData.mock.calls.at(-1)?.[0];
  console.log('duration probe', JSON.stringify(patch?.motionProject?.objectTracks.actor.map((frame) => ({ id: frame.id, time: frame.time }))));
  expect(onUpdateNodeData, 'unsafe shortening must not silently replace the existing track').not.toHaveBeenCalled();
});

it('drawing a route at 0–4 seconds preserves the authored frames at 8 and 10 seconds', () => {
  const { hook, onUpdateNodeData } = fixture();
  act(() => hook.result.current.startMotionRouteDraft({ kind: 'object', trackId: 'actor', method: 'line' }));
  act(() => hook.result.current.completeMotionRouteDraft([{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 1 }]));
  const ids = onUpdateNodeData.mock.calls.at(-1)?.[0].motionProject?.objectTracks.actor.map((frame) => frame.id);
  console.log('route probe', JSON.stringify(ids));
  expect(ids).toEqual(expect.arrayContaining(['frame-8', 'frame-10']));
});
