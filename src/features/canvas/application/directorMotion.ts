import * as THREE from 'three';

import type {
  BlueprintActionPose,
  BlueprintBodyControls,
  BlueprintItem,
  DirectorActionClip,
  DirectorActionClipKeyframe,
  DirectorCameraRig,
  DirectorCameraRigBodyPart,
  DirectorCameraRigKind,
  DirectorActionKeyframe,
  DirectorActionState,
  DirectorCameraKeyframe,
  DirectorMotionEasing,
  DirectorMotionProjectV1,
  DirectorMotionVector3,
  DirectorObjectKeyframe,
} from '@/features/canvas/domain/canvasNodes';
import { ensurePos3d } from '@/features/canvas/ui/blueprintCoordinates';
import {
  interpolatePersonPose,
  normalizePersonPose,
  overlayPersonPose,
} from '@/features/canvas/domain/personPose';
import { PERSON_POSE_MAP, resolvePersonActionPose, samplePersonAction } from './personMotionLibrary';

export const DIRECTOR_MOTION_SCHEMA_VERSION = 1 as const;
export const DIRECTOR_MOTION_DEFAULT_DURATION_SECONDS = 8;
export const DIRECTOR_MOTION_MIN_DURATION_SECONDS = 0.5;
export const DIRECTOR_MOTION_MAX_DURATION_SECONDS = 120;

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
  freeRotation?: DirectorMotionVector3;
  /** Set when a live rig, not keyframes, produced this camera. */
  rigId?: string;
}

export interface SampledDirectorMotionFrame {
  time: number;
  camera: SampledDirectorCameraState | null;
  objects: Record<string, SampledDirectorObjectState>;
  actions: Record<string, SampledDirectorActionState>;
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
  | 'lateral-dolly'
  | 'follow-actor-route';

export const DIRECTOR_CAMERA_PRESETS: readonly DirectorCameraPresetDefinition[] = [
  { id: 'cinematic-push', labelKey: 'directorStudio.motion.cameraPresets.cinematicPush' },
  { id: 'character-follow', labelKey: 'directorStudio.motion.cameraPresets.characterFollow' },
  { id: 'fast-chase', labelKey: 'directorStudio.motion.cameraPresets.fastChase' },
  { id: 'product-orbit', labelKey: 'directorStudio.motion.cameraPresets.productOrbit' },
  { id: 'crane-rise', labelKey: 'directorStudio.motion.cameraPresets.craneRise' },
  { id: 'lateral-dolly', labelKey: 'directorStudio.motion.cameraPresets.lateralDolly' },
  { id: 'follow-actor-route', labelKey: 'directorStudio.motion.cameraPresets.followActorRoute' },
] as const;

type DirectorCameraRigParams = Omit<DirectorCameraRig, 'id' | 'kind' | 'targetId' | 'start' | 'end'>;

/** Starting framings: over-the-shoulder follow, and a frontal head close-up. */
export const DIRECTOR_CAMERA_RIG_DEFAULTS: Readonly<Record<DirectorCameraRigKind, DirectorCameraRigParams>> = {
  follow: { bodyPart: 'torso', distance: 4.2, height: 1.05, azimuthDeg: 0, pitchDeg: 0, fov: 42, damping: 0.35, relative: true, lockHorizon: false },
  closeup: { bodyPart: 'head', distance: 1.3, height: 0.05, azimuthDeg: 180, pitchDeg: 0, fov: 28, damping: 0.2, relative: true, lockHorizon: false },
};

export const DIRECTOR_CAMERA_RIG_LIMITS = {
  distance: [0.3, 30],
  height: [-5, 15],
  azimuthDeg: [-180, 180],
  pitchDeg: [-60, 60],
  fov: [8, 120],
  damping: [0, 0.95],
} as const satisfies Record<string, readonly [number, number]>;

const RIG_BODY_PARTS: readonly DirectorCameraRigBodyPart[] = ['head', 'torso', 'feet'];
/** Lag window: 24 samples at 15 Hz ≈ 1.6 s of subject history. */
const RIG_LAG_STEP_SECONDS = 1 / 15;
const RIG_LAG_SAMPLES = 24;
/** Shortest clip the timeline allows (spec 05 §4.5), so a dragged-in trim never collapses an interval. */
export const DIRECTOR_TIMELINE_MIN_CLIP_SECONDS = 0.2;
export const DIRECTOR_CAMERA_RIG_MIN_SECONDS = DIRECTOR_TIMELINE_MIN_CLIP_SECONDS;

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
  return value === 'smooth' || value === 'hold' ? value : 'linear';
}

function normalizeEasingRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [start, end] = value;
  return typeof start === 'number' && typeof end === 'number'
    && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= 1 && start < end
    ? [start, end] : undefined;
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
    ...(typeof record.actionOffsetSeconds === 'number' && Number.isFinite(record.actionOffsetSeconds)
      ? { actionOffsetSeconds: record.actionOffsetSeconds } : {}),
    pose: normalizePersonPose(record.pose),
    bodyControls: normalizeBodyControls(record.bodyControls),
  };
}

function normalizeCameraRigs(value: unknown, duration: number): DirectorCameraRig[] {
  if (!Array.isArray(value)) return [];
  const limit = (key: keyof typeof DIRECTOR_CAMERA_RIG_LIMITS, raw: unknown, fallback: number) => {
    const [min, max] = DIRECTOR_CAMERA_RIG_LIMITS[key];
    return clamp(finiteNumber(raw, fallback), min, max);
  };
  return value.flatMap((entry, index) => {
    const record = asRecord(entry);
    const targetId = typeof record?.targetId === 'string' && record.targetId.trim() ? record.targetId : null;
    if (!record || !targetId) return [];
    const kind: DirectorCameraRigKind = record.kind === 'closeup' ? 'closeup' : 'follow';
    const defaults = DIRECTOR_CAMERA_RIG_DEFAULTS[kind];
    const start = clamp(finiteNumber(record.start, 0), 0, Math.max(0, duration - DIRECTOR_CAMERA_RIG_MIN_SECONDS));
    const end = clamp(finiteNumber(record.end, duration), start + DIRECTOR_CAMERA_RIG_MIN_SECONDS, duration);
    const priority = typeof record.priority === 'number' && Number.isFinite(record.priority) ? Math.max(0, Math.round(record.priority)) : 0;
    return [{
      id: normalizeId(record.id, `rig-${index}`),
      kind,
      targetId,
      bodyPart: RIG_BODY_PARTS.find((part) => part === record.bodyPart) ?? defaults.bodyPart,
      start,
      end,
      distance: limit('distance', record.distance, defaults.distance),
      height: limit('height', record.height, defaults.height),
      azimuthDeg: limit('azimuthDeg', record.azimuthDeg, defaults.azimuthDeg),
      pitchDeg: limit('pitchDeg', record.pitchDeg, defaults.pitchDeg),
      fov: limit('fov', record.fov, defaults.fov),
      damping: limit('damping', record.damping, defaults.damping),
      relative: typeof record.relative === 'boolean' ? record.relative : defaults.relative,
      lockHorizon: record.lockHorizon === true,
      ...(priority > 0 ? { priority } : {}),
    }];
  });
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
      ...(normalizeEasingRange(record.easingRange) ? { easingRange: normalizeEasingRange(record.easingRange) } : {}),
      position: normalizeVector3(record.position, { x: 0, y: 2, z: 8 }),
      target: normalizeVector3(record.target, { x: 0, y: 1, z: 0 }),
      fov: clamp(finiteNumber(record.fov, 45), 10, 150),
      trackTargetId: typeof record.trackTargetId === 'string' ? record.trackTargetId : null,
      trackTargetBodyPart: typeof record.trackTargetBodyPart === 'string' ? record.trackTargetBodyPart : null,
      ...(asRecord(record.freeRotation) ? { freeRotation: normalizeVector3(record.freeRotation, { x: 0, y: 0, z: 0 }) } : {}),
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
      ...(normalizeEasingRange(record.easingRange) ? { easingRange: normalizeEasingRange(record.easingRange) } : {}),
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
      ...(normalizeEasingRange(record.easingRange) ? { easingRange: normalizeEasingRange(record.easingRange) } : {}),
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
          ...(normalizeEasingRange(keyframe.easingRange) ? { easingRange: normalizeEasingRange(keyframe.easingRange) } : {}),
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
    cameraRigs: [],
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
    cameraRigs: normalizeCameraRigs(record?.cameraRigs, durationSeconds),
  };
}

