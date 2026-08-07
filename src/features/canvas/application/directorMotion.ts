import * as THREE from 'three';

import type {
  BlueprintActionPose,
  BlueprintBodyControls,
  BlueprintItem,
  DirectorActionClip,
  DirectorActionClipKeyframe,
  DirectorActionKeyframe,
  DirectorActionState,
  DirectorCameraKeyframe,
  DirectorMotionEasing,
  DirectorMotionProjectV1,
  DirectorMotionVector3,
  DirectorObjectKeyframe,
} from '@/features/canvas/domain/canvasNodes';
import { ensurePos3d } from '@/features/canvas/ui/blueprintCoordinates';

export const DIRECTOR_MOTION_SCHEMA_VERSION = 1 as const;
export const DIRECTOR_MOTION_DEFAULT_DURATION_SECONDS = 8;
export const DIRECTOR_MOTION_MIN_DURATION_SECONDS = 0.5;
export const DIRECTOR_MOTION_MAX_DURATION_SECONDS = 30;

type UnknownRecord = Record<string, unknown>;

export interface SampledDirectorObjectState {
  position: DirectorMotionVector3;
  rotation: DirectorMotionVector3;
  scale: DirectorMotionVector3;
}

export interface SampledDirectorActionState extends DirectorActionState {
  pose?: BlueprintActionPose;
}

export interface SampledDirectorCameraState {
  position: DirectorMotionVector3;
  target: DirectorMotionVector3;
  fov: number;
  trackTargetId?: string | null;
  trackTargetBodyPart?: string | null;
}

export interface SampledDirectorMotionFrame {
  time: number;
  camera: SampledDirectorCameraState | null;
  objects: Record<string, SampledDirectorObjectState>;
  actions: Record<string, SampledDirectorActionState>;
}

export interface DirectorStaticPoseDefinition {
  id: string;
  labelKey: string;
  pose: BlueprintActionPose;
}

export interface DirectorProceduralActionDefinition {
  id: string;
  labelKey: string;
  durationSeconds: number;
}

export interface DirectorCameraPresetDefinition {
  id: string;
  labelKey: string;
}

export type DirectorCameraPresetId =
  | 'cinematic-push'
  | 'character-follow'
  | 'fast-chase'
  | 'product-orbit'
  | 'crane-rise'
  | 'lateral-dolly';

const EMPTY_POSE: BlueprintActionPose = {};

