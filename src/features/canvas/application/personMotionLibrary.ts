import type { BlueprintActionPose, BlueprintHandPose, BlueprintPoseRotation } from '@/features/canvas/domain/canvasNodes';
import {
  PERSON_HAND_SHAPES,
  PERSON_JOINTS,
  normalizePersonPose,
  type PersonPoseJoint,
} from '@/features/canvas/domain/personPose';

/**
 * Built-in person poses and procedural actions in the anatomical pose
 * convention of `BlueprintActionPose`. Authored in degrees for readability.
 */

type DegreePose = Partial<Record<PersonPoseJoint, BlueprintPoseRotation>> & {
  leftFingers?: BlueprintHandPose;
  rightFingers?: BlueprintHandPose;
  scaleY?: number;
  groupY?: number;
  /** Degrees. */
  groupRotX?: number;
  /** Degrees. */
  groupRotZ?: number;
};

const RAD = Math.PI / 180;

/** Degrees → radians for joint channels and whole-body rotations. */
export function personPoseFromDegrees(pose: DegreePose): BlueprintActionPose {
  const result: BlueprintActionPose = {};
  for (const spec of PERSON_JOINTS) {
    const source = pose[spec.key];
    if (!source) continue;
    const joint: BlueprintPoseRotation = {};
    for (const axis of spec.axes) {
      const value = source[axis];
      if (typeof value === 'number' && value !== 0) joint[axis] = value * RAD;
    }
    if (Object.keys(joint).length > 0) (result as Record<string, unknown>)[spec.key] = joint;
  }
  if (pose.leftFingers) result.leftFingers = { ...pose.leftFingers };
  if (pose.rightFingers) result.rightFingers = { ...pose.rightFingers };
  if (pose.scaleY !== undefined) result.scaleY = pose.scaleY;
  if (pose.groupY !== undefined) result.groupY = pose.groupY;
  if (pose.groupRotX !== undefined) result.groupRotX = pose.groupRotX * RAD;
  if (pose.groupRotZ !== undefined) result.groupRotZ = pose.groupRotZ * RAD;
  return result;
}

const both = (joint: 'Clavicle' | 'UpperArm' | 'Forearm' | 'Wrist' | 'Thigh' | 'Shin' | 'Foot' | 'Toes', value: BlueprintPoseRotation) => ({
  [`left${joint}`]: value,
  [`right${joint}`]: value,
}) as DegreePose;

const hands = (shape: BlueprintHandPose) => ({ leftFingers: shape, rightFingers: shape });
const { fist, open, point, grip, relaxed } = PERSON_HAND_SHAPES;

export type PersonPoseCategory = 'stand' | 'gesture' | 'sit' | 'ground' | 'move' | 'action' | 'look';

export interface PersonPoseDefinition {
  id: string;
  category: PersonPoseCategory;
  labelKey: string;
  pose: BlueprintActionPose;
}

const definePose = (id: string, category: PersonPoseCategory, labelKey: string, pose: DegreePose): PersonPoseDefinition => ({
  id,
  category,
  labelKey: `directorStudio.motion.poses.${labelKey}`,
  pose: personPoseFromDegrees(pose),
});