function easeProgress(progress: number, easing: DirectorMotionEasing): number {
  const t = clamp(progress, 0, 1);
  if (easing === 'hold') return t >= 1 ? 1 : 0;
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
  // Quaternion round-tripping reparameterizes Euler angles at gimbal lock and
  // loses the authored roll channel even when sampling an exact keyframe.
  if (amount <= 0) return { ...from };
  if (amount >= 1) return { ...to };
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

function findSegment<T extends { time: number; easing: DirectorMotionEasing; easingRange?: [number, number] }>(track: T[], time: number): Segment<T> | null {
  if (track.length === 0) return null;
  if (track.length === 1 || time <= track[0].time) {
    return { from: track[0], to: track[0], amount: 0, rawAmount: 0, fromIndex: 0, toIndex: 0 };
  }
  const lastIndex = track.length - 1;
  if (time >= track[lastIndex].time) {
    return { from: track[lastIndex], to: track[lastIndex], amount: 0, rawAmount: 0, fromIndex: lastIndex, toIndex: lastIndex };
  }
  const toIndex = track.findIndex((keyframe) => keyframe.time >= time);
  if (track[toIndex].time === time) {
    return { from: track[toIndex], to: track[toIndex], amount: 0, rawAmount: 0, fromIndex: toIndex, toIndex };
  }
  const fromIndex = Math.max(0, toIndex - 1);
  const from = track[fromIndex];
  const to = track[toIndex];
  const rawAmount = (time - from.time) / Math.max(0.000001, to.time - from.time);
  const [rangeStart, rangeEnd] = to.easingRange ?? [0, 1];
  const lower = easeProgress(rangeStart, to.easing);
  const upper = easeProgress(rangeEnd, to.easing);
  const eased = easeProgress(rangeStart + rawAmount * (rangeEnd - rangeStart), to.easing);
  return {
    from,
    to,
    rawAmount,
    amount: upper > lower ? (eased - lower) / (upper - lower) : 0,
    fromIndex,
    toIndex,
  };
}

function sampleActionState(
  state: DirectorActionState,
  elapsedSeconds: number,
  customClips: DirectorActionClip[],
): SampledDirectorActionState {
  elapsedSeconds += state.actionOffsetSeconds ?? 0;
  if (state.clipId) {
    const clip = customClips.find((candidate) => candidate.id === state.clipId);
    if (clip && clip.keyframes.length > 0) {
      const clipTime = clip.loop
        ? ((elapsedSeconds % clip.durationSeconds) + clip.durationSeconds) % clip.durationSeconds
        : clamp(elapsedSeconds, 0, clip.durationSeconds);
      const sampled = sampleActionTrack(clip.keyframes, clipTime, customClips);
      return {
        ...sampled,
        ...state,
        pose: overlayPersonPose(sampled.pose, state.pose),
        bodyControls: state.bodyControls ?? sampled.bodyControls,
        clipId: clip.id,
      };
    }
  }
  const basePose = state.actionId
    ? samplePersonAction(state.actionId, elapsedSeconds)
    : state.poseId ? PERSON_POSE_MAP[state.poseId] : undefined;
  return { ...state, pose: overlayPersonPose(basePose, state.pose) };
}

function sampleActionTrack(
  track: Array<DirectorActionKeyframe | DirectorActionClipKeyframe>,
  time: number,
  customClips: DirectorActionClip[],
  crossfadeDynamic = false,
): SampledDirectorActionState {
  const segment = findSegment(track, time);
  if (!segment) return {};
  const elapsed = Math.max(0, time - segment.from.time);
  const from = sampleActionState(segment.from, elapsed, customClips);
  if (segment.from === segment.to) return from;
  const dynamic = segment.from.actionId || segment.from.clipId;
  let amount = segment.amount;
  if (dynamic) {
    // Clip splitting preserves its original easing ranges and procedural phase.
    // Blend only scene-level actions; placed and nested clips remain exact.
    if (!crossfadeDynamic || segment.from.clipId || segment.to.easing === 'hold' || segment.to.easingRange) return from;
    const fadeDuration = Math.min(0.25, (segment.to.time - segment.from.time) / 2);
    const remaining = segment.to.time - time;
    if (remaining >= fadeDuration) return from;
    amount = easeProgress(1 - remaining / fadeDuration, 'smooth');
  }
  const to = sampleActionState(segment.to, 0, customClips);
  return {
    ...from,
    pose: interpolatePersonPose(from.pose, to.pose, amount),
  };
}

function sampleObjectTrack(track: DirectorObjectKeyframe[], time: number): SampledDirectorObjectState | null {
  const segment = findSegment(track, time);
  if (!segment) return null;
  const { from, to, amount } = segment;
  let rotation = slerpEuler(from.rotation, to.rotation, amount);
  if (from.orientToPath || to.orientToPath) {
    const headingAt = (index: number) => {
      const previous = track[Math.max(0, index - 1)].position;
      const next = track[Math.min(track.length - 1, index + 1)].position;
      const dx = next.x - previous.x;
      const dz = next.z - previous.z;
      return dx * dx + dz * dz > 0.000001 ? Math.atan2(dx, dz) : null;
    };
    const fromYaw = from.orientToPath ? (headingAt(segment.fromIndex) ?? 0) + from.rotation.y : from.rotation.y;
    const toYaw = to.orientToPath ? (headingAt(segment.toIndex) ?? 0) + to.rotation.y : to.rotation.y;
    rotation = slerpEuler({ ...from.rotation, y: fromYaw }, { ...to.rotation, y: toYaw }, amount);
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
  const freeRotation = from.freeRotation && to.freeRotation
    ? slerpEuler(from.freeRotation, to.freeRotation, amount)
    : (amount < 0.5 ? from.freeRotation : to.freeRotation);
  const trackTargetId = freeRotation ? null : amount < 0.5 ? from.trackTargetId : to.trackTargetId;
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
  const position = lerpVector(from.position, to.position, amount);
  if (freeRotation) {
    const forward = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(freeRotation.x, freeRotation.y, freeRotation.z, 'XYZ'));
    target = { x: position.x + forward.x, y: position.y + forward.y, z: position.z + forward.z };
  }
  return {
    position,
    target,
    fov: lerpNumber(from.fov, to.fov, amount),
    trackTargetId,
    trackTargetBodyPart,
    ...(freeRotation ? { freeRotation } : {}),
  };
}

/** Subject transform at `time` from its own route only (rigs never depend on other rigs or the camera). */
function sampleRigSubject(project: DirectorMotionProjectV1, item: BlueprintItem, time: number): SampledDirectorObjectState {
  const track = project.objectTracks[item.id];
  return (track && sampleObjectTrack(track, time)) ?? getBaseObjectState(item);
}

function rigAimPoint(rig: DirectorCameraRig, subject: SampledDirectorObjectState): DirectorMotionVector3 {
  const offset = getBodyPartOffset(rig.bodyPart);
  return { x: subject.position.x + offset.x, y: subject.position.y + offset.y, z: subject.position.z + offset.z };
}

/** Undamped camera position for the rig at one instant. */
function rigCameraPosition(rig: DirectorCameraRig, subject: SampledDirectorObjectState, horizonY: number | null): DirectorMotionVector3 {
  const aim = rigAimPoint(rig, subject);
  // Persons face local +Z, so heading h looks along (sin h, cos h); azimuth 0 sits behind them.
  const heading = rig.relative ? subject.rotation.y : 0;
  const angle = heading + Math.PI + THREE.MathUtils.degToRad(rig.azimuthDeg);
  return {
    x: aim.x + Math.sin(angle) * rig.distance,
    y: horizonY ?? aim.y + rig.height,
    z: aim.z + Math.cos(angle) * rig.distance,
  };
}

/**
 * Live follow / close-up camera. Damping is a deterministic exponentially weighted average of the
 * subject-driven position over the recent past, so scrubbing, playback and export all agree.
 */
export function sampleDirectorCameraRig(
  project: DirectorMotionProjectV1,
  rig: DirectorCameraRig,
  time: number,
  item: BlueprintItem,
): SampledDirectorCameraState {
  const horizonY = rig.lockHorizon ? rigAimPoint(rig, sampleRigSubject(project, item, rig.start)).y + rig.height : null;
  let weightSum = 0;
  const position = { x: 0, y: 0, z: 0 };
  const samples = rig.damping > 0 ? RIG_LAG_SAMPLES : 1;
  for (let index = 0; index < samples; index += 1) {
    const weight = rig.damping ** index;
    if (weight < 0.002) break;
    const sampleTime = Math.max(rig.start, time - index * RIG_LAG_STEP_SECONDS);
    const sample = rigCameraPosition(rig, sampleRigSubject(project, item, sampleTime), horizonY);
    position.x += sample.x * weight;
    position.y += sample.y * weight;
    position.z += sample.z * weight;
    weightSum += weight;
  }
  position.x /= weightSum;
  position.y /= weightSum;
  position.z /= weightSum;
  const aim = rigAimPoint(rig, sampleRigSubject(project, item, time));
  const horizontal = Math.hypot(aim.x - position.x, aim.z - position.z);
  return {
    position,
    target: { x: aim.x, y: aim.y + Math.tan(THREE.MathUtils.degToRad(rig.pitchDeg)) * Math.max(0.1, horizontal), z: aim.z },
    fov: rig.fov,
    trackTargetId: rig.targetId,
    trackTargetBodyPart: rig.bodyPart,
    rigId: rig.id,
  };
}

/** Higher explicit priority first; on a tie the later start, then the later rig, wins. */
function rigOutranks(candidate: DirectorCameraRig, current: DirectorCameraRig): boolean {
  const candidatePriority = candidate.priority ?? 0;
  const currentPriority = current.priority ?? 0;
  if (candidatePriority !== currentPriority) return candidatePriority > currentPriority;
  return candidate.start >= current.start;
}

/** The rig covering `time`; overlaps resolve by explicit priority, then the latest start. */
export function findActiveDirectorCameraRig(project: DirectorMotionProjectV1, time: number): DirectorCameraRig | null {
  let active: DirectorCameraRig | null = null;
  for (const rig of project.cameraRigs) {
    if (time < rig.start || time > rig.end) continue;
    if (!active || rigOutranks(rig, active)) active = rig;
  }
  return active;
}

export interface DirectorCameraRigCoverage {
  rigId: string;
  start: number;
  end: number;
}

/** Intervals where each rig actually drives the camera, in time order; adjacent pieces of one rig merge. */
export function resolveDirectorCameraRigCoverage(project: DirectorMotionProjectV1): DirectorCameraRigCoverage[] {
  const bounds = [...new Set(project.cameraRigs.flatMap((rig) => [rig.start, rig.end]))].sort((a, b) => a - b);
  const coverage: DirectorCameraRigCoverage[] = [];
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const start = bounds[index];
    const end = bounds[index + 1];
    const winner = findActiveDirectorCameraRig(project, (start + end) / 2);
    if (!winner) continue;
    const previous = coverage[coverage.length - 1];
    if (previous && previous.rigId === winner.id && Math.abs(previous.end - start) < 1e-9) previous.end = end;
    else coverage.push({ rigId: winner.id, start, end });
  }
  return coverage;
}