export const DIRECTOR_STATIC_POSES: readonly DirectorStaticPoseDefinition[] = [
  { id: 'stand-neutral', labelKey: 'directorStudio.motion.poses.standNeutral', pose: {} },
  { id: 'stand-attention', labelKey: 'directorStudio.motion.poses.standAttention', pose: { leftShoulder: { z: -0.06 }, rightShoulder: { z: 0.06 } } },
  { id: 'lean-forward', labelKey: 'directorStudio.motion.poses.leanForward', pose: { torso: { x: -0.35 }, head: { x: 0.16 } } },
  { id: 'lean-back', labelKey: 'directorStudio.motion.poses.leanBack', pose: { torso: { x: 0.3 }, head: { x: -0.12 } } },
  { id: 'hands-on-hips', labelKey: 'directorStudio.motion.poses.handsOnHips', pose: { leftShoulder: { z: -0.8 }, rightShoulder: { z: 0.8 }, leftElbow: { x: -1.15 }, rightElbow: { x: -1.15 } } },
  { id: 'arms-crossed', labelKey: 'directorStudio.motion.poses.armsCrossed', pose: { leftShoulder: { x: -1.0, z: -0.45 }, rightShoulder: { x: -1.0, z: 0.45 }, leftElbow: { x: -1.2 }, rightElbow: { x: -1.2 } } },
  { id: 'sit-upright', labelKey: 'directorStudio.motion.poses.sitUpright', pose: { leftHip: { x: -1.5 }, rightHip: { x: -1.5 }, leftKnee: { x: 1.5 }, rightKnee: { x: 1.5 }, groupY: -0.42 } },
  { id: 'sit-relaxed', labelKey: 'directorStudio.motion.poses.sitRelaxed', pose: { leftHip: { x: -1.45 }, rightHip: { x: -1.2 }, leftKnee: { x: 1.4 }, rightKnee: { x: 1.05 }, torso: { x: 0.18 }, groupY: -0.4 } },
  { id: 'squat-low', labelKey: 'directorStudio.motion.poses.squatLow', pose: { leftHip: { x: -1.75 }, rightHip: { x: -1.75 }, leftKnee: { x: 1.75 }, rightKnee: { x: 1.75 }, torso: { x: -0.35 }, groupY: -0.55 } },
  { id: 'kneel-one', labelKey: 'directorStudio.motion.poses.kneelOne', pose: { leftHip: { x: -1.15 }, leftKnee: { x: 1.7 }, rightHip: { x: 0.25 }, rightKnee: { x: 1.45 }, groupY: -0.48 } },
  { id: 'kneel-two', labelKey: 'directorStudio.motion.poses.kneelTwo', pose: { leftHip: { x: 0.45 }, rightHip: { x: 0.45 }, leftKnee: { x: 1.65 }, rightKnee: { x: 1.65 }, groupY: -0.5 } },
  { id: 'lie-back', labelKey: 'directorStudio.motion.poses.lieBack', pose: { groupRotX: -Math.PI / 2, groupY: 0.18 } },
  { id: 'walk-stride', labelKey: 'directorStudio.motion.poses.walkStride', pose: { leftHip: { x: -0.55 }, rightHip: { x: 0.3 }, leftKnee: { x: 0.55 }, rightShoulder: { x: -0.45 }, leftShoulder: { x: 0.4 } } },
  { id: 'run-stride', labelKey: 'directorStudio.motion.poses.runStride', pose: { leftHip: { x: -1 }, rightHip: { x: 0.6 }, leftKnee: { x: 1.5 }, rightShoulder: { x: -0.9 }, leftShoulder: { x: 0.7 }, torso: { x: -0.25 } } },
  { id: 'point-forward', labelKey: 'directorStudio.motion.poses.pointForward', pose: { rightShoulder: { x: -Math.PI / 2 }, rightElbow: { x: -0.1 } } },
  { id: 'reach-up', labelKey: 'directorStudio.motion.poses.reachUp', pose: { rightShoulder: { x: -2.65 }, rightElbow: { x: 0.08 }, head: { x: -0.15 } } },
  { id: 'wave', labelKey: 'directorStudio.motion.poses.wave', pose: { rightShoulder: { x: -1.8, z: 0.18 }, rightElbow: { x: -1.1 } } },
  { id: 'look-up', labelKey: 'directorStudio.motion.poses.lookUp', pose: { head: { x: -0.45 } } },
  { id: 'look-down', labelKey: 'directorStudio.motion.poses.lookDown', pose: { head: { x: 0.45 } } },
  { id: 'look-left', labelKey: 'directorStudio.motion.poses.lookLeft', pose: { head: { y: 0.75 }, torso: { x: -0.04 } } },
  { id: 'look-right', labelKey: 'directorStudio.motion.poses.lookRight', pose: { head: { y: -0.75 }, torso: { x: -0.04 } } },
  { id: 'talk-gesture', labelKey: 'directorStudio.motion.poses.talkGesture', pose: { rightShoulder: { x: -0.5, z: -0.2 }, rightElbow: { x: -1.3 }, head: { y: 0.25 } } },
  { id: 'observe', labelKey: 'directorStudio.motion.poses.observe', pose: { rightShoulder: { x: -1.7, z: 0.3 }, rightElbow: { x: -0.5 }, head: { x: -0.18 } } },
  { id: 'jump-apex', labelKey: 'directorStudio.motion.poses.jumpApex', pose: { leftHip: { x: -0.5 }, rightHip: { x: -0.5 }, leftKnee: { x: 1 }, rightKnee: { x: 1 }, leftShoulder: { x: -2.4 }, rightShoulder: { x: -2.4 }, groupY: 0.4 } },
] as const;

export const DIRECTOR_STATIC_POSE_MAP: Readonly<Record<string, BlueprintActionPose>> = Object.fromEntries(
  DIRECTOR_STATIC_POSES.map((definition) => [definition.id, definition.pose]),
);

export const DIRECTOR_PROCEDURAL_ACTIONS: readonly DirectorProceduralActionDefinition[] = [
  { id: 'walk', labelKey: 'directorStudio.motion.actions.walk', durationSeconds: 1.1 },
  { id: 'run', labelKey: 'directorStudio.motion.actions.run', durationSeconds: 0.72 },
  { id: 'squat-rise', labelKey: 'directorStudio.motion.actions.squatRise', durationSeconds: 1.8 },
  { id: 'step-over', labelKey: 'directorStudio.motion.actions.stepOver', durationSeconds: 1.5 },
  { id: 'jump', labelKey: 'directorStudio.motion.actions.jump', durationSeconds: 1.25 },
  { id: 'wave', labelKey: 'directorStudio.motion.actions.wave', durationSeconds: 1.4 },
] as const;

export const DIRECTOR_CAMERA_PRESETS: readonly DirectorCameraPresetDefinition[] = [
  { id: 'cinematic-push', labelKey: 'directorStudio.motion.cameraPresets.cinematicPush' },
  { id: 'character-follow', labelKey: 'directorStudio.motion.cameraPresets.characterFollow' },
  { id: 'fast-chase', labelKey: 'directorStudio.motion.cameraPresets.fastChase' },
  { id: 'product-orbit', labelKey: 'directorStudio.motion.cameraPresets.productOrbit' },
  { id: 'crane-rise', labelKey: 'directorStudio.motion.cameraPresets.craneRise' },
  { id: 'lateral-dolly', labelKey: 'directorStudio.motion.cameraPresets.lateralDolly' },
] as const;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeVector3(value: unknown, fallback: DirectorMotionVector3): DirectorMotionVector3 {
  const record = asRecord(value);
  return {
    x: finiteNumber(record?.x, fallback.x),
    y: finiteNumber(record?.y, fallback.y),
    z: finiteNumber(record?.z, fallback.z),
  };
}

