import * as THREE from 'three';
import type { BlueprintActionPose, BlueprintItem, DirectorCameraKeyframe, DirectorMotionVector3 } from '@/features/canvas/domain/canvasNodes';
import { createEmptyDirectorMotionProject, sampleNormalizedDirectorMotion } from '@/features/canvas/application/directorMotion';
import { PERSON_ACTION_MAP, PERSON_POSE_MAP } from '@/features/canvas/application/personMotionLibrary';
import { overlayPersonPose, PERSON_JOINTS } from '@/features/canvas/domain/personPose';
import { normalizeBlueprintBodyControls } from '@/features/canvas/domain/directorStudioBodyControls';
import type { StageCommand, StageSnapshot } from '../domain/stage';
import { stageCommandSchema } from '../domain/stageSchemas';
import { storyPlanSchema, type StoryPlan, type StoryPosition, type StoryShot } from './storyPlan';
import { stageSceneCatalog } from './stageCatalogs';
import { prepareStageCommands } from './stageOperations';
import { replaceStageTrackRange, STAGE_RANGE_GUARD_SECONDS } from './stageRanges';

type Vector = DirectorMotionVector3;
export interface StoryWarning { code: 'walk-too-fast' | 'timing-adjusted' | 'existing-range-replaced' | 'estimated-bounds' | 'gaze-limit'; message: string; itemId?: string; start?: number }
export interface CompiledStory { commands: StageCommand[]; warnings: StoryWarning[]; durationSeconds: number; captureTimes: number[] }
export interface StoryBounds { min: Vector; max: Vector }
const zero = (): Vector => ({ x: 0, y: 0, z: 0 });
const vector = (v: Vector) => new THREE.Vector3(v.x, v.y, v.z);
const plain = (v: InstanceType<typeof THREE.Vector3>): Vector => ({ x: v.x, y: v.y, z: v.z });
const catalog = new Map(stageSceneCatalog().map((entry) => [entry.presetId, entry]));

/** Perspective fit of every bounds corner in camera space, including depth and portrait aspect. */
export function computeStoryFraming(bounds: StoryBounds, size: StoryShot['size'], fov: number, aspect: number, angle: StoryShot['angle'], azimuth = 0) {
  if (!(fov >= 10 && fov <= 150 && aspect > 0 && Number.isFinite(aspect))) throw new Error('Invalid framing optics.');
  const fraction = { 'extreme-wide': 1, wide: 1, full: 1, medium: 0.55, close: 0.25, 'extreme-close': 0.12 }[size];
  const margin = { 'extreme-wide': 2.5, wide: 1.65, full: 1.1, medium: 1.12, close: 1.15, 'extreme-close': 1.1 }[size];
  const top = bounds.max.y, bottom = top - (top - bounds.min.y) * fraction;
  const target = new THREE.Vector3((bounds.min.x + bounds.max.x) / 2, (bottom + top) / 2, (bounds.min.z + bounds.max.z) / 2);
  const elevation = { eye: 0, high: Math.PI / 6, low: -Math.PI / 12, overhead: Math.PI / 2 }[angle];
  const away = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
  const right = new THREE.Vector3(Math.cos(azimuth), 0, -Math.sin(azimuth));
  const up = new THREE.Vector3().crossVectors(away, right).normalize();
  const tanV = Math.tan(fov * Math.PI / 360), tanH = tanV * aspect;
  let fitDistance = 0.05;
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bottom, top]) for (const z of [bounds.min.z, bounds.max.z]) {
    const offset = new THREE.Vector3(x, y, z).sub(target), depth = offset.dot(away);
    fitDistance = Math.max(fitDistance, depth + Math.abs(offset.dot(up)) * margin / tanV, depth + Math.abs(offset.dot(right)) * margin / tanH);
  }
  return { position: plain(target.clone().addScaledVector(away, fitDistance)), target: plain(target), distance: fitDistance };
}

function rejectOverlaps(ranges: Array<{ start: number; end: number }>, label: string) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index++) if (sorted[index].start < sorted[index - 1].end - 1e-9) throw new Error(`Overlapping ${label} ranges.`);
}