function requireCameraRig(project: DirectorMotionProjectV1, rigId: string): DirectorCameraRig {
  const rig = project.cameraRigs.find((entry) => entry.id === rigId);
  if (!rig) throw new Error(`Camera rig ${rigId} does not exist.`);
  return rig;
}

function topCameraRigPriority(project: DirectorMotionProjectV1, exceptId?: string): number {
  return project.cameraRigs.reduce((top, rig) => rig.id === exceptId ? top : Math.max(top, rig.priority ?? 0), 0);
}

/**
 * Make a rig win wherever it overlaps others. Returns the same project when it already wins its
 * whole interval, so callers can skip recording an empty undo step.
 */
export function bringDirectorCameraRigToFront(project: DirectorMotionProjectV1, rigId: string): DirectorMotionProjectV1 {
  const rig = requireCameraRig(project, rigId);
  const overridden = resolveDirectorCameraRigCoverage(project)
    .some((entry) => entry.rigId !== rigId && entry.start < rig.end && entry.end > rig.start);
  if (!overridden) return project;
  const priority = topCameraRigPriority(project, rigId) + 1;
  return { ...project, cameraRigs: project.cameraRigs.map((entry) => entry.id === rigId ? { ...entry, priority } : entry) };
}

/** Cut a rig at scene time `time`; the left part keeps its id, both parts keep parameters and layer. */
export function splitDirectorCameraRig(
  project: DirectorMotionProjectV1,
  rigId: string,
  time: number,
): { project: DirectorMotionProjectV1; leftId: string; rightId: string } {
  const rig = requireCameraRig(project, rigId);
  if (!Number.isFinite(time) || time - rig.start < DIRECTOR_CAMERA_RIG_MIN_SECONDS - 1e-9 || rig.end - time < DIRECTOR_CAMERA_RIG_MIN_SECONDS - 1e-9) {
    throw new Error(`Both split rigs must be at least ${DIRECTOR_CAMERA_RIG_MIN_SECONDS} seconds.`);
  }
  const rightId = createDirectorMotionId(`rig-${rig.kind}`);
  const cameraRigs = project.cameraRigs.flatMap((entry) => entry.id === rigId
    ? [{ ...entry, end: time }, { ...entry, id: rightId, start: time }]
    : [entry]);
  return { project: { ...project, cameraRigs }, leftId: rigId, rightId };
}