function normalizeEasing(value: unknown): DirectorMotionEasing {
  return value === 'smooth' ? 'smooth' : 'linear';
}

function normalizeId(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function sortKeyframes<T extends { time: number }>(frames: T[]): T[] {
  return frames
    .map((frame, index) => ({ frame, index }))
    .sort((a, b) => a.frame.time - b.frame.time || a.index - b.index)
    .map(({ frame }) => frame);
}

function normalizePose(value: unknown): BlueprintActionPose | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const rotation = (entry: unknown) => {
    const source = asRecord(entry);
    if (!source) return undefined;
    const result = {
      ...(typeof source.x === 'number' && Number.isFinite(source.x) ? { x: source.x } : {}),
      ...(typeof source.y === 'number' && Number.isFinite(source.y) ? { y: source.y } : {}),
      ...(typeof source.z === 'number' && Number.isFinite(source.z) ? { z: source.z } : {}),
    };
    return Object.keys(result).length > 0 ? result : undefined;
  };
  const hinge = (entry: unknown) => {
    const source = asRecord(entry);
    return source && typeof source.x === 'number' && Number.isFinite(source.x) ? { x: source.x } : undefined;
  };
  const pose: BlueprintActionPose = {
    leftShoulder: rotation(record.leftShoulder),
    rightShoulder: rotation(record.rightShoulder),
    leftElbow: hinge(record.leftElbow),
    rightElbow: hinge(record.rightElbow),
    leftHip: rotation(record.leftHip),
    rightHip: rotation(record.rightHip),
    leftKnee: hinge(record.leftKnee),
    rightKnee: hinge(record.rightKnee),
    head: rotation(record.head),
    torso: hinge(record.torso),
    ...(typeof record.scaleY === 'number' && Number.isFinite(record.scaleY) ? { scaleY: record.scaleY } : {}),
    ...(typeof record.groupY === 'number' && Number.isFinite(record.groupY) ? { groupY: record.groupY } : {}),
    ...(typeof record.groupRotX === 'number' && Number.isFinite(record.groupRotX) ? { groupRotX: record.groupRotX } : {}),
  };
  return pose;
}

function normalizeBodyControls(value: unknown): BlueprintBodyControls | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const numericSection = (entry: unknown, keys: readonly string[]) => {
    const source = asRecord(entry);
    if (!source) return undefined;
    const result: Record<string, number> = {};
    keys.forEach((key) => {
      const next = source[key];
      if (typeof next === 'number' && Number.isFinite(next)) result[key] = next;
    });
    return Object.keys(result).length > 0 ? result : undefined;
  };
  const styles = new Set(['preset', 'slim', 'strong', 'heavy', 'childlike']);
  return {
    ...(typeof record.style === 'string' && styles.has(record.style) ? { style: record.style as NonNullable<BlueprintBodyControls['style']> } : {}),
    ...(typeof record.showControls === 'boolean' ? { showControls: record.showControls } : {}),
    core: numericSection(record.core, ['height', 'torsoWidth', 'headScale', 'torsoLeanDeg']) as BlueprintBodyControls['core'],
    arms: numericSection(record.arms, ['length', 'thickness', 'spreadDeg']) as BlueprintBodyControls['arms'],
    legs: numericSection(record.legs, ['length', 'thickness', 'spreadDeg']) as BlueprintBodyControls['legs'],
  };
}

function normalizeActionState(record: UnknownRecord): DirectorActionState {
  const stringOrNull = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
  return {
    poseId: stringOrNull(record.poseId),
    actionId: stringOrNull(record.actionId),
    clipId: stringOrNull(record.clipId),
    pose: normalizePose(record.pose),
    bodyControls: normalizeBodyControls(record.bodyControls),
  };
}

function normalizeCameraTrack(value: unknown, duration: number): DirectorCameraKeyframe[] {
  if (!Array.isArray(value)) return [];
  return sortKeyframes(value.flatMap((entry, index) => {
    const record = asRecord(entry);
    if (!record) return [];
    return [{
      id: normalizeId(record.id, `camera-${index}`),
      time: clamp(finiteNumber(record.time, 0), 0, duration),
      easing: normalizeEasing(record.easing),
      position: normalizeVector3(record.position, { x: 0, y: 2, z: 8 }),
      target: normalizeVector3(record.target, { x: 0, y: 1, z: 0 }),
      fov: clamp(finiteNumber(record.fov, 45), 10, 150),
      trackTargetId: typeof record.trackTargetId === 'string' ? record.trackTargetId : null,
      trackTargetBodyPart: typeof record.trackTargetBodyPart === 'string' ? record.trackTargetBodyPart : null,
    }];
  }));
}

