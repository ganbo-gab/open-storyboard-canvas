import { describe, expect, it } from 'vitest';

import type { BlueprintActionPose, BlueprintItem, DirectorActionClip, DirectorCameraRig, DirectorMotionProjectV1 } from '@/features/canvas/domain/canvasNodes';
import {
  DIRECTOR_CAMERA_RIG_DEFAULTS,
  createDirectorCameraPresetTrack,
  createDirectorCameraRouteTrack,
  createDirectorObjectRouteTrack,
  createEmptyDirectorMotionProject,
  deleteDirectorMotionClip,
  normalizeDirectorMotionProject,
  retimeDirectorTrack,
  sampleDirectorMotion,
  splitDirectorMotionClip,
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
      cameraRigs: [],
    });
  });

  it('clamps duration and keyframe values and sorts equal times stably', () => {
    const project = normalizeDirectorMotionProject({
      schemaVersion: 99,
      durationSeconds: 500,
      objectTracks: {
        item: [
          { id: 'late', time: 140, easing: 'smooth', position: { x: 5, y: 0, z: 0 } },
          { id: 'first-equal', time: 2, position: { x: 1, y: 0, z: 0 } },
          { id: 'second-equal', time: 2, position: { x: 2, y: 0, z: 0 } },
        ],
      },
    });

    expect(project.schemaVersion).toBe(1);
    expect(project.durationSeconds).toBe(120);
    expect(project.objectTracks.item.map((keyframe) => keyframe.id)).toEqual([
      'first-equal',
      'second-equal',
      'late',
    ]);
    expect(project.objectTracks.item[2].time).toBe(120);
    expect(project.objectTracks.item[0].scale).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('retains long project and clip timing with anatomical and legacy poses', () => {
    const anatomical: BlueprintActionPose = {
      spine: { x: 0.2, y: -0.3, z: 0.1 }, chest: { x: 0.1 }, neck: { z: 0.2 },
      leftClavicle: { x: 0.1, y: 0.2 }, rightUpperArm: { x: 1.2, y: 0.3, z: 0.4 },
      leftForearm: { x: 1.1 }, rightWrist: { x: 0.2, y: -0.3, z: 0.1 },
      leftFingers: { curl: 0.7, index: 0.1, thumb: 0.4, spread: 0.3 },
      leftThigh: { x: 0.5, y: 0.2, z: 0.1 }, rightShin: { x: 1.3 },
      leftFoot: { x: 0.2, y: 0.1, z: -0.2 }, rightToes: { x: 0.3 },
      scaleY: 1.1, groupY: 0.2, groupRotX: -0.4, groupRotZ: 0.3,
    };
    const legacy = {
      torso: { x: -0.2 }, leftShoulder: { x: -1, z: -0.4 }, rightElbow: { x: -0.5 },
      leftHip: { x: -0.8, y: 0.1, z: -0.2 }, leftKnee: { x: 1.2 },
    };
    const raw = {
      durationSeconds: 110,
      actionTracks: { actor: [{ id: 'pose', time: 95, pose: anatomical }] },
      customClips: [{
        id: 'long', name: 'Long clip', durationSeconds: 105, loop: false,
        keyframes: [{ id: 'old', time: 90, actionOffsetSeconds: 2.5, pose: legacy }],
      }],
    };
    const project = normalizeDirectorMotionProject(raw);

    expect(project.durationSeconds).toBe(110);
    expect(project.actionTracks.actor[0].time).toBe(95);
    expect(project.actionTracks.actor[0].pose).toEqual(anatomical);
    expect(project.customClips[0].durationSeconds).toBe(105);
    expect(project.customClips[0].keyframes[0]).toMatchObject({
      time: 90, actionOffsetSeconds: 2.5,
      pose: {
        spine: { x: 0.2 }, rightUpperArm: { x: 1, z: 0.4 }, leftForearm: { x: 0.5 },
        rightThigh: { x: 0.8, y: 0.1, z: 0.2 }, rightShin: { x: 1.2 },
      },
    });
    expect(raw.customClips[0].keyframes[0].pose).toEqual(legacy);
    expect(normalizeDirectorMotionProject(project)).toEqual(project);
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

  it('samples pose-only keyframes inside a looping custom clip', () => {
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

  it('interpolates pose-only anatomical joints, fingers and whole-body channels', () => {
    const project: DirectorMotionProjectV1 = {
      ...createEmptyDirectorMotionProject(4),
      actionTracks: { actor: [
        { id: 'a', time: 0, easing: 'linear', pose: {
          spine: { x: 0.2 }, chest: { y: -0.2 }, neck: { z: -0.1 }, leftClavicle: { x: 0.1 },
          leftUpperArm: { x: 0.2, z: 0.4 }, leftForearm: { x: 0.4 }, leftWrist: { y: -0.2 },
          leftFingers: { curl: 0.2, index: 0.1, thumb: 0.2, spread: 0.4 },
          rightThigh: { x: 0.2 }, rightShin: { x: 0.4 }, rightFoot: { z: 0.1 }, rightToes: { x: 0.2 },
          groupY: 0.1, groupRotX: -0.2, groupRotZ: -0.4, scaleY: 0.8,
        } },
        { id: 'b', time: 4, easing: 'linear', pose: {
          spine: { x: 0.6 }, chest: { y: 0.2 }, neck: { z: 0.3 }, leftClavicle: { x: 0.3 },
          leftUpperArm: { x: 1, z: 0.8 }, leftForearm: { x: 1.2 }, leftWrist: { y: 0.6 },
          leftFingers: { curl: 0.8, index: 0.9, thumb: 0.6, spread: 0.8 },
          rightThigh: { x: 1 }, rightShin: { x: 1.2 }, rightFoot: { z: 0.3 }, rightToes: { x: 0.6 },
          groupY: 0.5, groupRotX: 0.6, groupRotZ: 0.8, scaleY: 1.2,
        } },
      ] },
    };

    const pose = sampleDirectorMotion(project, 2).actions.actor.pose!;
    expect(pose.spine?.x).toBeCloseTo(0.4);
    expect(pose.neck?.z).toBeCloseTo(0.1);
    expect(pose.leftClavicle?.x).toBeCloseTo(0.2);
    expect(pose.leftUpperArm?.x).toBeCloseTo(0.6);
    expect(pose.leftUpperArm?.z).toBeCloseTo(0.6);
    expect(pose.leftForearm?.x).toBeCloseTo(0.8);
    expect(pose.leftWrist?.y).toBeCloseTo(0.2);
    expect(pose.leftFingers?.curl).toBeCloseTo(0.5);
    expect(pose.leftFingers?.index).toBeCloseTo(0.5);
    expect(pose.leftFingers?.thumb).toBeCloseTo(0.4);
    expect(pose.leftFingers?.spread).toBeCloseTo(0.6);
    expect(pose.rightThigh?.x).toBeCloseTo(0.6);
    expect(pose.rightShin?.x).toBeCloseTo(0.8);
    expect(pose.rightFoot?.z).toBeCloseTo(0.2);
    expect(pose.rightToes?.x).toBeCloseTo(0.4);
    expect(pose.groupY).toBeCloseTo(0.3);
    expect(pose.groupRotX).toBeCloseTo(0.2);
    expect(pose.groupRotZ).toBeCloseTo(0.2);
    expect(pose.scaleY).toBeCloseTo(1);
    expect(sampleDirectorMotion(project, 4).actions.actor.pose).toEqual(project.actionTracks.actor[1].pose);
  });

  it('layers explicit anatomical edits on a procedural action without losing its moving limbs', () => {
    const project: DirectorMotionProjectV1 = {
      ...createEmptyDirectorMotionProject(4),
      actionTracks: { actor: [{ id: 'walk', time: 0, easing: 'linear', actionId: 'walk', pose: {
        head: { x: 0.3 }, leftFingers: { curl: 0.8, index: 0.1 }, groupRotZ: 0.2,
      } }] },
    };
    const pose = sampleDirectorMotion(project, 0.275).actions.actor.pose!;

    expect(pose.head).toEqual({ x: 0.3 });
    expect(pose.leftFingers).toEqual({ curl: 0.8, index: 0.1 });
    expect(pose.groupRotZ).toBe(0.2);
    expect(pose.leftThigh?.x).toBeCloseTo(24 * Math.PI / 180);
    expect(pose.rightThigh?.x).toBeCloseTo(-24 * Math.PI / 180);
    expect(pose.rightUpperArm?.x).toBeCloseTo(18 * Math.PI / 180);
    expect(sampleDirectorMotion(project, 0.825).actions.actor.pose?.leftThigh?.x).toBeCloseTo(-24 * Math.PI / 180);
  });

  it('layers a pose-only edit on a named static pose', () => {
    const project: DirectorMotionProjectV1 = {
      ...createEmptyDirectorMotionProject(),
      actionTracks: { actor: [{ id: 'point', time: 0, easing: 'linear', poseId: 'point-forward', pose: { head: { x: 0.2 } } }] },
    };
    const pose = sampleDirectorMotion(project, 2).actions.actor.pose!;
    expect(pose.head).toEqual({ x: 0.2 });
    expect(pose.rightUpperArm?.x).toBeCloseTo(88 * Math.PI / 180);
    expect(pose.rightFingers?.index).toBe(0);
    expect(pose.rightFingers?.curl).toBe(1);
  });

  it('plays one-shot actions once and holds their final pose', () => {
    const project: DirectorMotionProjectV1 = {
      ...createEmptyDirectorMotionProject(8),
      actionTracks: { actor: [{ id: 'sit', time: 1, easing: 'linear', actionId: 'sit-down' }] },
    };
    const halfway = sampleDirectorMotion(project, 1.7).actions.actor.pose!;
    const finished = sampleDirectorMotion(project, 2.4).actions.actor.pose!;

    expect(finished.leftThigh?.x).toBeCloseTo(Math.PI / 2);
    expect(finished.leftShin?.x).toBeCloseTo(Math.PI / 2);
    expect(halfway.leftThigh?.x).not.toBeCloseTo(finished.leftThigh!.x!);
    expect(sampleDirectorMotion(project, 4.5).actions.actor.pose).toEqual(finished);
    expect(sampleDirectorMotion(project, 8).actions.actor.pose).toEqual(finished);
  });

  it('restores the item pose when its action track is empty or removed', () => {
    const pose: BlueprintActionPose = { chest: { y: 0.3 }, rightWrist: { x: -0.2 }, leftFingers: { curl: 0.7 }, groupRotZ: 0.1 };
    const actor = { id: 'actor', label: 'Actor', color: '#fff', x: 0, y: 0, category: 'person', pose } as BlueprintItem;
    const project: DirectorMotionProjectV1 = {
      ...createEmptyDirectorMotionProject(4),
      actionTracks: { actor: [{ id: 'override', time: 0, easing: 'linear', pose: { head: { x: 0.3 } } }] },
    };

    expect(sampleDirectorMotion(project, 1, [actor]).actions.actor.pose).toEqual({ head: { x: 0.3 } });
    project.actionTracks.actor = [];
    expect(sampleDirectorMotion(project, 1, [actor]).actions.actor.pose).toEqual(pose);
    delete project.actionTracks.actor;
    expect(sampleDirectorMotion(project, 1, [actor]).actions.actor.pose).toEqual(pose);
    expect(actor.pose).toEqual(pose);
  });

  it('limits scene action crossfades to the final quarter second and respects hold or restricted easing', () => {
    const project: DirectorMotionProjectV1 = {
      ...createEmptyDirectorMotionProject(4),
      actionTracks: { actor: [
        { id: 'walk', time: 0, easing: 'linear', actionId: 'walk', pose: { head: { x: 0.2 } } },
        { id: 'end', time: 2, easing: 'smooth', pose: { head: { x: 0.8 } } },
      ] },
    };

    expect(sampleDirectorMotion(project, 1.75).actions.actor.pose?.head?.x).toBeCloseTo(0.2);
    expect(sampleDirectorMotion(project, 1.875).actions.actor.pose?.head?.x).toBeCloseTo(0.5);
    expect(sampleDirectorMotion(project, 1.999).actions.actor.pose?.head?.x).toBeCloseTo(0.8, 3);
    expect(sampleDirectorMotion(project, 2).actions.actor.pose?.head?.x).toBeCloseTo(0.8);
    project.actionTracks.actor[1].easing = 'hold';
    expect(sampleDirectorMotion(project, 1.99).actions.actor.pose?.head?.x).toBeCloseTo(0.2);
    project.actionTracks.actor[1].easing = 'smooth';
    project.actionTracks.actor[1].easingRange = [0.2, 0.8];
    expect(sampleDirectorMotion(project, 1.99).actions.actor.pose?.head?.x).toBeCloseTo(0.2);
  });

  it('retains procedural phase and authored overlays when a placed clip is split', () => {
    const clip: DirectorActionClip = {
      id: 'walk', name: 'Walk', durationSeconds: 4, loop: false,
      keyframes: [
        { id: 'a', time: 0, easing: 'linear', actionId: 'walk', actionOffsetSeconds: 0.13, pose: { head: { x: 0.3 }, leftFingers: { index: 0.1 } } },
        { id: 'b', time: 4, easing: 'smooth', pose: { head: { x: -0.2 } } },
      ],
    };
    const project: DirectorMotionProjectV1 = {
      ...createEmptyDirectorMotionProject(8), customClips: [clip],
      actionTracks: { actor: [{ id: 'placed', time: 1, easing: 'linear', clipId: clip.id, pose: { rightFingers: { curl: 0.8 } } }] },
    };
    const split = splitDirectorMotionClip(project, clip.id, 2).project;

    for (const time of [1, 1.5, 2.99, 3, 3.01, 3.4, 4.8, 5]) {
      const actual = sampleDirectorMotion(split, time).actions.actor.pose!;
      const expected = sampleDirectorMotion(project, time).actions.actor.pose!;
      expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
      for (const key of Object.keys(expected) as Array<keyof BlueprintActionPose>) {
        const value = expected[key];
        if (typeof value === 'number') expect(actual[key]).toBeCloseTo(value, 10);
        else for (const [channel, amount] of Object.entries(value!)) {
          expect((actual[key] as Record<string, number>)[channel]).toBeCloseTo(amount, 10);
        }
      }
    }
    const pose = sampleDirectorMotion(split, 3.4).actions.actor.pose!;
    expect(pose.head).toEqual({ x: 0.3 });
    expect(pose.leftFingers).toEqual({ index: 0.1 });
    expect(pose.rightFingers).toEqual({ curl: 0.8 });
    expect(sampleDirectorMotion(split, 3.7).actions.actor.pose?.leftThigh?.x).not.toBeCloseTo(pose.leftThigh!.x!);
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

  describe('camera rigs', () => {
    const actor = { id: 'actor', label: 'Actor', color: '#fff', x: 0, y: 0, category: 'person' } as BlueprintItem;
    const route = createDirectorObjectRouteTrack([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 8 }], actor, 0, 8);
    const rig = (patch: Partial<DirectorCameraRig> = {}): DirectorCameraRig => ({
      id: 'rig', kind: 'follow', targetId: 'actor', start: 2, end: 6, ...DIRECTOR_CAMERA_RIG_DEFAULTS.follow, damping: 0, ...patch,
    });
    const fixed = createDirectorCameraRouteTrack([{ x: 9, y: 3, z: 0 }, { x: 9, y: 3, z: 1 }], { target: { x: 0, y: 1, z: 0 }, fov: 50 }, 0, 8);
    const project = (rigs: DirectorCameraRig[]): DirectorMotionProjectV1 => ({
      ...createEmptyDirectorMotionProject(8), cameraTrack: fixed, objectTracks: { actor: route }, cameraRigs: rigs,
    });

    it('rides behind the subject inside its interval and yields to keyframes outside it', () => {
      const sampled = sampleDirectorMotion(project([rig()]), 4, [actor]);
      // Walking +Z at z=4: behind is -Z by the rig distance, aimed at the torso.
      expect(sampled.camera?.position.x).toBeCloseTo(0);
      expect(sampled.camera?.position.z).toBeCloseTo(4 - DIRECTOR_CAMERA_RIG_DEFAULTS.follow.distance);
      expect(sampled.camera?.target).toEqual({ x: expect.closeTo(0), y: expect.closeTo(1.05), z: expect.closeTo(4) });
      expect(sampled.camera?.rigId).toBe('rig');
      expect(sampleDirectorMotion(project([rig()]), 7, [actor]).camera?.position.x).toBeCloseTo(9);
    });

    it('follows later route edits without re-authoring the camera', () => {
      const edited = { ...project([rig()]), objectTracks: { actor: createDirectorObjectRouteTrack([{ x: 5, y: 0, z: 0 }, { x: 5, y: 0, z: 8 }], actor, 0, 8) } };
      expect(sampleDirectorMotion(edited, 4, [actor]).camera?.target.x).toBeCloseTo(5);
    });

    it('lags the subject with damping and stays put once the subject stops', () => {
      const rigid = sampleDirectorMotion(project([rig()]), 4, [actor]).camera!.position.z;
      const damped = sampleDirectorMotion(project([rig({ damping: 0.8 })]), 4, [actor]).camera!.position.z;
      expect(damped).toBeLessThan(rigid - 0.1);
      // Subject stops at z=8 when its route ends at 4 s; well past the lag window the camera has caught up.
      const shortRoute = createDirectorObjectRouteTrack([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 8 }], actor, 0, 4);
      const stopped = { ...project([rig({ damping: 0.8, end: 8 })]), objectTracks: { actor: shortRoute } };
      const late = sampleDirectorMotion(stopped, 8, [actor]).camera!.position.z;
      expect(late).toBeCloseTo(8 - DIRECTOR_CAMERA_RIG_DEFAULTS.follow.distance, 2);
    });

    it('places a close-up in front of the face at its own distance', () => {
      const sampled = sampleDirectorMotion(project([rig({ kind: 'closeup', ...DIRECTOR_CAMERA_RIG_DEFAULTS.closeup, damping: 0 })]), 4, [actor]);
      expect(sampled.camera?.position.z).toBeCloseTo(4 + DIRECTOR_CAMERA_RIG_DEFAULTS.closeup.distance);
      expect(sampled.camera?.target.y).toBeCloseTo(1.6);
    });

    it('drops rigs without a subject and clamps parameters when loading', () => {
      const loaded = normalizeDirectorMotionProject({ durationSeconds: 8, cameraRigs: [
        { id: 'a', kind: 'closeup', targetId: 'actor', start: 7.9, end: 99, distance: -3, fov: 500, damping: 2 },
        { id: 'b', kind: 'follow' },
      ] });
      expect(loaded.cameraRigs).toHaveLength(1);
      expect(loaded.cameraRigs[0]).toMatchObject({ kind: 'closeup', start: 7.8, end: 8, distance: 0.3, fov: 120, damping: 0.95, bodyPart: 'head' });
    });
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