/** Copy a rig to start at `start` (clamped inside the shot); the copy lands in front of every rig. */
export function duplicateDirectorCameraRig(
  project: DirectorMotionProjectV1,
  rigId: string,
  start: number,
): { project: DirectorMotionProjectV1; rigId: string } {
  const rig = requireCameraRig(project, rigId);
  const span = rig.end - rig.start;
  const nextStart = clamp(Number.isFinite(start) ? start : rig.start, 0, Math.max(0, project.durationSeconds - span));
  const copy: DirectorCameraRig = {
    ...rig,
    id: createDirectorMotionId(`rig-${rig.kind}`),
    start: nextStart,
    end: Math.min(project.durationSeconds, nextStart + span),
    priority: topCameraRigPriority(project) + 1,
  };
  return { project: { ...project, cameraRigs: [...project.cameraRigs, copy] }, rigId: copy.id };
}

/** Move or trim a rig in scene seconds, keeping it inside the shot and at least the minimum length. */
export function retimeDirectorCameraRig(project: DirectorMotionProjectV1, rigId: string, start: number, end: number): DirectorMotionProjectV1 {
  requireCameraRig(project, rigId);
  const nextStart = clamp(start, 0, Math.max(0, project.durationSeconds - DIRECTOR_CAMERA_RIG_MIN_SECONDS));
  const nextEnd = clamp(end, nextStart + DIRECTOR_CAMERA_RIG_MIN_SECONDS, project.durationSeconds);
  return { ...project, cameraRigs: project.cameraRigs.map((entry) => entry.id === rigId ? { ...entry, start: nextStart, end: nextEnd } : entry) };
}

