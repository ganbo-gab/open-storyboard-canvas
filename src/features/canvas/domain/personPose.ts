import type {
  BlueprintActionPose,
  BlueprintHandPose,
  BlueprintPoseHinge,
  BlueprintPoseRotation,
} from './canvasNodes';

/**
 * Shared description of the poseable person rig. The renderer, the motion
 * sampler, the pose editor, stage schemas and the stage agent all read this
 * table, so a joint added here is available everywhere.
 *
 * Values are radians on disk, limits are degrees. Side names are anatomical
 * and lateral values are mirror symmetric (see `BlueprintActionPose`).
 */

export type PersonPoseAxis = 'x' | 'y' | 'z';
export type PersonSide = 'left' | 'right';

export type PersonPoseJoint =
  | 'spine' | 'chest' | 'neck' | 'head'
  | 'leftClavicle' | 'rightClavicle'
  | 'leftUpperArm' | 'rightUpperArm'
  | 'leftForearm' | 'rightForearm'
  | 'leftWrist' | 'rightWrist'
  | 'leftThigh' | 'rightThigh'
  | 'leftShin' | 'rightShin'
  | 'leftFoot' | 'rightFoot'
  | 'leftToes' | 'rightToes';

export type PersonFingersKey = 'leftFingers' | 'rightFingers';
export type PersonFingerField = keyof BlueprintHandPose;
export type PersonBodyRegion = 'core' | 'head' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';
export type PersonLimbEnd = 'leftHand' | 'rightHand' | 'leftFoot' | 'rightFoot';

export interface PersonJointSpec {
  key: PersonPoseJoint;
  region: PersonBodyRegion;
  side: PersonSide | null;
  axes: readonly PersonPoseAxis[];
  /** Degrees, inclusive, per authored axis. */
  limits: Readonly<Partial<Record<PersonPoseAxis, readonly [number, number]>>>;
  mirror: PersonPoseJoint;
}

const XYZ = ['x', 'y', 'z'] as const;
const XY = ['x', 'y'] as const;
const X = ['x'] as const;

function lateral(
  base: 'Clavicle' | 'UpperArm' | 'Forearm' | 'Wrist' | 'Thigh' | 'Shin' | 'Foot' | 'Toes',
  region: 'Arm' | 'Leg',
  axes: readonly PersonPoseAxis[],
  limits: PersonJointSpec['limits'],
): PersonJointSpec[] {
  return (['left', 'right'] as const).map((side) => ({
    key: `${side}${base}` as PersonPoseJoint,
    region: `${side}${region}` as PersonBodyRegion,
    side,
    axes,
    limits,
    mirror: `${side === 'left' ? 'right' : 'left'}${base}` as PersonPoseJoint,
  }));
}

export const PERSON_JOINTS: readonly PersonJointSpec[] = [
  { key: 'spine', region: 'core', side: null, axes: XYZ, limits: { x: [-30, 80], y: [-45, 45], z: [-35, 35] }, mirror: 'spine' },
  { key: 'chest', region: 'core', side: null, axes: XYZ, limits: { x: [-25, 40], y: [-40, 40], z: [-25, 25] }, mirror: 'chest' },
  { key: 'neck', region: 'head', side: null, axes: XYZ, limits: { x: [-40, 45], y: [-50, 50], z: [-30, 30] }, mirror: 'neck' },
  { key: 'head', region: 'head', side: null, axes: XYZ, limits: { x: [-40, 40], y: [-60, 60], z: [-30, 30] }, mirror: 'head' },
  ...lateral('Clavicle', 'Arm', XY, { x: [-10, 30], y: [-20, 25] }),
  ...lateral('UpperArm', 'Arm', XYZ, { x: [-60, 180], y: [-90, 90], z: [-20, 180] }),
  ...lateral('Forearm', 'Arm', X, { x: [-5, 150] }),
  ...lateral('Wrist', 'Arm', XYZ, { x: [-70, 80], y: [-90, 90], z: [-30, 25] }),
  ...lateral('Thigh', 'Leg', XYZ, { x: [-40, 130], y: [-45, 45], z: [-25, 80] }),
  ...lateral('Shin', 'Leg', X, { x: [0, 155] }),
  ...lateral('Foot', 'Leg', XYZ, { x: [-30, 55], y: [-30, 30], z: [-25, 30] }),
  ...lateral('Toes', 'Leg', X, { x: [-30, 60] }),
];

