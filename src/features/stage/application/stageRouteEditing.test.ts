import { expect, it } from 'vitest';
import { createEmptyDirectorMotionProject } from '@/features/canvas/application/directorMotion';
import type { BlueprintNodeData, DirectorMotionProjectV1 } from '@/features/canvas/domain/canvasNodes';
import { prepareStageCommands } from './stageOperations';
import { retimeStageRoute, stageRouteClosed, toggleStageRouteClosed } from './stageRouteEditing';

function data(project: DirectorMotionProjectV1): BlueprintNodeData {
  return { mode: 'flat', aspectRatio: '16:9', referenceImages: [], items: [{ id: 'actor', category: 'person', label: 'Actor', color: '#fff', x: 0, y: 0 }], motionProject: project };
}
function fixture() {
  const project = createEmptyDirectorMotionProject(12);
  project.objectTracks.actor = [1, 3, 7].map((time, index) => ({ id: `point-${index}`, time, easing: 'smooth', easingRange: [0.1, 0.9], position: { x: index * 2, y: 1, z: index }, rotation: { x: 0, y: index, z: 0 }, scale: { x: 1, y: 1.5, z: 1 }, orientToPath: false }));
  return project;
}
it('retimes to a minimum 0.2s and preserves authored orientation, easing and frame identities', () => {
  const project = fixture();
  const updated = prepareStageCommands(data(project), retimeStageRoute(project, { kind: 'object', trackId: 'actor' }, 1, 1.01)).data.motionProject!;
  expect(updated.objectTracks.actor.map((frame) => frame.time)).toEqual([1, 1 + 0.2 / 3, 1.2]);
  expect(updated.objectTracks.actor.map(({ time: _time, ...frame }) => frame)).toEqual(project.objectTracks.actor.map(({ time: _time, ...frame }) => frame));
});
it('closes and reopens the route without losing its previous endpoint or duration', () => {
  const project = fixture(), ref = { kind: 'object' as const, trackId: 'actor' };
  const closed = prepareStageCommands(data(project), toggleStageRouteClosed(project, ref)).data.motionProject!;
  expect(stageRouteClosed(closed.objectTracks.actor)).toBe(true);
  expect(closed.objectTracks.actor.at(-1)?.time).toBe(7);
  expect(closed.objectTracks.actor.at(-2)?.position).toEqual(project.objectTracks.actor.at(-1)?.position);
  const reopened = prepareStageCommands(data(closed), toggleStageRouteClosed(closed, ref)).data.motionProject!;
  expect(stageRouteClosed(reopened.objectTracks.actor)).toBe(false);
  expect(reopened.objectTracks.actor).toEqual(project.objectTracks.actor);
});
it('refuses to retime a locked actor through the same stage edit boundary', () => {
  const project = fixture(), original = data(project);
  original.items[0].locked = true;
  expect(() => prepareStageCommands(original, retimeStageRoute(project, { kind: 'object', trackId: 'actor' }, 1, 4))).toThrow(/locked/);
  expect(original.motionProject).toBe(project);
});

it('does not mistake a post-route resume boundary for a closing endpoint or delete it on open', () => {
  const original = data(createEmptyDirectorMotionProject(8));
  const project = prepareStageCommands(original, [{ type: 'trajectory.set', targetId: 'actor', method: 'line', points: [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }], start: 0, duration: 4 }]).data.motionProject!;
  const ref = { kind: 'object' as const, trackId: 'actor' };
  const guard = project.objectTracks.actor.find((frame) => frame.id.startsWith('resume-'));
  expect(guard?.time).toBe(4.000001);
  expect(stageRouteClosed(project.objectTracks.actor)).toBe(false);
  const closed = prepareStageCommands(data(project), toggleStageRouteClosed(project, ref)).data.motionProject!;
  expect(stageRouteClosed(closed.objectTracks.actor)).toBe(true);
  expect(closed.objectTracks.actor.find((frame) => frame.id === guard?.id)).toEqual(guard);
  const opened = prepareStageCommands(data(closed), toggleStageRouteClosed(closed, ref)).data.motionProject!;
  expect(stageRouteClosed(opened.objectTracks.actor)).toBe(false);
  expect(opened.objectTracks.actor).toEqual(project.objectTracks.actor);
});
