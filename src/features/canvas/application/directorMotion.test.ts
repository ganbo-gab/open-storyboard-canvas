import { describe, expect, it } from 'vitest';

import type { BlueprintItem, DirectorMotionProjectV1 } from '@/features/canvas/domain/canvasNodes';
import {
  DIRECTOR_PROCEDURAL_ACTIONS,
  DIRECTOR_STATIC_POSES,
  createDirectorCameraPresetTrack,
  createDirectorCameraRouteTrack,
  createDirectorObjectRouteTrack,
  createEmptyDirectorMotionProject,
  deleteDirectorMotionClip,
  normalizeDirectorMotionProject,
  retimeDirectorTrack,
  sampleDirectorMotion,
  sampleDirectorProceduralAction,
  timeDirectorRoutePoints,
} from './directorMotion';

describe('director motion schema', () => {
  it('moves and stretches a route without changing its points or keyframe identity', () => {
    const route = [
      { id: 'a', time: 1, position: { x: 0 } },
      { id: 'b', time: 2, position: { x: 4 } },
      { id: 'c', time: 5, position: { x: 8 } },
    ];
    const next = retimeDirectorTrack(route, 3, 7, 8);
    expect(next.map((frame) => frame.time)).toEqual([3, 4, 7]);
    expect(next.map((frame) => frame.id)).toEqual(['a', 'b', 'c']);
    expect(next.map((frame) => frame.position.x)).toEqual([0, 4, 8]);
    expect(route[0].time).toBe(1);
    expect(retimeDirectorTrack(route, 7.99, 12, 8).map((frame) => frame.time)).toEqual([7.9, 7.925000000000001, 8]);
  });
  it('normalizes a legacy missing value without mutating persisted input', () => {
    const project = normalizeDirectorMotionProject(undefined);

    expect(project).toEqual({
      schemaVersion: 1,
      durationSeconds: 8,
      loop: false,
      cameraTrack: [],
      objectTracks: {},
      actionTracks: {},
      customClips: [],
    });
  });

  it('clamps duration and keyframe values and sorts equal times stably', () => {
    const project = normalizeDirectorMotionProject({
      schemaVersion: 99,
      durationSeconds: 500,
      objectTracks: {
        item: [
          { id: 'late', time: 40, easing: 'smooth', position: { x: 5, y: 0, z: 0 } },
          { id: 'first-equal', time: 2, position: { x: 1, y: 0, z: 0 } },
          { id: 'second-equal', time: 2, position: { x: 2, y: 0, z: 0 } },
        ],
      },
    });

    expect(project.schemaVersion).toBe(1);
    expect(project.durationSeconds).toBe(30);
    expect(project.objectTracks.item.map((keyframe) => keyframe.id)).toEqual([
      'first-equal',
      'second-equal',
      'late',
    ]);
    expect(project.objectTracks.item[2].time).toBe(30);
    expect(project.objectTracks.item[0].scale).toEqual({ x: 1, y: 1, z: 1 });
  });
});