export const PERSON_JOINT_SPECS: Readonly<Record<PersonPoseJoint, PersonJointSpec>> = Object.fromEntries(
  PERSON_JOINTS.map((spec) => [spec.key, spec]),
) as Record<PersonPoseJoint, PersonJointSpec>;

export const PERSON_JOINT_KEYS: readonly PersonPoseJoint[] = PERSON_JOINTS.map((spec) => spec.key);
export const PERSON_FINGERS_KEYS: readonly PersonFingersKey[] = ['leftFingers', 'rightFingers'];
export const PERSON_FINGER_FIELDS: readonly PersonFingerField[] = ['curl', 'index', 'thumb', 'spread'];

/** Two-bone chains used by drag-to-reach (IK). */
export const PERSON_LIMBS: Readonly<Record<PersonLimbEnd, { root: PersonPoseJoint; hinge: PersonPoseJoint; end: PersonPoseJoint }>> = {
  leftHand: { root: 'leftUpperArm', hinge: 'leftForearm', end: 'leftWrist' },
  rightHand: { root: 'rightUpperArm', hinge: 'rightForearm', end: 'rightWrist' },
  leftFoot: { root: 'leftThigh', hinge: 'leftShin', end: 'leftFoot' },
  rightFoot: { root: 'rightThigh', hinge: 'rightShin', end: 'rightFoot' },
};

/** Finger shape used when a pose does not mention a hand. */
export const PERSON_REST_FINGERS: Readonly<Required<BlueprintHandPose>> = { curl: 0.3, index: 0.25, thumb: 0.2, spread: 0.1 };

export const PERSON_HAND_SHAPES: Readonly<Record<'relaxed' | 'open' | 'fist' | 'point' | 'grip' | 'pinch', BlueprintHandPose>> = {
  relaxed: { curl: 0.3, index: 0.25, thumb: 0.2, spread: 0.1 },
  open: { curl: 0, index: 0, thumb: 0, spread: 0.7 },
  fist: { curl: 1, index: 1, thumb: 0.9, spread: 0 },
  point: { curl: 1, index: 0, thumb: 0.85, spread: 0 },
  grip: { curl: 0.65, index: 0.65, thumb: 0.55, spread: 0 },
  pinch: { curl: 0.45, index: 0.55, thumb: 0.7, spread: 0 },
};

const DEG = Math.PI / 180;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Clamp one joint channel (radians) to its anatomical range. Unsupported axes become 0. */
export function clampPersonJointValue(joint: PersonPoseJoint, axis: PersonPoseAxis, radians: number): number {
  const range = PERSON_JOINT_SPECS[joint].limits[axis];
  if (!range || !finite(radians)) return 0;
  return Math.min(range[1] * DEG, Math.max(range[0] * DEG, radians));
}

export function readPersonJoint(pose: BlueprintActionPose | undefined, joint: PersonPoseJoint, axis: PersonPoseAxis): number {
  const value = (pose?.[joint] as BlueprintPoseRotation | undefined)?.[axis];
  return finite(value) ? value : 0;
}

/**
 * Copy with one channel set. Zero channels are dropped, but the joint stays
 * (possibly `{}`): an edited joint must keep overriding the layer below.
 * Use `applyPersonPosePatch(pose, { [joint]: null })` to hand it back.
 */
export function writePersonJoint(
  pose: BlueprintActionPose,
  joint: PersonPoseJoint,
  axis: PersonPoseAxis,
  radians: number,
): BlueprintActionPose {
  const current: BlueprintPoseRotation = { ...((pose[joint] as BlueprintPoseRotation | undefined) ?? {}) };
  if (Math.abs(radians) < 1e-4) delete current[axis];
  else current[axis] = radians;
  return { ...pose, [joint]: current };
}