export const PERSON_POSES: readonly PersonPoseDefinition[] = [
  // Standing
  definePose('stand-neutral', 'stand', 'standNeutral', {}),
  definePose('stand-attention', 'stand', 'standAttention', { ...both('UpperArm', { z: -6 }), ...both('Forearm', { x: 4 }), ...hands({ curl: 0.15, index: 0.1, thumb: 0.1, spread: 0 }) }),
  definePose('stand-relaxed', 'stand', 'standRelaxed', {
    spine: { z: -3 }, chest: { z: 2 }, head: { z: 3, y: 4 },
    leftThigh: { x: 6, z: 6, y: 8 }, leftShin: { x: 12 }, leftFoot: { y: 10, x: 4 },
    rightThigh: { z: -2 }, leftUpperArm: { x: 4 }, leftForearm: { x: 14 }, rightForearm: { x: 8 },
  }),
  definePose('hands-on-hips', 'stand', 'handsOnHips', { ...both('UpperArm', { x: -12, z: 42, y: 70 }), ...both('Forearm', { x: 100 }), ...both('Wrist', { x: -25 }), ...hands(grip) }),
  definePose('arms-crossed', 'stand', 'armsCrossed', {
    leftUpperArm: { x: 28, z: 12, y: 40 }, rightUpperArm: { x: 32, z: 10, y: 45 },
    leftForearm: { x: 112 }, rightForearm: { x: 105 },
    ...hands(grip), chest: { x: -3 }, head: { x: -2 },
  }),
  definePose('hands-behind-back', 'stand', 'handsBehindBack', { ...both('UpperArm', { x: -28, z: 6, y: -35 }), ...both('Forearm', { x: 70 }), ...hands(relaxed), chest: { x: -4 } }),
  definePose('hands-in-pockets', 'stand', 'handsInPockets', { ...both('UpperArm', { x: -8, z: 4, y: 10 }), ...both('Forearm', { x: 32 }), ...both('Wrist', { x: 25, z: -10 }), ...hands(fist), ...both('Clavicle', { x: 6 }) }),
  definePose('thinking', 'stand', 'thinking', {
    rightUpperArm: { x: 35, z: 10, y: 20 }, rightForearm: { x: 135 }, rightWrist: { x: -35 }, rightFingers: { curl: 0.7, index: 0.3, thumb: 0.4, spread: 0 },
    leftUpperArm: { x: 18, y: 55, z: 8 }, leftForearm: { x: 95 }, leftFingers: grip,
    head: { x: 10, z: -6 },
  }),
  definePose('shrug', 'stand', 'shrug', { ...both('Clavicle', { x: 25 }), ...both('UpperArm', { x: 10, z: 22, y: -40 }), ...both('Forearm', { x: 85 }), ...both('Wrist', { y: -40 }), ...hands(open), head: { z: 8 } }),
  definePose('cheer', 'stand', 'cheer', { ...both('UpperArm', { x: 20, z: 155 }), ...both('Forearm', { x: 12 }), ...hands(fist), head: { x: -18 }, chest: { x: -6 } }),
  definePose('hands-on-head', 'stand', 'handsOnHead', { ...both('UpperArm', { x: 20, z: 128, y: 30 }), ...both('Forearm', { x: 130 }), ...hands(open), head: { x: 5 } }),

  // Gestures
  definePose('point-forward', 'gesture', 'pointForward', { rightUpperArm: { x: 88, z: 4 }, rightForearm: { x: 6 }, rightFingers: point, head: { y: -4 } }),
  definePose('reach-up', 'gesture', 'reachUp', { rightUpperArm: { x: 160, z: 12 }, rightForearm: { x: 8 }, rightFingers: open, head: { x: -22 }, chest: { x: -6 }, rightClavicle: { x: 15 } }),
  definePose('reach-forward', 'gesture', 'reachForward', { ...both('UpperArm', { x: 80, z: 6 }), ...both('Forearm', { x: 10 }), ...hands(open), spine: { x: 12 } }),
  definePose('wave', 'gesture', 'wave', { rightUpperArm: { x: 25, z: 95 }, rightForearm: { x: 70 }, rightWrist: { y: -20 }, rightFingers: open, head: { z: -4 } }),
  definePose('talk-gesture', 'gesture', 'talkGesture', {
    rightUpperArm: { x: 22, z: 12, y: -10 }, rightForearm: { x: 85 }, rightWrist: { y: -55 }, rightFingers: open,
    leftUpperArm: { x: 8 }, leftForearm: { x: 30 }, head: { y: 10, z: 3 },
  }),
  definePose('phone-call', 'gesture', 'phoneCall', { rightUpperArm: { x: 28, z: 30, y: 30 }, rightForearm: { x: 145 }, rightWrist: { x: -15 }, rightFingers: grip, head: { z: 8, y: -6 } }),
  definePose('salute', 'gesture', 'salute', { rightUpperArm: { x: 40, z: 75, y: 30 }, rightForearm: { x: 135 }, rightWrist: { z: 15 }, rightFingers: { curl: 0, index: 0, thumb: 0.5, spread: 0 } }),
  definePose('pray', 'gesture', 'pray', { ...both('UpperArm', { x: 25, z: 10, y: 45 }), ...both('Forearm', { x: 115 }), ...both('Wrist', { x: -50 }), ...hands({ curl: 0, index: 0, thumb: 0.2, spread: 0 }), head: { x: 18 } }),
  definePose('hold-object', 'gesture', 'holdObject', { ...both('UpperArm', { x: 25, z: 6, y: 25 }), ...both('Forearm', { x: 75 }), ...hands(grip), head: { x: 15 } }),
  definePose('observe', 'gesture', 'observe', { rightUpperArm: { x: 70, z: 45, y: 40 }, rightForearm: { x: 120 }, rightWrist: { x: -30 }, rightFingers: { curl: 0, index: 0, thumb: 0.2, spread: 0 }, head: { x: -6 } }),

  // Sitting and ground
  definePose('sit-upright', 'sit', 'sitUpright', { ...both('Thigh', { x: 90, z: 4 }), ...both('Shin', { x: 90 }), ...both('UpperArm', { x: 15 }), ...both('Forearm', { x: 65 }), ...hands(relaxed) }),
  definePose('sit-relaxed', 'sit', 'sitRelaxed', {
    spine: { x: -10 }, chest: { x: -5 }, leftThigh: { x: 82, z: 8 }, rightThigh: { x: 72, z: 2 },
    leftShin: { x: 70 }, rightShin: { x: 48 }, ...both('UpperArm', { x: 10, z: 10 }), ...both('Forearm', { x: 50 }),
  }),
  definePose('sit-forward', 'sit', 'sitForward', { spine: { x: 28 }, chest: { x: 10 }, head: { x: -20 }, ...both('Thigh', { x: 92, z: 8 }), ...both('Shin', { x: 100 }), ...both('UpperArm', { x: 50, z: 10, y: 30 }), ...both('Forearm', { x: 90 }), ...hands(grip) }),
  definePose('sit-cross-legged', 'sit', 'sitCrossLegged', {
    ...both('Thigh', { x: 75, z: 52, y: -40 }), ...both('Shin', { x: 145 }), ...both('Foot', { z: 20 }),
    ...both('UpperArm', { x: 20, z: 12 }), ...both('Forearm', { x: 45 }), spine: { x: 6 },
  }),
  definePose('sit-floor-knees-up', 'sit', 'sitKneesUp', { ...both('Thigh', { x: 120, z: 8 }), ...both('Shin', { x: 120 }), ...both('UpperArm', { x: 50, y: 30 }), ...both('Forearm', { x: 70 }), ...hands(grip), spine: { x: -10 } }),
  definePose('squat-low', 'ground', 'squatLow', { ...both('Thigh', { x: 120, z: 18 }), ...both('Shin', { x: 140 }), ...both('Foot', { x: -20 }), spine: { x: 28 }, ...both('UpperArm', { x: 45 }), ...both('Forearm', { x: 30 }) }),
  definePose('kneel-one', 'ground', 'kneelOne', { leftThigh: { x: 90, z: 6 }, leftShin: { x: 90 }, rightThigh: { x: -5 }, rightShin: { x: 95 }, rightFoot: { x: -45 }, rightToes: { x: 50 }, leftUpperArm: { x: 30 }, leftForearm: { x: 70 } }),
  definePose('kneel-two', 'ground', 'kneelTwo', { ...both('Thigh', { x: -2 }), ...both('Shin', { x: 95 }), ...both('Foot', { x: 40 }), ...both('UpperArm', { x: 8 }), ...both('Forearm', { x: 20 }) }),
  definePose('crouch-hide', 'ground', 'crouchHide', { ...both('Thigh', { x: 115, z: 12 }), ...both('Shin', { x: 135 }), spine: { x: 40 }, chest: { x: 10 }, head: { x: -30 }, ...both('UpperArm', { x: 60, y: 30 }), ...both('Forearm', { x: 95 }), ...hands(fist) }),
  definePose('lie-back', 'ground', 'lieBack', { groupRotX: -90, ...both('UpperArm', { z: 15 }), ...both('Thigh', { z: 4 }) }),
  definePose('lie-side', 'ground', 'lieSide', { groupRotZ: 90, leftThigh: { x: 35 }, leftShin: { x: 50 }, rightThigh: { x: 20 }, rightShin: { x: 35 }, rightUpperArm: { x: 75 }, rightForearm: { x: 60 }, leftUpperArm: { x: 30 }, leftForearm: { x: 60 } }),
  definePose('lie-front', 'ground', 'lieFront', { groupRotX: 90, ...both('UpperArm', { x: 160, z: 20 }), ...both('Forearm', { x: 70 }), head: { x: -30 } }),
  definePose('crawl', 'ground', 'crawl', { groupRotX: 75, ...both('Thigh', { x: 75 }), ...both('Shin', { x: 85 }), ...both('UpperArm', { x: 85 }), head: { x: -45 } }),

  // Movement
  definePose('walk-stride', 'move', 'walkStride', { leftThigh: { x: 24 }, rightThigh: { x: -16 }, leftShin: { x: 6 }, rightShin: { x: 18 }, rightFoot: { x: 12 }, leftFoot: { x: -8 }, rightUpperArm: { x: 20 }, leftUpperArm: { x: -18 }, ...both('Forearm', { x: 18 }), chest: { y: -6 } }),
  definePose('run-stride', 'move', 'runStride', {
    leftThigh: { x: 62 }, leftShin: { x: 85 }, rightThigh: { x: -22 }, rightShin: { x: 30 }, rightFoot: { x: 20 },
    rightUpperArm: { x: 50 }, leftUpperArm: { x: -40 }, ...both('Forearm', { x: 90 }), ...hands(fist), spine: { x: 14 }, chest: { y: -8 },
  }),
  definePose('jump-apex', 'move', 'jumpApex', { groupY: 0.45, ...both('Thigh', { x: 40 }), ...both('Shin', { x: 70 }), ...both('Foot', { x: 30 }), ...both('UpperArm', { x: 160, z: 15 }), ...both('Forearm', { x: 10 }), ...hands(open) }),
  definePose('fall-back', 'move', 'fallBack', { groupRotX: -30, ...both('UpperArm', { x: 70, z: 40 }), ...both('Forearm', { x: 30 }), ...both('Thigh', { x: 30 }), ...both('Shin', { x: 30 }), head: { x: 25 }, ...hands(open) }),

  // Action / combat
  definePose('fight-stance', 'action', 'fightStance', {
    leftThigh: { x: 22, z: 8 }, leftShin: { x: 25 }, rightThigh: { x: -12, z: 8 }, rightShin: { x: 25 },
    leftUpperArm: { x: 45, z: 15, y: 25 }, leftForearm: { x: 115 }, rightUpperArm: { x: 30, z: 20, y: 30 }, rightForearm: { x: 130 },
    ...hands(fist), spine: { x: 12, y: -15 }, head: { y: 15, x: -8 },
  }),
  definePose('punch', 'action', 'punch', { rightUpperArm: { x: 88, z: 2 }, rightForearm: { x: 4 }, leftUpperArm: { x: 35, z: 20, y: 30 }, leftForearm: { x: 125 }, ...hands(fist), spine: { y: 25, x: 8 }, leftThigh: { x: 22 }, leftShin: { x: 20 }, rightThigh: { x: -15 } }),
  definePose('kick', 'action', 'kick', { rightThigh: { x: 85 }, rightShin: { x: 10 }, rightFoot: { x: 20 }, leftShin: { x: 8 }, spine: { x: -12 }, ...both('UpperArm', { x: 20, z: 35 }), ...both('Forearm', { x: 80 }), ...hands(fist) }),
  definePose('aim-pistol', 'action', 'aimPistol', {
    rightUpperArm: { x: 88, y: 5 }, rightForearm: { x: 3 }, rightFingers: { curl: 0.85, index: 0.45, thumb: 0.6, spread: 0 },
    leftUpperArm: { x: 80, y: 30, z: -8 }, leftForearm: { x: 28 }, leftFingers: grip, head: { x: 4, y: -6 },
    leftThigh: { x: 12 }, leftShin: { x: 12 },
  }),
  definePose('push', 'action', 'push', { ...both('UpperArm', { x: 75, z: 8 }), ...both('Forearm', { x: 25 }), ...both('Wrist', { x: -60 }), ...hands(open), spine: { x: 22 }, leftThigh: { x: 30 }, leftShin: { x: 25 }, rightThigh: { x: -25 }, rightFoot: { x: 25 } }),
  definePose('pull', 'action', 'pull', { ...both('UpperArm', { x: 45, z: 6 }), ...both('Forearm', { x: 85 }), ...hands(fist), spine: { x: -15 }, leftThigh: { x: 25 }, leftShin: { x: 35 } }),
  definePose('carry-box', 'action', 'carryBox', { ...both('UpperArm', { x: 30, z: 20, y: 35 }), ...both('Forearm', { x: 75 }), ...both('Wrist', { y: -60 }), ...hands(grip), spine: { x: -6 } }),
  definePose('pick-up', 'action', 'pickUp', { spine: { x: 55 }, chest: { x: 15 }, ...both('Thigh', { x: 40 }), ...both('Shin', { x: 55 }), ...both('UpperArm', { x: 50 }), ...both('Forearm', { x: 10 }), ...hands(grip), head: { x: -20 } }),
  definePose('bow', 'action', 'bow', { spine: { x: 40 }, chest: { x: 8 }, head: { x: 10 }, ...both('UpperArm', { x: 10 }) }),

  // Looking
  definePose('look-up', 'look', 'lookUp', { head: { x: -30 }, neck: { x: -12 } }),
  definePose('look-down', 'look', 'lookDown', { head: { x: 28 }, neck: { x: 12 } }),
  definePose('look-left', 'look', 'lookLeft', { head: { y: 45 }, neck: { y: 15 }, chest: { y: 8 } }),
  definePose('look-right', 'look', 'lookRight', { head: { y: -45 }, neck: { y: -15 }, chest: { y: -8 } }),
  definePose('look-back', 'look', 'lookBack', { head: { y: 60 }, neck: { y: 30 }, chest: { y: 30 }, spine: { y: 20 } }),
];