function normalizeObjectTrack(value: unknown, duration: number, trackId: string): DirectorObjectKeyframe[] {
  if (!Array.isArray(value)) return [];
  return sortKeyframes(value.flatMap((entry, index) => {
    const record = asRecord(entry);
    if (!record) return [];
    return [{
      id: normalizeId(record.id, `${trackId}-transform-${index}`),
      time: clamp(finiteNumber(record.time, 0), 0, duration),
      easing: normalizeEasing(record.easing),
      position: normalizeVector3(record.position, { x: 0, y: 0, z: 0 }),
      rotation: normalizeVector3(record.rotation, { x: 0, y: 0, z: 0 }),
      scale: normalizeVector3(record.scale, { x: 1, y: 1, z: 1 }),
      orientToPath: record.orientToPath === true,
    }];
  }));
}

function normalizeActionTrack(value: unknown, duration: number, trackId: string): DirectorActionKeyframe[] {
  if (!Array.isArray(value)) return [];
  return sortKeyframes(value.flatMap((entry, index) => {
    const record = asRecord(entry);
    if (!record) return [];
    return [{
      id: normalizeId(record.id, `${trackId}-action-${index}`),
      time: clamp(finiteNumber(record.time, 0), 0, duration),
      easing: normalizeEasing(record.easing),
      ...normalizeActionState(record),
    }];
  }));
}

function normalizeClip(value: unknown, index: number): DirectorActionClip | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = normalizeId(record.id, `clip-${index}`);
  const durationSeconds = clamp(
    finiteNumber(record.durationSeconds, DIRECTOR_MOTION_DEFAULT_DURATION_SECONDS),
    DIRECTOR_MOTION_MIN_DURATION_SECONDS,
    DIRECTOR_MOTION_MAX_DURATION_SECONDS,
  );
  const keyframes: DirectorActionClipKeyframe[] = Array.isArray(record.keyframes)
    ? sortKeyframes(record.keyframes.flatMap((entry, keyframeIndex) => {
        const keyframe = asRecord(entry);
        if (!keyframe) return [];
        return [{
          id: normalizeId(keyframe.id, `${id}-${keyframeIndex}`),
          time: clamp(finiteNumber(keyframe.time, 0), 0, durationSeconds),
          easing: normalizeEasing(keyframe.easing),
          ...normalizeActionState(keyframe),
        }];
      }))
    : [];
  return {
    id,
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : `Clip ${index + 1}`,
    durationSeconds,
    loop: record.loop === true,
    keyframes,
  };
}

export function createEmptyDirectorMotionProject(
  durationSeconds = DIRECTOR_MOTION_DEFAULT_DURATION_SECONDS,
): DirectorMotionProjectV1 {
  return {
    schemaVersion: DIRECTOR_MOTION_SCHEMA_VERSION,
    durationSeconds: clamp(
      finiteNumber(durationSeconds, DIRECTOR_MOTION_DEFAULT_DURATION_SECONDS),
      DIRECTOR_MOTION_MIN_DURATION_SECONDS,
      DIRECTOR_MOTION_MAX_DURATION_SECONDS,
    ),
    loop: false,
    cameraTrack: [],
    objectTracks: {},
    actionTracks: {},
    customClips: [],
  };
}

export function normalizeDirectorMotionProject(value: unknown): DirectorMotionProjectV1 {
  const record = asRecord(value);
  const durationSeconds = clamp(
    finiteNumber(record?.durationSeconds, DIRECTOR_MOTION_DEFAULT_DURATION_SECONDS),
    DIRECTOR_MOTION_MIN_DURATION_SECONDS,
    DIRECTOR_MOTION_MAX_DURATION_SECONDS,
  );
  const objectTracks: Record<string, DirectorObjectKeyframe[]> = {};
  const rawObjectTracks = asRecord(record?.objectTracks);
  Object.entries(rawObjectTracks ?? {}).forEach(([trackId, track]) => {
    objectTracks[trackId] = normalizeObjectTrack(track, durationSeconds, trackId);
  });
  const actionTracks: Record<string, DirectorActionKeyframe[]> = {};
  const rawActionTracks = asRecord(record?.actionTracks);
  Object.entries(rawActionTracks ?? {}).forEach(([trackId, track]) => {
    actionTracks[trackId] = normalizeActionTrack(track, durationSeconds, trackId);
  });
  return {
    schemaVersion: DIRECTOR_MOTION_SCHEMA_VERSION,
    durationSeconds,
    loop: record?.loop === true,
    cameraTrack: normalizeCameraTrack(record?.cameraTrack, durationSeconds),
    objectTracks,
    actionTracks,
    customClips: Array.isArray(record?.customClips)
      ? record.customClips
          .map(normalizeClip)
          .filter((clip): clip is DirectorActionClip => Boolean(clip))
      : [],
  };
}

function easeProgress(progress: number, easing: DirectorMotionEasing): number {
  const t = clamp(progress, 0, 1);
  return easing === 'smooth' ? t * t * (3 - 2 * t) : t;
}