/** Merge a finger patch; `null` restores the resting hand. */
export function writePersonFingers(
  pose: BlueprintActionPose,
  hand: PersonFingersKey,
  patch: BlueprintHandPose | null,
): BlueprintActionPose {
  const next: BlueprintActionPose = { ...pose };
  const merged = patch ? normalizeFingers({ ...(pose[hand] ?? {}), ...patch }) : undefined;
  if (merged) next[hand] = merged;
  else delete next[hand];
  return next;
}

/** An empty object is meaningful: in an overlay it holds that joint at rest over the layer below. */
function normalizeRotation(value: unknown, axes: readonly PersonPoseAxis[]): BlueprintPoseRotation | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const result: BlueprintPoseRotation = {};
  for (const axis of axes) {
    const channel = record[axis];
    if (finite(channel) && channel !== 0) result[axis] = channel;
  }
  return result;
}

function normalizeFingers(value: unknown): BlueprintHandPose | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const result: BlueprintHandPose = {};
  for (const field of PERSON_FINGER_FIELDS) {
    const channel = record[field];
    if (finite(channel)) result[field] = Math.min(1, Math.max(0, channel));
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

const LEGACY_KEYS = ['torso', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee'] as const;

/**
 * Poses saved before the anatomical rig stored raw Euler angles of a stick
 * figure whose `left*` limbs sat on the viewer's left (the figure's right).
 * Convert them so saved projects keep their look: swap sides, then map each
 * raw axis onto the side-relative convention.
 */
function convertLegacyPose(record: Record<string, unknown>): Record<string, unknown> {
  const raw = (key: string) => asRecord(record[key]) ?? {};
  const num = (source: Record<string, unknown>, axis: PersonPoseAxis) => (finite(source[axis]) ? source[axis] as number : 0);
  const converted: Record<string, unknown> = { ...record };
  for (const key of LEGACY_KEYS) delete converted[key];
  const limb = (legacyKey: string, anatomical: 'left' | 'right', target: 'UpperArm' | 'Thigh') => {
    if (!(legacyKey in record)) return;
    const source = raw(legacyKey);
    // Legacy +X limbs are the figure's left side (s = +1).
    const s = anatomical === 'left' ? 1 : -1;
    // An already-authored anatomical joint (including an explicit rest `{}`) wins.
    converted[`${anatomical}${target}`] = asRecord(record[`${anatomical}${target}`])
      ?? { x: -num(source, 'x'), y: -s * num(source, 'y'), z: s * num(source, 'z') };
  };
  limb('leftShoulder', 'right', 'UpperArm');
  limb('rightShoulder', 'left', 'UpperArm');
  limb('leftHip', 'right', 'Thigh');
  limb('rightHip', 'left', 'Thigh');
  // Legacy custom poses were additive over a keyword pose: only joints they stored may override it.
  if ('leftElbow' in record) converted.rightForearm = asRecord(record.rightForearm) ?? { x: -num(raw('leftElbow'), 'x') };
  if ('rightElbow' in record) converted.leftForearm = asRecord(record.leftForearm) ?? { x: -num(raw('rightElbow'), 'x') };
  if ('leftKnee' in record) converted.rightShin = asRecord(record.rightShin) ?? { x: num(raw('leftKnee'), 'x') };
  if ('rightKnee' in record) converted.leftShin = asRecord(record.leftShin) ?? { x: num(raw('rightKnee'), 'x') };
  const torso = num(raw('torso'), 'x');
  if ('torso' in record) converted.spine = asRecord(record.spine) ?? { x: -torso };
  return converted;
}

/**
 * Sanitize an untrusted pose (saved data, AI output): converts legacy keys,
 * drops unknown fields and non-finite numbers, clamps finger values to 0..1.
 * Joint values are not clamped so authored poses keep their exact look.
 */
export function normalizePersonPose(value: unknown): BlueprintActionPose | undefined {
  let record = asRecord(value);
  if (!record) return undefined;
  if (LEGACY_KEYS.some((key) => key in record!)) record = convertLegacyPose(record);
  const pose: BlueprintActionPose = {};
  for (const spec of PERSON_JOINTS) {
    const joint = normalizeRotation(record[spec.key], spec.axes);
    if (joint) (pose as Record<string, unknown>)[spec.key] = joint;
  }
  for (const hand of PERSON_FINGERS_KEYS) {
    const fingers = normalizeFingers(record[hand]);
    if (fingers) pose[hand] = fingers;
  }
  if (finite(record.scaleY) && record.scaleY > 0) pose.scaleY = record.scaleY;
  if (finite(record.groupY)) pose.groupY = record.groupY;
  if (finite(record.groupRotX)) pose.groupRotX = record.groupRotX;
  if (finite(record.groupRotZ)) pose.groupRotZ = record.groupRotZ;
  return pose;
}

export function isEmptyPersonPose(pose: BlueprintActionPose | undefined): boolean {
  return !pose || Object.keys(normalizePersonPose(pose) ?? {}).length === 0;
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function fingerValue(hand: BlueprintHandPose | undefined, field: PersonFingerField): number {
  const value = hand?.[field];
  if (finite(value)) return value;
  if (field === 'index' && finite(hand?.curl)) return hand!.curl!;
  return PERSON_REST_FINGERS[field];
}

/** Channel-wise blend; missing joints blend from/to rest. */
export function interpolatePersonPose(
  from: BlueprintActionPose | undefined,
  to: BlueprintActionPose | undefined,
  amount: number,
): BlueprintActionPose | undefined {
  if (!from && !to) return undefined;
  if (amount <= 0) return from ?? {};
  if (amount >= 1) return to ?? {};
  const start = from ?? {};
  const end = to ?? {};
  const result: BlueprintActionPose = {};
  for (const spec of PERSON_JOINTS) {
    const a = start[spec.key] as BlueprintPoseRotation | undefined;
    const b = end[spec.key] as BlueprintPoseRotation | undefined;
    if (!a && !b) continue;
    const joint: BlueprintPoseRotation = {};
    for (const axis of spec.axes) {
      const value = lerp(finite(a?.[axis]) ? a![axis]! : 0, finite(b?.[axis]) ? b![axis]! : 0, amount);
      if (value !== 0) joint[axis] = value;
    }
    (result as Record<string, unknown>)[spec.key] = joint;
  }
  for (const hand of PERSON_FINGERS_KEYS) {
    if (!start[hand] && !end[hand]) continue;
    const blended: BlueprintHandPose = {};
    for (const field of PERSON_FINGER_FIELDS) {
      blended[field] = lerp(fingerValue(start[hand], field), fingerValue(end[hand], field), amount);
    }
    result[hand] = blended;
  }
  const scalar = (key: 'scaleY' | 'groupY' | 'groupRotX' | 'groupRotZ', rest: number) => {
    if (start[key] === undefined && end[key] === undefined) return;
    result[key] = lerp(start[key] ?? rest, end[key] ?? rest, amount);
  };
  scalar('scaleY', 1);
  scalar('groupY', 0);
  scalar('groupRotX', 0);
  scalar('groupRotZ', 0);
  return result;
}

/**
 * Layer `overlay` on `base`: every joint, hand and whole-body field the
 * overlay mentions replaces the base value (e.g. "look left" on a walk).
 */
export function overlayPersonPose(
  base: BlueprintActionPose | undefined,
  overlay: BlueprintActionPose | undefined,
): BlueprintActionPose | undefined {
  if (!overlay) return base;
  return { ...(base ?? {}), ...overlay };
}

/** Edit to a pose layer: a value replaces that field, `null` removes it (falls back to the layer below). */
export type PersonPosePatch = { [K in keyof BlueprintActionPose]?: BlueprintActionPose[K] | null };

export function applyPersonPosePatch(pose: BlueprintActionPose | undefined, patch: PersonPosePatch): BlueprintActionPose {
  const next: Record<string, unknown> = { ...(pose ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as BlueprintActionPose;
}

/**
 * Patch turning `before` into `after`: changed or added fields carry the new
 * value, removed fields become `null`. `applyPersonPosePatch(before, diff)`
 * reproduces `after`; an empty object means nothing changed.
 */
export function diffPersonPose(before: BlueprintActionPose, after: BlueprintActionPose): PersonPosePatch {
  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const a = (before as Record<string, unknown>)[key];
    const b = (after as Record<string, unknown>)[key];
    if (b === undefined) { if (a !== undefined) patch[key] = null; continue; }
    if (JSON.stringify(a) !== JSON.stringify(b)) patch[key] = b;
  }
  return patch as PersonPosePatch;
}

/** Mirror across the figure's midline: swap sides, negate turns and leans. */
export function mirrorPersonPose(pose: BlueprintActionPose): BlueprintActionPose {
  const result: BlueprintActionPose = {};
  for (const spec of PERSON_JOINTS) {
    const source = pose[spec.key] as BlueprintPoseRotation | undefined;
    if (!source) continue;
    // Lateral joints are already side-relative; only midline twists flip.
    const mirrored: BlueprintPoseRotation = { ...source };
    if (spec.side === null) {
      if (finite(source.y)) mirrored.y = -source.y;
      if (finite(source.z)) mirrored.z = -source.z;
    }
    (result as Record<string, unknown>)[spec.mirror] = mirrored;
  }
  if (pose.leftFingers) result.rightFingers = { ...pose.leftFingers };
  if (pose.rightFingers) result.leftFingers = { ...pose.rightFingers };
  if (pose.scaleY !== undefined) result.scaleY = pose.scaleY;
  if (pose.groupY !== undefined) result.groupY = pose.groupY;
  if (pose.groupRotX !== undefined) result.groupRotX = pose.groupRotX;
  if (pose.groupRotZ !== undefined) result.groupRotZ = -pose.groupRotZ;
  return result;
}

/** Copy one arm or leg onto the other side. */
export function copyPersonPoseSide(
  pose: BlueprintActionPose,
  from: PersonSide,
  part: 'arm' | 'leg',
): BlueprintActionPose {
  const region = `${from}${part === 'arm' ? 'Arm' : 'Leg'}` as PersonBodyRegion;
  const next: BlueprintActionPose = { ...pose };
  for (const spec of PERSON_JOINTS) {
    if (spec.region !== region) continue;
    const source = pose[spec.key];
    if (source) (next as Record<string, unknown>)[spec.mirror] = { ...source };
    else delete next[spec.mirror];
  }
  if (part === 'arm') {
    const source: PersonFingersKey = `${from}Fingers`;
    const target: PersonFingersKey = from === 'left' ? 'rightFingers' : 'leftFingers';
    if (pose[source]) next[target] = { ...pose[source] };
    else delete next[target];
  }
  return next;
}

/** Deterministic key for render caching. */
export function personPoseKey(pose: BlueprintActionPose | undefined): string {
  if (!pose) return '';
  const parts: string[] = [];
  for (const spec of PERSON_JOINTS) {
    const joint = pose[spec.key] as BlueprintPoseRotation | undefined;
    if (joint) parts.push(`${spec.key}:${joint.x ?? 0},${joint.y ?? 0},${joint.z ?? 0}`);
  }
  for (const hand of PERSON_FINGERS_KEYS) {
    const value = pose[hand];
    if (value) parts.push(`${hand}:${value.curl ?? ''},${value.index ?? ''},${value.thumb ?? ''},${value.spread ?? ''}`);
  }
  parts.push(`${pose.scaleY ?? ''},${pose.groupY ?? ''},${pose.groupRotX ?? ''},${pose.groupRotZ ?? ''}`);
  return parts.join('|');
}

export type { BlueprintHandPose, BlueprintPoseHinge, BlueprintPoseRotation };