export const PERSON_POSE_MAP: Readonly<Record<string, BlueprintActionPose>> = Object.fromEntries(
  PERSON_POSES.map((definition) => [definition.id, definition.pose]),
);

export type PersonActionCategory = 'locomotion' | 'gesture' | 'body' | 'action';

export interface PersonActionDefinition {
  id: string;
  category: PersonActionCategory;
  labelKey: string;
  /** Seconds per cycle (looping) or total duration (one-shot). */
  durationSeconds: number;
  /** One-shot actions play once and hold their final pose. */
  oneShot?: boolean;
  /** Characteristic travel speed in m/s for locomotion, used to size routes. */
  travelSpeed?: number;
}

const defineAction = (
  id: string,
  category: PersonActionCategory,
  labelKey: string,
  durationSeconds: number,
  extra: Pick<PersonActionDefinition, 'oneShot' | 'travelSpeed'> = {},
): PersonActionDefinition => ({ id, category, labelKey: `directorStudio.motion.actions.${labelKey}`, durationSeconds, ...extra });

export const PERSON_ACTIONS: readonly PersonActionDefinition[] = [
  defineAction('walk', 'locomotion', 'walk', 1.1, { travelSpeed: 1.35 }),
  defineAction('run', 'locomotion', 'run', 0.7, { travelSpeed: 4 }),
  defineAction('sneak', 'locomotion', 'sneak', 1.6, { travelSpeed: 0.6 }),
  defineAction('walk-back', 'locomotion', 'walkBack', 1.2, { travelSpeed: 0.9 }),
  defineAction('side-step', 'locomotion', 'sideStep', 1.3, { travelSpeed: 0.7 }),
  defineAction('idle-breath', 'body', 'idleBreath', 3.2),
  defineAction('turn-look', 'body', 'turnLook', 2.4),
  defineAction('talk', 'gesture', 'talk', 2.2),
  defineAction('wave', 'gesture', 'wave', 1.2),
  defineAction('clap', 'gesture', 'clap', 0.6),
  defineAction('phone', 'gesture', 'phone', 3),
  defineAction('nod', 'gesture', 'nod', 1),
  defineAction('shake-head', 'gesture', 'shakeHead', 1),
  defineAction('typing', 'gesture', 'typing', 0.5),
  defineAction('bow', 'body', 'bow', 2.4, { oneShot: true }),
  defineAction('squat-rise', 'body', 'squatRise', 2),
  defineAction('sit-down', 'body', 'sitDown', 1.4, { oneShot: true }),
  defineAction('stand-up', 'body', 'standUp', 1.4, { oneShot: true }),
  defineAction('pick-up', 'body', 'pickUp', 2, { oneShot: true }),
  defineAction('step-over', 'locomotion', 'stepOver', 1.5),
  defineAction('jump', 'action', 'jump', 1.1),
  defineAction('punch', 'action', 'punch', 0.8),
  defineAction('kick', 'action', 'kick', 1.1),
  defineAction('fall-down', 'action', 'fallDown', 1.6, { oneShot: true }),
];