function lerpNumber(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function lerpVector(from: DirectorMotionVector3, to: DirectorMotionVector3, amount: number): DirectorMotionVector3 {
  return {
    x: lerpNumber(from.x, to.x, amount),
    y: lerpNumber(from.y, to.y, amount),
    z: lerpNumber(from.z, to.z, amount),
  };
}

function slerpEuler(from: DirectorMotionVector3, to: DirectorMotionVector3, amount: number): DirectorMotionVector3 {
  const fromQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(from.x, from.y, from.z, 'XYZ'));
  const toQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(to.x, to.y, to.z, 'XYZ'));
  fromQuat.slerp(toQuat, amount);
  const euler = new THREE.Euler().setFromQuaternion(fromQuat, 'XYZ');
  return { x: euler.x, y: euler.y, z: euler.z };
}

interface Segment<T> {
  from: T;
  to: T;
  amount: number;
  rawAmount: number;
  fromIndex: number;
  toIndex: number;
}

function findSegment<T extends { time: number; easing: DirectorMotionEasing }>(track: T[], time: number): Segment<T> | null {
  if (track.length === 0) return null;
  if (track.length === 1 || time <= track[0].time) {
    return { from: track[0], to: track[0], amount: 0, rawAmount: 0, fromIndex: 0, toIndex: 0 };
  }
  const lastIndex = track.length - 1;
  if (time >= track[lastIndex].time) {
    return { from: track[lastIndex], to: track[lastIndex], amount: 0, rawAmount: 0, fromIndex: lastIndex, toIndex: lastIndex };
  }
  const toIndex = track.findIndex((keyframe) => keyframe.time >= time);
  const fromIndex = Math.max(0, toIndex - 1);
  const from = track[fromIndex];
  const to = track[toIndex];
  const rawAmount = (time - from.time) / Math.max(0.000001, to.time - from.time);
  return {
    from,
    to,
    rawAmount,
    amount: easeProgress(rawAmount, to.easing),
    fromIndex,
    toIndex,
  };
}