/**
 * Cut a person's procedural action (walk, run …) at scene time `time`. The new hold frame resumes the
 * same phase, so playback is unchanged until either half is edited. Placed library clips split via
 * `splitDirectorMotionClip` instead.
 */
export function splitDirectorActionSegment(
  project: DirectorMotionProjectV1,
  itemId: string,
  time: number,
): { project: DirectorMotionProjectV1; keyframeId: string } {
  const track = project.actionTracks[itemId] ?? [];
  let index = -1;
  for (let cursor = 0; cursor < track.length && track[cursor].time <= time; cursor += 1) index = cursor;
  const from = track[index];
  if (!from?.actionId || from.clipId) throw new Error('No procedural action covers this time.');
  const end = track[index + 1]?.time ?? project.durationSeconds;
  if (!Number.isFinite(time) || time - from.time < DIRECTOR_TIMELINE_MIN_CLIP_SECONDS - 1e-9 || end - time < DIRECTOR_TIMELINE_MIN_CLIP_SECONDS - 1e-9) {
    throw new Error(`Both split actions must be at least ${DIRECTOR_TIMELINE_MIN_CLIP_SECONDS} seconds.`);
  }
  const frame: DirectorActionKeyframe = {
    ...from,
    id: createDirectorMotionId('action-split'),
    time,
    easing: 'hold',
    easingRange: undefined,
    actionOffsetSeconds: (from.actionOffsetSeconds ?? 0) + time - from.time,
  };
  return {
    project: { ...project, actionTracks: { ...project.actionTracks, [itemId]: sortKeyframes([...track, frame]) } },
    keyframeId: frame.id,
  };
}