export const PERSON_ACTION_MAP: Readonly<Record<string, PersonActionDefinition>> = Object.fromEntries(
  PERSON_ACTIONS.map((definition) => [definition.id, definition]),
);

const TAU = Math.PI * 2;
const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const pos = (value: number) => Math.max(0, value);

function blendDegreePoses(from: DegreePose, to: DegreePose, amount: number): DegreePose {
  const result: DegreePose = {};
  const t = smooth(amount);
  for (const spec of PERSON_JOINTS) {
    const a = from[spec.key];
    const b = to[spec.key];
    if (!a && !b) continue;
    result[spec.key] = {
      x: mix(a?.x ?? 0, b?.x ?? 0, t),
      y: mix(a?.y ?? 0, b?.y ?? 0, t),
      z: mix(a?.z ?? 0, b?.z ?? 0, t),
    };
  }
  for (const key of ['scaleY', 'groupY', 'groupRotX', 'groupRotZ'] as const) {
    if (from[key] === undefined && to[key] === undefined) continue;
    result[key] = mix(from[key] ?? (key === 'scaleY' ? 1 : 0), to[key] ?? (key === 'scaleY' ? 1 : 0), t);
  }
  const hand = (a?: BlueprintHandPose, b?: BlueprintHandPose) => (a || b ? {
    curl: mix(a?.curl ?? 0.3, b?.curl ?? 0.3, t),
    index: mix(a?.index ?? a?.curl ?? 0.25, b?.index ?? b?.curl ?? 0.25, t),
    thumb: mix(a?.thumb ?? 0.2, b?.thumb ?? 0.2, t),
    spread: mix(a?.spread ?? 0.1, b?.spread ?? 0.1, t),
  } : undefined);
  const left = hand(from.leftFingers, to.leftFingers);
  const right = hand(from.rightFingers, to.rightFingers);
  if (left) result.leftFingers = left;
  if (right) result.rightFingers = right;
  return result;
}