/** Pure deterministic authoring: validates references and prepares the exact same commands used by real execution. */
export function compileStoryPlan(input: unknown, snapshot: StageSnapshot): CompiledStory {
  const plan: StoryPlan = storyPlanSchema.parse(input);
  const commands: StageCommand[] = [], warnings: StoryWarning[] = [];
  const ids = new Set<string>();
  const originalProject = snapshot.data.motionProject ?? createEmptyDirectorMotionProject();
  for (const frame of [...originalProject.cameraTrack, ...Object.values(originalProject.objectTracks).flat(), ...Object.values(originalProject.actionTracks).flat()]) ids.add(frame.id);
  let serial = 0;
  const makeId = (suffix: string) => { let id: string; do { id = `story-${snapshot.revision}-${serial++}-${suffix}`; } while (ids.has(id)); ids.add(id); return id; };
  commands.push({ type: 'playback.update', duration: plan.duration });
  const claimed = new Set<string>(), actors = new Set<string>();
  const claim = (id: string) => { if (claimed.has(id) || id === 'camera') throw new Error(`Duplicate or reserved plan item id ${id}.`); claimed.add(id); };
  for (const actor of plan.cast) {
    claim(actor.itemId); actors.add(actor.itemId);
    const existing = snapshot.data.items.find((item) => item.id === actor.itemId);
    if (actor.kind === 'existing') {
      if (!existing || existing.category !== 'person') throw new Error(`Cast item ${actor.itemId} is not an existing person.`);
    } else {
      if (existing) throw new Error(`New cast id ${actor.itemId} already exists.`);
      const height = catalog.get(actor.presetId)?.heightMeters;
      if (!height) throw new Error(`No registered height for ${actor.presetId}.`);
      const scale = actor.heightM / height;
      commands.push({ type: 'object.add', item: { id: actor.itemId, label: actor.label, x: 0, y: 0, color: '#94a3b8', category: 'person', presetId: actor.presetId, pos3d: actor.position ?? zero(), scale3d: { x: scale, y: scale, z: scale } } });
    }
  }
  for (const object of plan.setObjects) {
    claim(object.itemId);
    const entry = catalog.get(object.presetId);
    if (!entry || entry.category === 'person') throw new Error(`Invalid set preset ${object.presetId}.`);
    const patch = { label: object.label, category: entry.category, presetId: object.presetId, pos3d: object.position, rotation3d: object.rotation ?? zero(), scale3d: object.scale ?? { x: 1, y: 1, z: 1 } };
    const existing = snapshot.data.items.find((item) => item.id === object.itemId);
    if (existing?.category === 'person') throw new Error(`Set item ${object.itemId} would replace a person.`);
    commands.push(existing ? { type: 'object.update', itemId: object.itemId, patch } : { type: 'object.add', item: { id: object.itemId, x: 0, y: 0, color: '#94a3b8', ...patch } });
  }
  const marks = new Map<string, Vector>();
  for (const mark of plan.marks ?? []) { if (marks.has(mark.id)) throw new Error(`Duplicate mark ${mark.id}.`); marks.set(mark.id, mark.position); }
  rejectOverlaps(plan.shots.map((shot) => ({ start: shot.start, end: shot.start + shot.duration })), 'camera shot');
  for (const actorId of actors) rejectOverlaps(plan.beats.flatMap((beat) => beat.blocking.filter((block) => block.itemId === actorId).map(() => ({ start: beat.start, end: beat.start + beat.duration }))), `actor ${actorId}`);
  let working = prepareStageCommands(snapshot.data, commands).data;
  const sample = (time: number, data = working) => sampleNormalizedDirectorMotion(data.motionProject ?? createEmptyDirectorMotionProject(plan.duration), time, data.items);
  const resolve = (position: StoryPosition, time: number, data = working): Vector => {
    if ('x' in position) return position;
    let base: Vector | undefined;
    if ('markId' in position) base = marks.get(position.markId);
    else {
      if (!actors.has(position.actorId)) throw new Error(`Relative actor ${position.actorId} is not in cast.`);
      base = sample(time, data).objects[position.actorId]?.position;
    }
    if (!base) throw new Error(`Unknown position reference ${'markId' in position ? position.markId : position.actorId}.`);
    const offset = position.offset ?? zero();
    return { x: base.x + offset.x, y: base.y + offset.y, z: base.z + offset.z };
  };
  const append = (batch: StageCommand[]) => { working = prepareStageCommands(working, batch).data; commands.push(...batch); };
  const diffFrames = (before: DirectorCameraKeyframe[], after: DirectorCameraKeyframe[]): StageCommand[] => {
    const track = { kind: 'camera' as const };
    const result: StageCommand[] = [];
    for (const old of before) if (!after.some((frame) => frame.id === old.id)) result.push({ type: 'keyframe.remove', track, keyframeId: old.id });
    for (const frame of after) {
      const old = before.find((entry) => entry.id === frame.id);
      if (!old) result.push({ type: 'keyframe.add', track, keyframe: frame });
      else if (JSON.stringify(old) !== JSON.stringify(frame)) { const { id: _id, ...patch } = frame; result.push({ type: 'keyframe.update', track, keyframeId: frame.id, patch }); }
    }
    return result;
  };
  const heightOf = (item: BlueprintItem) => {
    const height = item.presetId ? catalog.get(item.presetId)?.heightMeters : undefined;
    if (!height) throw new Error(`Item ${item.id} needs a preset with registered metric height for framing.`);
    return height * (item.category === 'person' ? normalizeBlueprintBodyControls(item.bodyControls).core.height : 1);
  };
  for (const beat of [...plan.beats].sort((a, b) => a.start - b.start)) {
    const beatStart = working;
    const movements: StageCommand[] = [], performances: StageCommand[] = [];
    for (const block of beat.blocking) {
      if (!actors.has(block.itemId)) throw new Error(`Blocking actor ${block.itemId} is not in cast.`);
      const item = working.items.find((entry) => entry.id === block.itemId)!;
      const initial = sample(beat.start, beatStart).objects[block.itemId];
      const from = block.from ? resolve(block.from, beat.start, beatStart) : initial.position;
      const to = block.to ? resolve(block.to, beat.start, beatStart) : from;
      const length = Math.hypot(from.x - to.x, from.y - to.y, from.z - to.z), moving = length > 1e-6;
      const speed = block.travelSpeedMps ?? PERSON_ACTION_MAP[block.actionId ?? 'walk']?.travelSpeed ?? PERSON_ACTION_MAP.walk.travelSpeed!;
      const naturalDuration = length / speed;
      const moveDuration = Math.min(beat.duration, Math.max(0.2, naturalDuration));
      if (moving && Math.abs(moveDuration - naturalDuration) > 1e-9) warnings.push({ code: naturalDuration > beat.duration ? 'walk-too-fast' : 'timing-adjusted', itemId: item.id, start: beat.start, message: `Route ${length.toFixed(3)}m requires ${naturalDuration.toFixed(3)}s at ${speed}m/s; authored beat/minimum clip uses ${moveDuration.toFixed(3)}s (${(length / moveDuration).toFixed(3)}m/s). No beat times were shifted.` });
      const yaw = typeof block.facing === 'number' ? block.facing : block.facing ? (() => { const target = resolve(block.facing, beat.start, beatStart); return Math.atan2(target.x - from.x, target.z - from.z); })() : moving ? Math.atan2(to.x - from.x, to.z - from.z) : initial.rotation.y;
      const rotation = { ...initial.rotation, y: yaw };
      if (moving) movements.push({ type: 'trajectory.set', targetId: item.id, method: 'line', points: [from, to], start: beat.start, duration: moveDuration, holdEndUntil: plan.duration, rotation, orientToPath: false });
      else if (block.from || block.to || block.facing !== undefined) movements.push({ type: 'trajectory.set', targetId: item.id, method: 'line', points: [from, to], start: beat.start, duration: beat.duration, holdEndUntil: plan.duration, rotation, orientToPath: false });
      if ((originalProject.objectTracks[item.id] ?? []).some((frame) => frame.time >= beat.start) || (originalProject.actionTracks[item.id] ?? []).some((frame) => frame.time >= beat.start && frame.time <= beat.start + beat.duration)) warnings.push({ code: 'existing-range-replaced', itemId: item.id, start: beat.start, message: 'Authored blocking replaces existing transforms from this beat onward; performance replaces its explicit interval.' });
      const basePose = block.poseId ? PERSON_POSE_MAP[block.poseId] : undefined;
      const actionId = block.actionId ?? (moving ? 'walk' : undefined);
      if (actionId) performances.push({ type: 'person.action', itemId: item.id, actionId, start: beat.start, duration: block.actionId ? beat.duration : moveDuration, ...(basePose ? { pose: basePose } : {}) });
      else if (basePose || block.lookAt) performances.push({ type: 'person.pose', itemId: item.id, ...(block.poseId ? { poseId: block.poseId } : { pose: {} }), time: beat.start, duration: beat.duration });
    }
    append(movements);
    // Gaze overlays retain procedural action phase; targets are sampled after every actor has been blocked.
    for (const block of beat.blocking) if (block.lookAt) {
      const lookAt = block.lookAt;
      const item = working.items.find((entry) => entry.id === block.itemId)!;
      const samples: StageCommand[] = [];
      const headSpec = PERSON_JOINTS.find((joint) => joint.key === 'head')!;
      let limited = false;
      for (let index = 0; index <= 4; index++) {
        const time = beat.start + (beat.duration - STAGE_RANGE_GUARD_SECONDS) * index / 4;
        const state = sample(time), actor = state.objects[item.id], target = resolve(lookAt, time);
        if ('actorId' in lookAt) target.y += heightOf(working.items.find((entry) => entry.id === lookAt.actorId)!) * 0.9 * state.objects[lookAt.actorId].scale.y;
        const dx = target.x - actor.position.x, dz = target.z - actor.position.z;
        const wantedYaw = Math.atan2(Math.sin(Math.atan2(dx, dz) - actor.rotation.y), Math.cos(Math.atan2(dx, dz) - actor.rotation.y));
        const wantedPitch = -Math.atan2(target.y - actor.position.y - heightOf(item) * actor.scale.y * 0.9, Math.hypot(dx, dz));
        const clampJoint = (value: number, axis: 'x' | 'y') => { const limits = headSpec.limits[axis]!; const next = Math.max(limits[0] * Math.PI / 180, Math.min(limits[1] * Math.PI / 180, value)); limited ||= Math.abs(next - value) > 1e-9; return next; };
        const pose: BlueprintActionPose = overlayPersonPose(block.poseId ? PERSON_POSE_MAP[block.poseId] : undefined, { head: { x: clampJoint(wantedPitch, 'x'), y: clampJoint(wantedYaw, 'y') } }) ?? {};
        const performance = performances.find((command) => (command.type === 'person.action' || command.type === 'person.pose') && command.itemId === item.id);
        if (index === 0) {
          if (performance?.type === 'person.action' || performance?.type === 'person.pose') performance.pose = overlayPersonPose(performance.pose, pose);
          continue;
        }
        const movingAction = performance?.type === 'person.action' && time < performance.start + performance.duration ? performance.actionId : null;
        samples.push({ type: 'keyframe.add', track: { kind: 'action', itemId: item.id }, keyframe: { id: makeId('gaze'), time, easing: 'hold', pose, poseId: null, clipId: null, actionId: movingAction, ...(movingAction ? { actionOffsetSeconds: time - beat.start } : {}) } });
      }
      performances.push(...samples);
      if (limited) warnings.push({ code: 'gaze-limit', itemId: item.id, start: beat.start, message: 'Look-at exceeds anatomical head limits; gaze is limited by the real rig. Adjust body facing to look directly at the target.' });
    }
    append(performances);
  }
  const aspectParts = (snapshot.data.aspectRatio ?? '16:9').split(':').map(Number);
  const aspect = aspectParts[0] / aspectParts[1];
  if (!(aspect > 0 && Number.isFinite(aspect))) throw new Error('Stage aspect ratio must be numeric width:height.');
  const boundsAt = (shot: StoryShot, time: number): StoryBounds => {
    const states = sample(time).objects, min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const id of shot.subjectItemIds) {
      const item = working.items.find((entry) => entry.id === id);
      if (!item || !states[id]) throw new Error(`Unknown shot subject ${id}.`);
      const state = states[id], height = heightOf(item) * state.scale.y;
      // Registered height is authoritative. Width/depth remain conservative proxies, not reconstructed geometry.
      const radius = heightOf(item) * Math.max(state.scale.x, state.scale.z) * (item.category === 'person' ? 0.22 : 0.75);
      min.min(new THREE.Vector3(state.position.x - radius, state.position.y, state.position.z - radius));
      max.max(new THREE.Vector3(state.position.x + radius, state.position.y + height, state.position.z + radius));
    }
    return { min: plain(min), max: plain(max) };
  };
  const shots = [...plan.shots].sort((a, b) => a.start - b.start);
  let cameraTrack = working.motionProject!.cameraTrack;
  for (let shotIndex = 0; shotIndex < shots.length; shotIndex++) {
    const shot = shots[shotIndex], end = shot.start + shot.duration, fov = shot.fov ?? 45;
    const original = cameraTrack;
    const nextShot = shots[shotIndex + 1];
    const terminalTime = nextShot?.start === end ? end - STAGE_RANGE_GUARD_SECONDS : end;
    const startFit = computeStoryFraming(boundsAt(shot, shot.start), shot.size, fov, aspect, shot.angle, shot.azimuth);
    const frames: DirectorCameraKeyframe[] = [];
    const blend = shot.transition === 'blend' && cameraTrack.length ? Math.min(shot.blendSeconds ?? 0.3, shot.duration / 2) : 0;
    const cameraStart = blend ? sampleNormalizedDirectorMotion({ ...working.motionProject!, cameraTrack }, shot.start, working.items).camera : null;
    if (cameraStart) frames.push({ ...cameraStart, id: makeId('blend-from'), time: shot.start, easing: 'hold' });
    const times = new Set<number>([shot.start + blend, terminalTime]);
    if (shot.movement !== 'static') {
      for (let index = 1; index < 8; index++) times.add(shot.start + blend + (terminalTime - shot.start - blend) * index / 8);
      for (const track of Object.values(working.motionProject!.objectTracks)) for (const frame of track) if (frame.time > shot.start + blend && frame.time < terminalTime) times.add(frame.time);
    }
    for (const time of [...times].sort((a, b) => a - b)) {
      const progress = (time - shot.start) / shot.duration;
      const fit = shot.movement === 'static' ? startFit : computeStoryFraming(boundsAt(shot, time), shot.size, fov, aspect, shot.angle, (shot.azimuth ?? 0) + (shot.movement === 'orbit' ? progress * Math.PI / 2 : 0));
      let position = vector(fit.position), target = vector(fit.target);
      if (shot.movement === 'push' || shot.movement === 'pull') {
        const factor = shot.movement === 'push' ? 1.4 - 0.4 * progress : 1 + 0.4 * progress;
        position = target.clone().add(position.sub(target).multiplyScalar(factor));
      } else if (shot.movement === 'pan') position = vector(startFit.position);
      else if (shot.movement === 'crane') position.y += progress * (boundsAt(shot, time).max.y - boundsAt(shot, time).min.y);
      if (shot.movement === 'static') target = vector(startFit.target);
      frames.push({ id: makeId('camera'), time, easing: time === shot.start ? 'hold' : blend && time === shot.start + blend ? 'smooth' : 'linear', position: plain(position), target: plain(target), fov, trackTargetId: null });
    }
    cameraTrack = replaceStageTrackRange(original, shot.start, end, frames, plan.duration, (time) => sampleNormalizedDirectorMotion({ ...working.motionProject!, cameraTrack: original }, time, working.items).camera ?? frames[0], makeId);
    if (original.some((frame) => frame.time >= shot.start && frame.time <= end)) warnings.push({ code: 'existing-range-replaced', start: shot.start, message: 'Shot replaces the camera interval, preserving outside frames.' });
    warnings.push({ code: 'estimated-bounds', start: shot.start, message: 'Framing uses registered metric heights and conservative width/depth proxies; inspect a real capture for geometry/pose/occlusion.' });
  }
  commands.push(...diffFrames(working.motionProject!.cameraTrack, cameraTrack));
  const parsed: StageCommand[] = commands.map((command) => stageCommandSchema.parse(command));
  prepareStageCommands(snapshot.data, parsed);
  return { commands: parsed, warnings, durationSeconds: plan.duration, captureTimes: [...new Set(shots.flatMap((shot) => [shot.start, shot.start + shot.duration / 2, shot.start + shot.duration]))].sort((a, b) => a - b) };
}