function sampleCamera(
  project: DirectorMotionProjectV1,
  time: number,
  objects: Record<string, SampledDirectorObjectState>,
  itemsById: Map<string, BlueprintItem>,
): SampledDirectorCameraState | null {
  const rig = findActiveDirectorCameraRig(project, time);
  const subject = rig ? itemsById.get(rig.targetId) : undefined;
  if (rig && subject) return sampleDirectorCameraRig(project, rig, time, subject);
  return sampleCameraTrack(project.cameraTrack, time, objects, itemsById);
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
  items.forEach((item) => {
    const pose = overlayPersonPose(resolvePersonActionPose(item.action), normalizePersonPose(item.pose));
    if (pose || item.bodyControls) actions[item.id] = { poseId: item.action, pose, bodyControls: item.bodyControls };
  });
  Object.entries(project.actionTracks).forEach(([itemId, track]) => {
    if (track.length > 0) actions[itemId] = sampleActionTrack(track, time, project.customClips, true);
  });
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return {
    time,
    camera: sampleCamera(project, time, objects, itemsById),
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

/** Convert authored floor points to evenly paced V1 keyframes by travelled distance. */
export function timeDirectorRoutePoints(
  points: readonly DirectorMotionVector3[],
  startTime: number,
  durationSeconds: number,
): Array<{ position: DirectorMotionVector3; time: number }> {
  const valid: DirectorMotionVector3[] = [];
  for (const point of points) {
    if (![point.x, point.y, point.z].every(Number.isFinite)) continue;
    const previous = valid[valid.length - 1];
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) < 0.04) continue;
    valid.push({ x: point.x, y: point.y, z: point.z });
  }
  if (valid.length < 2) return [];

  // Freehand strokes can contain hundreds of pointer samples. Bound the saved
  // track while retaining the clicked endpoints and distance-based timing.
  const cumulative = [0];
  for (let index = 1; index < valid.length; index += 1) {
    const a = valid[index - 1];
    const b = valid[index];
    cumulative.push(cumulative[index - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  const totalDistance = cumulative[cumulative.length - 1];
  if (totalDistance <= 0) return [];
  const route = valid.length <= 48 ? valid : Array.from({ length: 48 }, (_, index) => {
    const targetDistance = totalDistance * index / 47;
    let segment = 1;
    while (segment < cumulative.length - 1 && cumulative[segment] < targetDistance) segment += 1;
    const from = valid[segment - 1];
    const to = valid[segment];
    const fraction = (targetDistance - cumulative[segment - 1]) / Math.max(0.000001, cumulative[segment] - cumulative[segment - 1]);
    return lerpVector(from, to, fraction);
  });
  const routeStart = clamp(finiteNumber(startTime, 0), 0, durationSeconds);
  const remaining = Math.max(0, durationSeconds - routeStart);
  if (remaining <= 0.001) return [];
  const savedDistance = route.slice(1).reduce((sum, point, index) => {
    const previous = route[index];
    return sum + Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z);
  }, 0);
  let distance = 0;
  return route.map((position, index) => {
    if (index > 0) {
      const previous = route[index - 1];
      distance += Math.hypot(position.x - previous.x, position.y - previous.y, position.z - previous.z);
    }
    return { position, time: routeStart + remaining * distance / savedDistance };
  });
}

/** Move or stretch a whole authored track while keeping its spatial keyframes intact. */
export function retimeDirectorTrack<T extends { time: number }>(
  track: readonly T[],
  startTime: number,
  endTime: number,
  durationSeconds: number,
): T[] {
  if (track.length < 2 || ![startTime, endTime, durationSeconds].every(Number.isFinite)) return [...track];
  const first = track[0].time;
  const last = track[track.length - 1].time;
  if (last - first < 0.001 || durationSeconds < 0.1) return [...track];
  const minimumSpan = Math.min(0.1, durationSeconds);
  const nextStart = clamp(startTime, 0, durationSeconds - minimumSpan);
  const nextEnd = clamp(endTime, nextStart + minimumSpan, durationSeconds);
  return track.map((keyframe) => ({
    ...keyframe,
    time: nextStart + (keyframe.time - first) / (last - first) * (nextEnd - nextStart),
  }));
}

export function createDirectorObjectRouteTrack(
  points: readonly DirectorMotionVector3[],
  item: BlueprintItem,
  startTime: number,
  durationSeconds: number,
): DirectorObjectKeyframe[] {
  const base = createObjectKeyframeFromItem(item, 0);
  return timeDirectorRoutePoints(points, startTime, durationSeconds).map(({ position, time }) => ({
    ...base,
    id: createDirectorMotionId('object-route'),
    time,
    // Timing already accounts for distance; smoothing every short segment
    // would bring the actor to a stop at each point in a freehand stroke.
    easing: 'linear',
    position,
    orientToPath: true,
  }));
}

export function createDirectorCameraRouteTrack(
  points: readonly DirectorMotionVector3[],
  camera: { target: DirectorMotionVector3; fov: number; trackTargetId?: string | null; trackTargetBodyPart?: string | null; freeRotation?: DirectorMotionVector3 },
  startTime: number,
  durationSeconds: number,
): DirectorCameraKeyframe[] {
  return timeDirectorRoutePoints(points, startTime, durationSeconds).map(({ position, time }) => ({
    id: createDirectorMotionId('camera-route'),
    time,
    easing: 'linear',
    position,
    target: { ...camera.target },
    fov: camera.fov,
    trackTargetId: camera.trackTargetId ?? null,
    trackTargetBodyPart: camera.trackTargetBodyPart ?? null,
    ...(camera.freeRotation ? { freeRotation: { ...camera.freeRotation } } : {}),
  }));
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
  targetRoute?: readonly DirectorObjectKeyframe[],
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
    case 'follow-actor-route': {
      const route = targetRoute && targetRoute.length >= 2
        ? targetRoute
        : [
            { time: 0, position: targetPosition },
            { time: duration, position: targetPosition },
          ];
      let previousOffset: { x: number; z: number } | null = null;
      return route.map((frame, index) => {
        const previous = route[Math.max(0, index - 1)].position;
        const next = route[Math.min(route.length - 1, index + 1)].position;
        const incoming = { x: frame.position.x - previous.x, z: frame.position.z - previous.z };
        const outgoing = { x: next.x - frame.position.x, z: next.z - frame.position.z };
        const incomingLength = Math.hypot(incoming.x, incoming.z);
        const outgoingLength = Math.hypot(outgoing.x, outgoing.z);
        const isReversal = incomingLength > 0.001 && outgoingLength > 0.001
          && (incoming.x * outgoing.x + incoming.z * outgoing.z) / (incomingLength * outgoingLength) < -0.8;
        const yaw = Math.atan2(next.x - previous.x, next.z - previous.z);
        // At a U-turn the averaged tangent collapses to zero. Keep the
        // lateral waypoint on the side nearest the previous camera offset,
        // including when the actor reverses more than once.
        const lateral = isReversal
          ? { x: incoming.z / incomingLength * 4.2, z: -incoming.x / incomingLength * 4.2 }
          : null;
        const behind = lateral
          ? previousOffset && lateral.x * previousOffset.x + lateral.z * previousOffset.z < 0
            ? { x: -lateral.x, z: -lateral.z }
            : lateral
          : { x: -Math.sin(yaw) * 4.2, z: -Math.cos(yaw) * 4.2 };
        previousOffset = behind;
        return {
          ...cameraKeyframe(
            id(String(index)),
            clamp(frame.time, 0, duration),
            { x: frame.position.x + behind.x, y: frame.position.y + 2.1, z: frame.position.z + behind.z },
            { x: frame.position.x, y: frame.position.y + 1.05, z: frame.position.z },
            42,
            targetItem?.id,
          ),
          easing: 'linear' as const,
          trackTargetBodyPart: 'torso',
        };
      });
    }
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

/** Split library clips in local seconds. Caller converts scene time explicitly. */
export function splitDirectorMotionClip(
  project: DirectorMotionProjectV1,
  clipId: string,
  localTime: number,
): { project: DirectorMotionProjectV1; leftId: string; rightId: string } {
  const clip = project.customClips.find((entry) => entry.id === clipId);
  if (!clip) throw new Error(`Clip ${clipId} does not exist.`);
  if (!Number.isFinite(localTime) || localTime < 0.5 || clip.durationSeconds - localTime < 0.5) {
    throw new Error('Both split clips must be at least 0.5 seconds.');
  }
  const referenced = [...Object.values(project.actionTracks).flat(), ...project.customClips.flatMap((entry) => entry.keyframes)]
    .some((frame) => frame.clipId === clipId);
  if (clip.loop && referenced) throw new Error('Unloop a placed clip before splitting it.');
  const segment = findSegment(clip.keyframes, localTime);
  const sampled = sampleActionTrack(clip.keyframes, localTime, project.customClips);
  const from = segment?.from;
  const to = segment?.to;
  const [start, end] = to?.easingRange ?? [0, 1];
  const midpoint = start + (segment?.rawAmount ?? 0) * (end - start);
  const crossing = from && to && from !== to && localTime > from.time && localTime < to.time;
  const boundary: DirectorActionClipKeyframe = {
    ...sampled,
    // A procedural boundary keeps only the authored overlay, not its sampled
    // moving joints, which would otherwise freeze the right-hand split clip.
    ...((from?.actionId || from?.clipId) ? { pose: from.pose } : {}),
    id: createDirectorMotionId('split-frame'), time: localTime, easing: to?.easing ?? 'linear',
    ...(crossing ? { easingRange: [start, midpoint] as [number, number] } : {}),
    ...((from?.actionId || from?.clipId) ? {
      actionOffsetSeconds: (from.actionOffsetSeconds ?? 0) + localTime - from.time,
    } : {}),
  };
  const left: DirectorActionClip = {
    ...clip, durationSeconds: localTime,
    keyframes: [...clip.keyframes.filter((frame) => frame.time < localTime), boundary],
  };
  const rightId = createDirectorMotionId('clip');
  const right: DirectorActionClip = {
    ...clip, id: rightId, name: `${clip.name} (2)`, durationSeconds: clip.durationSeconds - localTime,
    keyframes: [
      { ...boundary, id: createDirectorMotionId('split-frame'), time: 0, easingRange: undefined },
      ...clip.keyframes.filter((frame) => frame.time > localTime).map((frame) => ({
        ...frame, id: createDirectorMotionId('split-frame'), time: frame.time - localTime,
        ...(crossing && frame === to ? { easingRange: [midpoint, end] as [number, number] } : {}),
      })),
    ],
  };
  const updatePlacements = <T extends DirectorActionClipKeyframe>(track: T[], duration: number): T[] => sortKeyframes(track.flatMap((frame, index) => {
    if (frame.clipId !== clipId) return [frame];
    const offset = frame.actionOffsetSeconds ?? 0;
    if (offset >= localTime) return [{ ...frame, clipId: rightId, actionOffsetSeconds: offset - localTime }];
    const time = frame.time + localTime - offset;
    if (time > duration || (track[index + 1] && track[index + 1].time <= time)) return [frame];
    return [frame, { ...frame, id: createDirectorMotionId('split-placement'), time, clipId: rightId, actionOffsetSeconds: 0 }];
  }));
  return {
    leftId: clipId, rightId,
    project: {
      ...project,
      customClips: project.customClips.flatMap((entry) => entry.id === clipId ? [left, right] : [{ ...entry, keyframes: updatePlacements(entry.keyframes, entry.durationSeconds) }]),
      actionTracks: Object.fromEntries(Object.entries(project.actionTracks).map(([id, track]) => [id, updatePlacements(track, project.durationSeconds)])),
    },
  };
}