const SIT: DegreePose = { ...both('Thigh', { x: 90, z: 4 }), ...both('Shin', { x: 90 }), ...both('UpperArm', { x: 15 }), ...both('Forearm', { x: 65 }) };
const SIT_TRANSITION: DegreePose = { spine: { x: 38 }, ...both('Thigh', { x: 70, z: 4 }), ...both('Shin', { x: 85 }), ...both('UpperArm', { x: 35 }), ...both('Forearm', { x: 40 }) };

function sampleActionDegrees(id: string, phase: number): DegreePose {
  const w = Math.sin(phase * TAU);
  const c = Math.cos(phase * TAU);
  const lift = Math.sin(phase * Math.PI);
  switch (id) {
    case 'walk': {
      // Left leg forward at w = 1; the knee flexes while the leg swings forward.
      const leftSwing = pos(c);
      const rightSwing = pos(-c);
      return {
        leftThigh: { x: 24 * w }, rightThigh: { x: -24 * w },
        leftShin: { x: 6 + 52 * leftSwing ** 1.6 }, rightShin: { x: 6 + 52 * rightSwing ** 1.6 },
        leftFoot: { x: w > 0 ? -12 * w : 16 * -w * pos(-c) }, rightFoot: { x: w < 0 ? 12 * w : 16 * w * pos(c) },
        leftUpperArm: { x: -18 * w, z: 2 }, rightUpperArm: { x: 18 * w, z: 2 },
        leftForearm: { x: 16 + 14 * pos(-w) }, rightForearm: { x: 16 + 14 * pos(w) },
        spine: { y: 5 * w, x: 3 }, chest: { y: -8 * w }, head: { y: 3 * w },
      };
    }
    case 'run': {
      const leftSwing = pos(c);
      const rightSwing = pos(-c);
      const thigh = (v: number) => (v > 0 ? 58 * v : 26 * v);
      return {
        leftThigh: { x: thigh(w) }, rightThigh: { x: thigh(-w) },
        leftShin: { x: 22 + 95 * leftSwing ** 1.3 }, rightShin: { x: 22 + 95 * rightSwing ** 1.3 },
        leftFoot: { x: 10 + 18 * pos(-w) }, rightFoot: { x: 10 + 18 * pos(w) },
        leftUpperArm: { x: -45 * w, z: 6 }, rightUpperArm: { x: 45 * w, z: 6 },
        ...both('Forearm', { x: 88 }), ...hands(fist),
        spine: { x: 12, y: 7 * w }, chest: { y: -12 * w }, head: { x: -8 },
        groupY: 0.05 * pos(Math.sin(phase * TAU * 2 - 0.9)),
      };
    }
    case 'sneak': {
      const leftSwing = pos(c);
      const rightSwing = pos(-c);
      return {
        leftThigh: { x: 50 + 22 * w }, rightThigh: { x: 50 - 22 * w },
        leftShin: { x: 70 + 30 * leftSwing }, rightShin: { x: 70 + 30 * rightSwing },
        ...both('Foot', { x: -18 }),
        spine: { x: 30 }, chest: { x: 8 }, head: { x: -26 },
        ...both('UpperArm', { x: 35, z: 18 }), ...both('Forearm', { x: 70 }), ...hands(relaxed),
      };
    }
    case 'walk-back':
      return {
        leftThigh: { x: -20 * w }, rightThigh: { x: 20 * w },
        leftShin: { x: 8 + 40 * pos(-c) ** 1.5 }, rightShin: { x: 8 + 40 * pos(c) ** 1.5 },
        leftUpperArm: { x: 14 * w }, rightUpperArm: { x: -14 * w }, ...both('Forearm', { x: 20 }),
        spine: { x: -4 },
      };
    case 'side-step':
      return {
        leftThigh: { z: 4 + 14 * pos(w), x: 6 }, rightThigh: { z: 4 + 14 * pos(-w), x: 6 },
        leftShin: { x: 12 + 22 * pos(c) }, rightShin: { x: 12 + 22 * pos(-c) },
        ...both('UpperArm', { z: 10, x: 15 }), ...both('Forearm', { x: 40 }),
      };
    case 'idle-breath':
      return {
        chest: { x: -1.5 * w }, ...both('Clavicle', { x: 2 + 2 * w }), head: { x: 1.5 * w, y: 2 * Math.sin(phase * Math.PI) },
        ...both('UpperArm', { z: 1 + w }), ...both('Forearm', { x: 8 }), scaleY: 1 + 0.004 * w,
      };
    case 'turn-look':
      return { head: { y: 50 * w }, neck: { y: 15 * w }, chest: { y: 12 * w }, spine: { y: 6 * w } };
    case 'talk': {
      const beat = Math.sin(phase * TAU * 2);
      return {
        rightUpperArm: { x: 18 + 8 * w, z: 12 }, rightForearm: { x: 80 + 15 * beat }, rightWrist: { y: -50 + 15 * c }, rightFingers: open,
        leftUpperArm: { x: 10 + 6 * c, z: 6 }, leftForearm: { x: 55 + 12 * Math.sin(phase * TAU + 1.3) }, leftWrist: { y: -30 },
        head: { y: 8 * Math.sin(phase * TAU * 0.5), x: 4 * beat }, chest: { y: 4 * w },
      };
    }
    case 'wave':
      return {
        rightUpperArm: { x: 20, z: 100 }, rightForearm: { x: 55 + 25 * w }, rightWrist: { z: 15 * w, y: -15 }, rightFingers: open,
        rightClavicle: { x: 10 }, head: { z: -5, y: 6 },
      };
    case 'clap': {
      const close = pos(Math.sin(phase * TAU));
      return {
        ...both('UpperArm', { x: 48, y: 40, z: 22 - 18 * close }), ...both('Forearm', { x: 80 - 10 * close }),
        ...both('Wrist', { x: -35 }), ...hands(open),
      };
    }
    case 'phone':
      return {
        rightUpperArm: { x: 28, z: 30, y: 30 }, rightForearm: { x: 145 }, rightFingers: grip,
        head: { z: 8 + 2 * w, y: -6 + 10 * Math.sin(phase * Math.PI) }, leftUpperArm: { x: 6 }, leftForearm: { x: 25 + 10 * pos(w) },
      };
    case 'nod':
      return { head: { x: 14 * pos(w) - 4 * pos(-w) }, neck: { x: 6 * w } };
    case 'shake-head':
      return { head: { y: 26 * w }, neck: { y: 8 * w } };
    case 'typing': {
      const tap = (offset: number) => 6 * pos(Math.sin(phase * TAU + offset));
      return {
        ...SIT, ...both('UpperArm', { x: 30, z: 8, y: 20 }), leftForearm: { x: 80 + tap(0) }, rightForearm: { x: 80 + tap(Math.PI) },
        ...both('Wrist', { x: -15 }), ...hands({ curl: 0.45, index: 0.4, thumb: 0.3, spread: 0.2 }), head: { x: 12 }, spine: { x: 10 },
      };
    }
    case 'bow': {
      const bend = Math.sin(Math.min(1, phase) * Math.PI) ** 2;
      return { spine: { x: 45 * bend }, chest: { x: 10 * bend }, head: { x: 10 * bend }, ...both('UpperArm', { x: 8 * bend }) };
    }
    case 'squat-rise': {
      const bend = (1 - c) / 2;
      return {
        ...both('Thigh', { x: 115 * bend, z: 14 * bend }), ...both('Shin', { x: 135 * bend }), ...both('Foot', { x: -18 * bend }),
        spine: { x: 30 * bend }, ...both('UpperArm', { x: 60 * bend }), ...both('Forearm', { x: 20 * bend }),
      };
    }
    case 'sit-down':
      return phase < 0.55 ? blendDegreePoses({}, SIT_TRANSITION, phase / 0.55) : blendDegreePoses(SIT_TRANSITION, SIT, (phase - 0.55) / 0.45);
    case 'stand-up':
      return phase < 0.45 ? blendDegreePoses(SIT, SIT_TRANSITION, phase / 0.45) : blendDegreePoses(SIT_TRANSITION, {}, (phase - 0.45) / 0.55);
    case 'pick-up': {
      const down = phase < 0.5 ? smooth(phase / 0.45) : 1 - smooth((phase - 0.55) / 0.45);
      const holding = phase > 0.45;
      return {
        spine: { x: 55 * down }, chest: { x: 15 * down }, head: { x: -15 * down },
        ...both('Thigh', { x: 50 * down }), ...both('Shin', { x: 70 * down }),
        rightUpperArm: { x: 55 * down + (holding ? 15 * (1 - down) : 0) }, rightForearm: { x: 10 + (holding ? 60 * (1 - down) : 0) },
        rightFingers: holding ? grip : open, leftUpperArm: { x: 25 * down }, leftForearm: { x: 20 },
      };
    }
    case 'step-over':
      return {
        leftThigh: { x: 85 * lift }, leftShin: { x: 95 * lift }, leftFoot: { x: -15 * lift },
        rightThigh: { x: phase > 0.5 ? 45 * (1 - lift) : 0 }, rightShin: { x: phase > 0.5 ? 60 * (1 - lift) : 0 },
        ...both('UpperArm', { z: 25 * lift }), spine: { x: 8 * lift },
      };
    case 'jump': {
      // 0–0.3 crouch, 0.3–0.75 airborne, 0.75–1 land.
      const crouch = phase < 0.3 ? Math.sin((phase / 0.3) * Math.PI) : phase > 0.75 ? Math.sin(((phase - 0.75) / 0.25) * Math.PI) * 0.8 : 0;
      const air = phase >= 0.3 && phase <= 0.75 ? Math.sin(((phase - 0.3) / 0.45) * Math.PI) : 0;
      return {
        ...both('Thigh', { x: 70 * crouch + 30 * air }), ...both('Shin', { x: 95 * crouch + 50 * air }), ...both('Foot', { x: -20 * crouch + 35 * air }),
        spine: { x: 25 * crouch }, ...both('UpperArm', { x: -35 * crouch + 150 * air, z: 10 * air }), ...both('Forearm', { x: 15 }),
        groupY: 0.5 * air,
      };
    }
    case 'punch': {
      const hit = Math.sin(Math.min(1, phase / 0.6) * Math.PI);
      return {
        leftThigh: { x: 22 }, leftShin: { x: 22 }, rightThigh: { x: -14 }, rightShin: { x: 20 },
        leftUpperArm: { x: 45, z: 15, y: 25 }, leftForearm: { x: 115 },
        rightUpperArm: { x: 30 + 58 * hit, z: 20 - 18 * hit, y: 30 - 28 * hit }, rightForearm: { x: 130 - 126 * hit },
        ...hands(fist), spine: { x: 10, y: -15 + 40 * hit }, head: { y: 15 - 15 * hit },
      };
    }
    case 'kick': {
      const k = Math.sin(Math.min(1, phase / 0.7) * Math.PI);
      const chamber = Math.min(1, k * 1.6);
      return {
        rightThigh: { x: 90 * k }, rightShin: { x: 110 * chamber * (1 - k) + 10 }, rightFoot: { x: 25 * k },
        leftShin: { x: 12 }, spine: { x: -15 * k }, ...both('UpperArm', { x: 20, z: 35 }), ...both('Forearm', { x: 85 }), ...hands(fist),
      };
    }
    case 'fall-down': {
      const t = smooth(phase / 0.75);
      return {
        groupRotX: -90 * t, ...both('UpperArm', { x: 70 * (1 - t) + 10 * t, z: 40 * (1 - t) + 20 * t }), ...both('Forearm', { x: 40 * (1 - t) }),
        ...both('Thigh', { x: 35 * Math.sin(t * Math.PI) }), ...both('Shin', { x: 50 * Math.sin(t * Math.PI) }), head: { x: 25 * (1 - t) }, ...hands(open),
      };
    }
    default:
      return {};
  }
}