function numericPoseValue(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function interpolatePose(from: BlueprintActionPose | undefined, to: BlueprintActionPose | undefined, amount: number): BlueprintActionPose | undefined {
  if (!from && !to) return undefined;
  const start = from ?? EMPTY_POSE;
  const end = to ?? EMPTY_POSE;
  const rotation = (
    left: { x?: number; y?: number; z?: number } | undefined,
    right: { x?: number; y?: number; z?: number } | undefined,
  ) => ({
    x: lerpNumber(numericPoseValue(left?.x), numericPoseValue(right?.x), amount),
    y: lerpNumber(numericPoseValue(left?.y), numericPoseValue(right?.y), amount),
    z: lerpNumber(numericPoseValue(left?.z), numericPoseValue(right?.z), amount),
  });
  const hinge = (left: { x?: number } | undefined, right: { x?: number } | undefined) => ({
    x: lerpNumber(numericPoseValue(left?.x), numericPoseValue(right?.x), amount),
  });
  return {
    leftShoulder: rotation(start.leftShoulder, end.leftShoulder),
    rightShoulder: rotation(start.rightShoulder, end.rightShoulder),
    leftElbow: hinge(start.leftElbow, end.leftElbow),
    rightElbow: hinge(start.rightElbow, end.rightElbow),
    leftHip: rotation(start.leftHip, end.leftHip),
    rightHip: rotation(start.rightHip, end.rightHip),
    leftKnee: hinge(start.leftKnee, end.leftKnee),
    rightKnee: hinge(start.rightKnee, end.rightKnee),
    head: rotation(start.head, end.head),
    torso: hinge(start.torso, end.torso),
    scaleY: lerpNumber(numericPoseValue(start.scaleY, 1), numericPoseValue(end.scaleY, 1), amount),
    groupY: lerpNumber(numericPoseValue(start.groupY), numericPoseValue(end.groupY), amount),
    groupRotX: lerpNumber(numericPoseValue(start.groupRotX), numericPoseValue(end.groupRotX), amount),
  };
}

export function sampleDirectorProceduralAction(actionId: string, timeSeconds: number): BlueprintActionPose {
  const definition = DIRECTOR_PROCEDURAL_ACTIONS.find((action) => action.id === actionId);
  const duration = definition?.durationSeconds ?? 1;
  const phase = ((timeSeconds % duration) + duration) % duration / duration;
  const wave = Math.sin(phase * Math.PI * 2);
  const positiveWave = (1 - Math.cos(phase * Math.PI * 2)) / 2;
  switch (actionId) {
    case 'walk':
      return {
        leftHip: { x: wave * 0.62 }, rightHip: { x: -wave * 0.62 },
        leftKnee: { x: Math.max(0, -wave) * 0.72 }, rightKnee: { x: Math.max(0, wave) * 0.72 },
        leftShoulder: { x: -wave * 0.5 }, rightShoulder: { x: wave * 0.5 },
        groupY: Math.abs(wave) * 0.025,
      };
    case 'run':
      return {
        leftHip: { x: wave * 1.05 }, rightHip: { x: -wave * 1.05 },
        leftKnee: { x: Math.max(0, -wave) * 1.45 }, rightKnee: { x: Math.max(0, wave) * 1.45 },
        leftShoulder: { x: -wave * 0.9 }, rightShoulder: { x: wave * 0.9 },
        leftElbow: { x: -0.8 }, rightElbow: { x: -0.8 }, torso: { x: -0.22 },
        groupY: Math.abs(wave) * 0.08,
      };
    case 'squat-rise': {
      const bend = positiveWave * 1.72;
      return {
        leftHip: { x: -bend }, rightHip: { x: -bend },
        leftKnee: { x: bend }, rightKnee: { x: bend },
        leftShoulder: { x: -bend * 0.28 }, rightShoulder: { x: -bend * 0.28 },
        torso: { x: -bend * 0.2 }, groupY: -positiveWave * 0.55,
      };
    }
    case 'step-over': {
      const lift = Math.sin(phase * Math.PI);
      return {
        leftHip: { x: -lift * 1.15 }, leftKnee: { x: lift * 1.35 },
        rightHip: { x: phase > 0.5 ? -(1 - lift) * 0.45 : 0 },
        leftShoulder: { z: -lift * 0.25 }, rightShoulder: { z: lift * 0.25 },
        groupY: lift * 0.08,
      };
    }
    case 'jump': {
      const lift = Math.sin(phase * Math.PI);
      return {
        leftHip: { x: -lift * 0.55 }, rightHip: { x: -lift * 0.55 },
        leftKnee: { x: lift * 1.05 }, rightKnee: { x: lift * 1.05 },
        leftShoulder: { x: -lift * 2.4 }, rightShoulder: { x: -lift * 2.4 },
        groupY: lift * 0.55,
      };
    }
    case 'wave':
      return {
        rightShoulder: { x: -1.75, z: 0.2 },
        rightElbow: { x: -1.05 + wave * 0.2 },
        head: { y: wave * 0.08 },
      };
    default:
      return {};
  }
}

function sampleActionState(
  state: DirectorActionState,
  elapsedSeconds: number,
  customClips: DirectorActionClip[],
): SampledDirectorActionState {
  if (state.clipId) {
    const clip = customClips.find((candidate) => candidate.id === state.clipId);
    if (clip && clip.keyframes.length > 0) {
      const clipTime = clip.loop
        ? ((elapsedSeconds % clip.durationSeconds) + clip.durationSeconds) % clip.durationSeconds
        : clamp(elapsedSeconds, 0, clip.durationSeconds);
      const sampled = sampleActionTrack(clip.keyframes, clipTime, customClips);
      return { ...sampled, clipId: clip.id };
    }
  }
  if (state.actionId) {
    return { ...state, pose: sampleDirectorProceduralAction(state.actionId, elapsedSeconds) };
  }
  const staticPose = state.poseId ? DIRECTOR_STATIC_POSE_MAP[state.poseId] : undefined;
  return { ...state, pose: state.pose ?? staticPose };
}

function sampleActionTrack(
  track: Array<DirectorActionKeyframe | DirectorActionClipKeyframe>,
  time: number,
  customClips: DirectorActionClip[],
): SampledDirectorActionState {
  const segment = findSegment(track, time);
  if (!segment) return {};
  const elapsed = Math.max(0, time - segment.from.time);
  const from = sampleActionState(segment.from, elapsed, customClips);
  if (segment.from === segment.to || from.actionId || from.clipId) return from;
  const to = sampleActionState(segment.to, 0, customClips);
  return {
    ...from,
    pose: interpolatePose(from.pose, to.pose, segment.amount),
  };
}

function sampleObjectTrack(track: DirectorObjectKeyframe[], time: number): SampledDirectorObjectState | null {
  const segment = findSegment(track, time);
  if (!segment) return null;
  const { from, to, amount, rawAmount } = segment;
  let rotation = slerpEuler(from.rotation, to.rotation, amount);
  if ((from.orientToPath || to.orientToPath) && segment.fromIndex !== segment.toIndex) {
    const previous = track[Math.max(0, segment.fromIndex - 1)] ?? from;
    const next = track[Math.min(track.length - 1, segment.toIndex + 1)] ?? to;
    const tangent = new THREE.Vector3(
      next.position.x - previous.position.x,
      0,
      next.position.z - previous.position.z,
    );
    if (tangent.lengthSq() > 0.000001) {
      const pathRotation = { x: rotation.x, y: Math.atan2(tangent.x, tangent.z), z: rotation.z };
      rotation = slerpEuler(rotation, pathRotation, easeProgress(Math.min(1, rawAmount * 2), 'smooth'));
    }
  }
  return {
    position: lerpVector(from.position, to.position, amount),
    rotation,
    scale: lerpVector(from.scale, to.scale, amount),
  };
}

function getBaseObjectState(item: BlueprintItem): SampledDirectorObjectState {
  const position = ensurePos3d(item);
  return {
    position: { x: position.x, y: position.y, z: position.z },
    rotation: {
      x: finiteNumber(item.rotation3d?.x, 0),
      y: finiteNumber(item.rotation3d?.y, 0),
      z: finiteNumber(item.rotation3d?.z, 0),
    },
    scale: {
      x: finiteNumber(item.scale3d?.x, 1),
      y: finiteNumber(item.scale3d?.y, 1),
      z: finiteNumber(item.scale3d?.z, 1),
    },
  };
}

function getBodyPartOffset(bodyPart: string | null | undefined): DirectorMotionVector3 {
  switch (bodyPart) {
    case 'head': return { x: 0, y: 1.6, z: 0 };
    case 'torso': return { x: 0, y: 1.05, z: 0 };
    case 'feet': return { x: 0, y: 0.1, z: 0 };
    default: return { x: 0, y: 0.9, z: 0 };
  }
}

function sampleCameraTrack(
  track: DirectorCameraKeyframe[],
  time: number,
  sampledObjects: Record<string, SampledDirectorObjectState>,
  itemsById: Map<string, BlueprintItem>,
): SampledDirectorCameraState | null {
  const segment = findSegment(track, time);
  if (!segment) return null;
  const { from, to, amount } = segment;
  const trackTargetId = amount < 0.5 ? from.trackTargetId : to.trackTargetId;
  const trackTargetBodyPart = amount < 0.5 ? from.trackTargetBodyPart : to.trackTargetBodyPart;
  let target = lerpVector(from.target, to.target, amount);
  if (trackTargetId) {
    const sampledTarget = sampledObjects[trackTargetId]?.position;
    const baseItem = itemsById.get(trackTargetId);
    const baseTarget = sampledTarget ?? (baseItem ? ensurePos3d(baseItem) : null);
    if (baseTarget) {
      const offset = getBodyPartOffset(trackTargetBodyPart);
      target = {
        x: baseTarget.x + offset.x,
        y: baseTarget.y + offset.y,
        z: baseTarget.z + offset.z,
      };
    }
  }
  return {
    position: lerpVector(from.position, to.position, amount),
    target,
    fov: lerpNumber(from.fov, to.fov, amount),
    trackTargetId,
    trackTargetBodyPart,
  };
}

export function sampleNormalizedDirectorMotion(
  project: DirectorMotionProjectV1,
  requestedTime: number,
  items: BlueprintItem[] = [],
): SampledDirectorMotionFrame {
  const time = clamp(finiteNumber(requestedTime, 0), 0, project.durationSeconds);
  const objects: Record<string, SampledDirectorObjectState> = Object.fromEntries(
    items.map((item) => [item.id, getBaseObjectState(item)]),
  );
  Object.entries(project.objectTracks).forEach(([itemId, track]) => {
    const sampled = sampleObjectTrack(track, time);
    if (sampled) objects[itemId] = sampled;
  });
  const actions: Record<string, SampledDirectorActionState> = {};
  Object.entries(project.actionTracks).forEach(([itemId, track]) => {
    if (track.length > 0) actions[itemId] = sampleActionTrack(track, time, project.customClips);
  });
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return {
    time,
    camera: sampleCameraTrack(project.cameraTrack, time, objects, itemsById),
    objects,
    actions,
  };
}

export function sampleDirectorMotion(
  rawProject: DirectorMotionProjectV1,
  requestedTime: number,
  items: BlueprintItem[] = [],
): SampledDirectorMotionFrame {
  return sampleNormalizedDirectorMotion(
    normalizeDirectorMotionProject(rawProject),
    requestedTime,
    items,
  );
}

export function deleteDirectorMotionClip(
  project: DirectorMotionProjectV1,
  clipId: string,
): DirectorMotionProjectV1 {
  return {
    ...project,
    customClips: project.customClips
      .filter((clip) => clip.id !== clipId)
      .map((clip) => ({
        ...clip,
        keyframes: clip.keyframes.filter((keyframe) => keyframe.clipId !== clipId),
      })),
    actionTracks: Object.fromEntries(Object.entries(project.actionTracks).map(([itemId, track]) => [
      itemId,
      track.filter((keyframe) => keyframe.clipId !== clipId),
    ])),
  };
}

export function createDirectorMotionId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createObjectKeyframeFromItem(
  item: BlueprintItem,
  time: number,
  easing: DirectorMotionEasing = 'smooth',
): DirectorObjectKeyframe {
  const position = ensurePos3d(item);
  return {
    id: createDirectorMotionId('transform'),
    time,
    easing,
    position: { x: position.x, y: position.y, z: position.z },
    rotation: {
      x: finiteNumber(item.rotation3d?.x, 0),
      y: finiteNumber(item.rotation3d?.y, 0),
      z: finiteNumber(item.rotation3d?.z, 0),
    },
    scale: {
      x: finiteNumber(item.scale3d?.x, 1),
      y: finiteNumber(item.scale3d?.y, 1),
      z: finiteNumber(item.scale3d?.z, 1),
    },
    orientToPath: item.category === 'person',
  };
}

function cameraKeyframe(
  id: string,
  time: number,
  position: DirectorMotionVector3,
  target: DirectorMotionVector3,
  fov: number,
  trackTargetId?: string | null,
): DirectorCameraKeyframe {
  return { id, time, easing: 'smooth', position, target, fov, trackTargetId: trackTargetId ?? null };
}

export function createDirectorCameraPresetTrack(
  presetId: DirectorCameraPresetId,
  durationSeconds: number,
  targetItem?: BlueprintItem | null,
): DirectorCameraKeyframe[] {
  const duration = clamp(durationSeconds, DIRECTOR_MOTION_MIN_DURATION_SECONDS, DIRECTOR_MOTION_MAX_DURATION_SECONDS);
  const targetPosition = targetItem ? ensurePos3d(targetItem) : { x: 0, y: 0, z: 0 };
  const target = { x: targetPosition.x, y: targetPosition.y + (targetItem?.category === 'person' ? 1.05 : 0.6), z: targetPosition.z };
  const id = (suffix: string) => createDirectorMotionId(`${presetId}-${suffix}`);
  switch (presetId) {
    case 'cinematic-push':
      return [
        cameraKeyframe(id('start'), 0, { x: target.x, y: target.y + 0.25, z: target.z + 9 }, target, 46),
        cameraKeyframe(id('end'), duration, { x: target.x, y: target.y + 0.1, z: target.z + 3.2 }, target, 35),
      ];
    case 'character-follow':
      return [
        cameraKeyframe(id('start'), 0, { x: target.x - 2.2, y: target.y + 1.1, z: target.z + 4.8 }, target, 42, targetItem?.id),
        cameraKeyframe(id('end'), duration, { x: target.x + 2.2, y: target.y + 0.8, z: target.z + 4.2 }, target, 42, targetItem?.id),
      ];
    case 'fast-chase':
      return [
        cameraKeyframe(id('start'), 0, { x: target.x, y: target.y + 0.8, z: target.z + 7.5 }, target, 58, targetItem?.id),
        cameraKeyframe(id('mid'), duration * 0.48, { x: target.x - 1.2, y: target.y + 0.45, z: target.z + 3.7 }, target, 52, targetItem?.id),
        cameraKeyframe(id('end'), duration, { x: target.x + 0.8, y: target.y + 0.35, z: target.z + 2.7 }, target, 48, targetItem?.id),
      ];
    case 'product-orbit':
      return [
        cameraKeyframe(id('a'), 0, { x: target.x, y: target.y + 1.5, z: target.z + 4.5 }, target, 40, targetItem?.id),
        cameraKeyframe(id('b'), duration * 0.25, { x: target.x + 4.5, y: target.y + 1.3, z: target.z }, target, 40, targetItem?.id),
        cameraKeyframe(id('c'), duration * 0.5, { x: target.x, y: target.y + 1.5, z: target.z - 4.5 }, target, 40, targetItem?.id),
        cameraKeyframe(id('d'), duration * 0.75, { x: target.x - 4.5, y: target.y + 1.3, z: target.z }, target, 40, targetItem?.id),
        cameraKeyframe(id('e'), duration, { x: target.x, y: target.y + 1.5, z: target.z + 4.5 }, target, 40, targetItem?.id),
      ];
    case 'crane-rise':
      return [
        cameraKeyframe(id('start'), 0, { x: target.x + 4, y: target.y + 0.4, z: target.z + 5 }, target, 48),
        cameraKeyframe(id('end'), duration, { x: target.x + 2, y: target.y + 8, z: target.z + 2.5 }, target, 54),
      ];
    case 'lateral-dolly':
      return [
        cameraKeyframe(id('start'), 0, { x: target.x - 6, y: target.y + 1, z: target.z + 5 }, target, 44),
        cameraKeyframe(id('end'), duration, { x: target.x + 6, y: target.y + 1, z: target.z + 5 }, target, 44),
      ];
  }
}

export function createClipFromActionTrack(
  name: string,
  track: DirectorActionKeyframe[],
): DirectorActionClip | null {
  if (track.length === 0) return null;
  const sorted = sortKeyframes([...track]);
  const firstTime = sorted[0].time;
  const keyframes = sorted.map((keyframe) => ({
    ...keyframe,
    id: createDirectorMotionId('clip-frame'),
    time: keyframe.time - firstTime,
  }));
  return {
    id: createDirectorMotionId('clip'),
    name: name.trim() || 'Custom clip',
    durationSeconds: Math.max(DIRECTOR_MOTION_MIN_DURATION_SECONDS, keyframes[keyframes.length - 1].time),
    loop: false,
    keyframes,
  };
}

export function upsertDirectorKeyframe<T extends { id: string; time: number }>(track: T[], keyframe: T): T[] {
  const existingIndex = track.findIndex((candidate) => candidate.id === keyframe.id);
  const next = existingIndex >= 0
    ? track.map((candidate, index) => index === existingIndex ? keyframe : candidate)
    : [...track, keyframe];
  return sortKeyframes(next);
}

export function findKeyframeNearTime<T extends { time: number }>(track: T[], time: number, epsilon = 0.025): T | null {
  return track.find((keyframe) => Math.abs(keyframe.time - time) <= epsilon) ?? null;
}