describe('director motion sampling', () => {
  it('interpolates transform, camera, FOV, and tracked targets', () => {
    const project: DirectorMotionProjectV1 = {
      ...createEmptyDirectorMotionProject(8),
      cameraTrack: [
        { id: 'c0', time: 0, easing: 'linear', position: { x: 0, y: 2, z: 8 }, target: { x: 0, y: 1, z: 0 }, fov: 40, trackTargetId: 'person', trackTargetBodyPart: 'head' },
        { id: 'c1', time: 8, easing: 'linear', position: { x: 8, y: 4, z: 4 }, target: { x: 0, y: 1, z: 0 }, fov: 60, trackTargetId: 'person', trackTargetBodyPart: 'head' },
      ],
      objectTracks: {
        person: [
          { id: 'p0', time: 0, easing: 'linear', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
          { id: 'p1', time: 8, easing: 'linear', position: { x: 8, y: 0, z: 0 }, rotation: { x: 0, y: Math.PI, z: 0 }, scale: { x: 2, y: 2, z: 2 } },
        ],
      },
    };

    const frame = sampleDirectorMotion(project, 4);
    expect(frame.objects.person.position).toEqual({ x: 4, y: 0, z: 0 });
    expect(frame.objects.person.scale).toEqual({ x: 1.5, y: 1.5, z: 1.5 });
    expect(Math.abs(frame.objects.person.rotation.y)).toBeCloseTo(Math.PI / 2, 5);
    expect(frame.camera?.position).toEqual({ x: 4, y: 3, z: 6 });
    expect(frame.camera?.fov).toBe(50);
    expect(frame.camera?.target).toEqual({ x: 4, y: 1.6, z: 0 });
  });

  it('uses cubic smooth easing deterministically', () => {
    const project: DirectorMotionProjectV1 = {
      ...createEmptyDirectorMotionProject(4),
      objectTracks: {
        item: [
          { id: 'a', time: 0, easing: 'linear', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
          { id: 'b', time: 4, easing: 'smooth', position: { x: 8, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        ],
      },
    };

    expect(sampleDirectorMotion(project, 1).objects.item.position.x).toBeCloseTo(1.25);
    expect(sampleDirectorMotion(project, 2).objects.item.position.x).toBe(4);
  });

  it('samples distinct procedural actions and a looping custom clip', () => {
    expect(DIRECTOR_PROCEDURAL_ACTIONS.length).toBeGreaterThanOrEqual(13);
    DIRECTOR_PROCEDURAL_ACTIONS.forEach((action) => {
      expect(sampleDirectorProceduralAction(action.id, action.durationSeconds / 3)).toBeTruthy();
    });
    expect(sampleDirectorProceduralAction('clap', 0.55)).not.toEqual(sampleDirectorProceduralAction('walk-back', 0.55));
    expect(DIRECTOR_STATIC_POSES.length).toBeGreaterThanOrEqual(20);

    const project: DirectorMotionProjectV1 = {
      ...createEmptyDirectorMotionProject(8),
      customClips: [{
        id: 'clip', name: 'Wave clip', durationSeconds: 1, loop: true,
        keyframes: [
          { id: 'a', time: 0, easing: 'linear', pose: { head: { y: 0 } } },
          { id: 'b', time: 1, easing: 'linear', pose: { head: { y: 1 } } },
        ],
      }],
      actionTracks: {
        actor: [{ id: 'use-clip', time: 0, easing: 'linear', clipId: 'clip' }],
      },
    };

    expect(sampleDirectorMotion(project, 1.5).actions.actor.pose?.head?.y).toBeCloseTo(0.5);
  });

  it('includes the persisted base transform for an action-only track', () => {
    const actor = {
      id: 'actor',
      label: 'Actor',
      color: '#fff',
      x: 0,
      y: 0,
      category: 'person',
      pos3d: { x: 3, y: 0.5, z: -2 },
      rotation3d: { x: 0.1, y: 0.2, z: 0.3 },
      scale3d: { x: 1.2, y: 1.3, z: 1.4 },
    } as BlueprintItem;
    const project: DirectorMotionProjectV1 = {
      ...createEmptyDirectorMotionProject(8),
      actionTracks: {
        actor: [{ id: 'wave', time: 0, easing: 'linear', actionId: 'wave' }],
      },
    };

    const frame = sampleDirectorMotion(project, 1, [actor]);

    expect(frame.objects.actor).toEqual({
      position: actor.pos3d,
      rotation: actor.rotation3d,
      scale: actor.scale3d,
    });
    expect(frame.actions.actor.pose).toBeTruthy();
  });

  it('restores the persisted base transform after the final transform keyframe is removed', () => {
    const item = {
      id: 'item',
      label: 'Item',
      color: '#fff',
      x: 0,
      y: 0,
      category: 'object',
      pos3d: { x: 1, y: 0, z: 2 },
      rotation3d: { x: 0, y: 0.4, z: 0 },
      scale3d: { x: 1, y: 1.5, z: 1 },
    } as BlueprintItem;
    const project: DirectorMotionProjectV1 = {
      ...createEmptyDirectorMotionProject(8),
      objectTracks: {
        item: [{
          id: 'moved',
          time: 0,
          easing: 'linear',
          position: { x: 9, y: 0, z: 9 },
          rotation: { x: 0, y: 1, z: 0 },
          scale: { x: 2, y: 2, z: 2 },
        }],
      },
    };

    expect(sampleDirectorMotion(project, 0, [item]).objects.item.position).toEqual({ x: 9, y: 0, z: 9 });

    project.objectTracks.item = [];
    expect(sampleDirectorMotion(project, 0, [item]).objects.item).toEqual({
      position: item.pos3d,
      rotation: item.rotation3d,
      scale: item.scale3d,
    });
  });

  it('creates six editable camera route templates', () => {
    const actor = { id: 'actor', label: 'Actor', color: '#fff', x: 0, y: 0, category: 'person' } as BlueprintItem;
    const presetIds = ['cinematic-push', 'character-follow', 'fast-chase', 'product-orbit', 'crane-rise', 'lateral-dolly'] as const;
    presetIds.forEach((presetId) => {
      const track = createDirectorCameraPresetTrack(presetId, 8, actor);
      expect(track.length).toBeGreaterThanOrEqual(2);
      expect(track[0].time).toBe(0);
      expect(track[track.length - 1].time).toBe(8);
    });
  });

  it('converts clicked routes to distance-paced editable V1 tracks', () => {
    const item = { id: 'actor', label: 'Actor', color: '#fff', x: 0, y: 0, category: 'person', pos3d: { x: 0, y: 0.3, z: 0 } } as BlueprintItem;
    const points = [
      { x: 0, y: 0.3, z: 0 },
      { x: 1, y: 0.3, z: 0 },
      { x: 1, y: 0.3, z: 0 },
      { x: 4, y: 0.3, z: 0 },
    ];
    const timed = timeDirectorRoutePoints(points, 2, 10);
    expect(timed.map((frame) => frame.time)).toEqual([2, 4, 10]);
    const track = createDirectorObjectRouteTrack(points, item, 2, 10);
    expect(track).toHaveLength(3);
    expect(track.every((frame) => frame.orientToPath)).toBe(true);
    const project = { ...createEmptyDirectorMotionProject(10), objectTracks: { actor: track } };
    expect(sampleDirectorMotion(project, 4, [item]).objects.actor.position.x).toBeCloseTo(1);
    expect(normalizeDirectorMotionProject(JSON.parse(JSON.stringify(project))).objectTracks.actor).toEqual(track);
  });

  it('keeps path-facing orientation continuous through a turn and respects a yaw offset', () => {
    const actor = { id: 'actor', label: 'Actor', color: '#fff', x: 0, y: 0, category: 'person' } as BlueprintItem;
    const track = createDirectorObjectRouteTrack([
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 2 },
      { x: 2, y: 0, z: 2 },
    ], actor, 0, 8).map((frame) => ({ ...frame, rotation: { ...frame.rotation, y: 0.2 } }));
    const project = { ...createEmptyDirectorMotionProject(8), objectTracks: { actor: track } };
    const justBefore = sampleDirectorMotion(project, 3.99, [actor]).objects.actor.rotation.y;
    const atTurn = sampleDirectorMotion(project, 4, [actor]).objects.actor.rotation.y;
    const justAfter = sampleDirectorMotion(project, 4.01, [actor]).objects.actor.rotation.y;
    expect(atTurn).toBeCloseTo(Math.PI / 4 + 0.2, 3);
    expect(Math.abs(atTurn - justBefore)).toBeLessThan(0.02);
    expect(Math.abs(justAfter - atTurn)).toBeLessThan(0.02);
  });

  it('bounds freehand keyframes and preserves a camera route target', () => {
    const points = Array.from({ length: 300 }, (_, index) => ({ x: index * 0.1, y: 0, z: Math.sin(index / 10) }));
    const camera = { target: { x: 2, y: 1, z: 3 }, fov: 48, trackTargetId: 'actor', trackTargetBodyPart: 'head' };
    const track = createDirectorCameraRouteTrack(points, camera, 0, 8);
    expect(track).toHaveLength(48);
    expect(track[0].time).toBe(0);
    expect(track[track.length - 1].time).toBeCloseTo(8);
    expect(track.every((frame) => frame.trackTargetId === 'actor' && frame.trackTargetBodyPart === 'head')).toBe(true);
    expect(timeDirectorRoutePoints([{ x: 0, y: 0, z: 0 }, { x: Number.NaN, y: 0, z: 0 }], 0, 8)).toEqual([]);
  });

  it('maintains walking and camera speed through dense hand-drawn route points', () => {
    const actor = { id: 'actor', label: 'Actor', color: '#fff', x: 0, y: 0, category: 'person' } as BlueprintItem;
    const points = Array.from({ length: 96 }, (_, index) => ({ x: index * 0.1, y: 0, z: 0 }));
    const objectTrack = createDirectorObjectRouteTrack(points, actor, 0, 8);
    const cameraTrack = createDirectorCameraRouteTrack(points, { target: { x: 0, y: 1, z: 0 }, fov: 45 }, 0, 8);
    const followTrack = createDirectorCameraPresetTrack('follow-actor-route', 8, actor, objectTrack);
    expect(objectTrack).toHaveLength(48);
    expect(objectTrack.every((frame) => frame.easing === 'linear')).toBe(true);
    expect(cameraTrack.every((frame) => frame.easing === 'linear')).toBe(true);
    expect(followTrack.every((frame) => frame.easing === 'linear')).toBe(true);

    const crossingTime = objectTrack[24].time;
    const delta = Math.min(
      crossingTime - objectTrack[23].time,
      objectTrack[25].time - crossingTime,
    ) * 0.2;
    const expectedSpeed = 9.5 / 8;
    for (const track of [cameraTrack, followTrack]) {
      const project = { ...createEmptyDirectorMotionProject(8), objectTracks: { actor: objectTrack }, cameraTrack: track };
      const before = sampleDirectorMotion(project, crossingTime - delta, [actor]);
      const middle = sampleDirectorMotion(project, crossingTime, [actor]);
      const after = sampleDirectorMotion(project, crossingTime + delta, [actor]);
      const actorSpeedBefore = (middle.objects.actor.position.x - before.objects.actor.position.x) / delta;
      const actorSpeedAfter = (after.objects.actor.position.x - middle.objects.actor.position.x) / delta;
      const cameraSpeedBefore = ((middle.camera?.position.x ?? 0) - (before.camera?.position.x ?? 0)) / delta;
      const cameraSpeedAfter = ((after.camera?.position.x ?? 0) - (middle.camera?.position.x ?? 0)) / delta;
      for (const speed of [actorSpeedBefore, actorSpeedAfter, cameraSpeedBefore, cameraSpeedAfter]) {
        expect(speed).toBeCloseTo(expectedSpeed, 2);
      }
    }
  });

  it('builds a behind-the-actor follow shot from a saved person route', () => {
    const actor = { id: 'actor', label: 'Actor', color: '#fff', x: 0, y: 0, category: 'person' } as BlueprintItem;
    const route = createDirectorObjectRouteTrack([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 4 }], actor, 0, 8);
    const cameraTrack = createDirectorCameraPresetTrack('follow-actor-route', 8, actor, route);
    const project = { ...createEmptyDirectorMotionProject(8), cameraTrack, objectTracks: { actor: route } };
    const frame = sampleDirectorMotion(project, 4, [actor]);
    expect(frame.camera?.position.z).toBeCloseTo(-2.2);
    expect(frame.camera?.target).toEqual({ x: 0, y: 1.05, z: 2 });
    expect(frame.camera?.trackTargetId).toBe('actor');
  });

  it('orbits outside an actor at a route reversal instead of crossing through them', () => {
    const actor = { id: 'actor', label: 'Actor', color: '#fff', x: 0, y: 0, category: 'person' } as BlueprintItem;
    const route = createDirectorObjectRouteTrack([
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 4 },
      { x: 0, y: 0, z: 0 },
    ], actor, 0, 8);
    const cameraTrack = createDirectorCameraPresetTrack('follow-actor-route', 8, actor, route);
    const project = { ...createEmptyDirectorMotionProject(8), cameraTrack, objectTracks: { actor: route } };
    expect(Math.abs(cameraTrack[1].position.x)).toBeGreaterThan(3);
    for (let index = 0; index <= 80; index += 1) {
      const frame = sampleDirectorMotion(project, index / 10, [actor]);
      const camera = frame.camera!.position;
      const position = frame.objects.actor.position;
      expect(Math.hypot(camera.x - position.x, camera.z - position.z)).toBeGreaterThan(2.5);
      expect(frame.camera?.trackTargetId).toBe('actor');
    }
  });

  it('stays beside the actor through consecutive route reversals', () => {
    const actor = { id: 'actor', label: 'Actor', color: '#fff', x: 0, y: 0, category: 'person' } as BlueprintItem;
    const route = createDirectorObjectRouteTrack([
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 4 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 4 },
    ], actor, 0, 8);
    const cameraTrack = createDirectorCameraPresetTrack('follow-actor-route', 8, actor, route);
    const project = { ...createEmptyDirectorMotionProject(8), cameraTrack, objectTracks: { actor: route } };

    for (let index = 0; index <= 80; index += 1) {
      const frame = sampleDirectorMotion(project, index / 10, [actor]);
      const camera = frame.camera!.position;
      const position = frame.objects.actor.position;
      expect(Math.hypot(camera.x - position.x, camera.z - position.z)).toBeGreaterThan(2.5);
    }
  });

  it('deletes custom clips and every action keyframe that references them', () => {
    const project: DirectorMotionProjectV1 = {
      ...createEmptyDirectorMotionProject(8),
      customClips: [
        { id: 'remove', name: 'Remove', durationSeconds: 1, loop: false, keyframes: [] },
        {
          id: 'keep',
          name: 'Keep',
          durationSeconds: 1,
          loop: false,
          keyframes: [
            { id: 'nested-remove-ref', time: 0, easing: 'linear', clipId: 'remove' },
            { id: 'nested-pose', time: 1, easing: 'linear', poseId: 'stand-neutral' },
          ],
        },
      ],
      actionTracks: {
        actor: [
          { id: 'remove-ref', time: 0, easing: 'linear', clipId: 'remove' },
          { id: 'keep-ref', time: 1, easing: 'linear', clipId: 'keep' },
          { id: 'pose', time: 2, easing: 'linear', poseId: 'stand-neutral' },
        ],
      },
    };

    const next = deleteDirectorMotionClip(project, 'remove');

    expect(next.customClips.map((clip) => clip.id)).toEqual(['keep']);
    expect(next.customClips[0].keyframes.map((keyframe) => keyframe.id)).toEqual(['nested-pose']);
    expect(next.actionTracks.actor.map((keyframe) => keyframe.id)).toEqual(['keep-ref', 'pose']);
    expect(project.customClips).toHaveLength(2);
    expect(project.actionTracks.actor).toHaveLength(3);
  });

  it('samples a 50-element / 100-keyframe fixture within the preview budget', () => {
    const project = createEmptyDirectorMotionProject(8);
    const items: BlueprintItem[] = [];
    for (let index = 0; index < 50; index += 1) {
      const id = `item-${index}`;
      items.push({ id, label: id, color: '#fff', x: 0, y: 0, category: index % 2 ? 'object' : 'person' } as BlueprintItem);
      project.objectTracks[id] = [
        { id: `${id}-0`, time: 0, easing: 'smooth', position: { x: index, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        { id: `${id}-1`, time: 8, easing: 'smooth', position: { x: index, y: 0, z: 8 }, rotation: { x: 0, y: 1, z: 0 }, scale: { x: 1, y: 1, z: 1 }, orientToPath: index % 2 === 0 },
      ];
    }

    const startedAt = performance.now();
    for (let frame = 0; frame < 120; frame += 1) {
      sampleDirectorMotion(project, frame / 15, items);
    }
    const elapsed = performance.now() - startedAt;

    expect(elapsed).toBeLessThan(1_500);
    expect(Object.keys(sampleDirectorMotion(project, 4, items).objects)).toHaveLength(50);
  });
});