/** Pose of a built-in action `seconds` after it started. */
export function samplePersonAction(actionId: string, seconds: number): BlueprintActionPose {
  const definition = PERSON_ACTION_MAP[actionId];
  if (!definition) return {};
  const duration = definition.durationSeconds;
  const phase = definition.oneShot
    ? Math.min(1, Math.max(0, seconds / duration))
    : (((seconds % duration) + duration) % duration) / duration;
  return personPoseFromDegrees(sampleActionDegrees(actionId, phase));
}

const LEGACY_ACTION_ALIASES: ReadonlyArray<[RegExp, string]> = [
  [/半蹲|inspect/i, 'squat-low'],
  [/盘腿/, 'sit-cross-legged'],
  [/坐|sit/i, 'sit-upright'],
  [/跪/, 'kneel-one'],
  [/蹲|squat|crouch/i, 'squat-low'],
  [/趴/, 'lie-front'],
  [/躺|lying|\blie\b/i, 'lie-back'],
  [/跳|jump/i, 'jump-apex'],
  [/跑|run/i, 'run-stride'],
  [/走|walk/i, 'walk-stride'],
  [/回头|look back|turn around/i, 'look-back'],
  [/指|point/i, 'point-forward'],
  [/伸手|reach|hand out/i, 'reach-forward'],
  [/挥手|wave/i, 'wave'],
  [/打电话|phone/i, 'phone-call'],
  [/对话|说话|talk|chat|speak/i, 'talk-gesture'],
  [/观察|眺望|observe/i, 'observe'],
  [/抱臂|双臂交叉|cross/i, 'arms-crossed'],
  [/叉腰/, 'hands-on-hips'],
  [/思考|think/i, 'thinking'],
  [/鞠躬|bow/i, 'bow'],
  [/举手|欢呼|cheer/i, 'cheer'],
  [/看|look/i, 'look-left'],
];

/**
 * Static pose for a person's `action` label: a built-in pose id, a saved
 * custom pose name, or legacy free text resolved by keyword.
 */
export function resolvePersonActionPose(
  action: string | undefined,
  customPoses?: Record<string, BlueprintActionPose>,
): BlueprintActionPose | undefined {
  if (!action) return undefined;
  const custom = customPoses?.[action];
  if (custom) return normalizePersonPose(custom);
  const builtIn = PERSON_POSE_MAP[action];
  if (builtIn) return builtIn;
  const alias = LEGACY_ACTION_ALIASES.find(([pattern]) => pattern.test(action));
  return alias ? PERSON_POSE_MAP[alias[1]] : undefined;
}
