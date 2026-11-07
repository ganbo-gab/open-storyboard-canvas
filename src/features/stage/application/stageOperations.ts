import * as THREE from 'three';
import type { BlueprintNodeData, DirectorActionClip, DirectorActionKeyframe, DirectorCameraKeyframe, DirectorMotionProjectV1, DirectorObjectKeyframe } from '@/features/canvas/domain/canvasNodes';
import { createDirectorCameraPresetTrack, createDirectorCameraRouteTrack, createDirectorMotionId, createDirectorObjectRouteTrack, createEmptyDirectorMotionProject, deleteDirectorMotionClip, sampleNormalizedDirectorMotion, splitDirectorMotionClip, upsertDirectorKeyframe } from '@/features/canvas/application/directorMotion';
import { PERSON_POSE_MAP, PERSON_ACTION_MAP } from '@/features/canvas/application/personMotionLibrary';
import { overlayPersonPose } from '@/features/canvas/domain/personPose';
import { pos3dToLegacy } from '@/features/canvas/ui/blueprintCoordinates';
import type { StageCommand, StageKeyframe, StageTrack } from '../domain/stage';
import { stageKeyframeSchemas } from '../domain/stageSchemas';
import { simplifyStageFreehand } from '../domain/stageTrajectories';
import { replaceStageTrackRange, sampleStageActionState } from './stageRanges';

function requireItem(data: BlueprintNodeData, id: string) {
  const item = data.items.find((entry) => entry.id === id);
  if (!item) throw new Error(`Stage object ${id} does not exist.`);
  return item;
}
function requireEditableItem(data: BlueprintNodeData, id: string) {
  const item = requireItem(data, id);
  if (item.locked === true) throw new Error(`Stage object ${id} is locked. Unlock it before editing.`);
  return item;
}
function requirePerson(data: BlueprintNodeData, id: string) {
  const item = requireEditableItem(data, id);
  if (item.category !== 'person') throw new Error(`Stage object ${id} is not a person.`);
  return item;
}
function requireClip(project: DirectorMotionProjectV1, id: string) {
  const clip = project.customClips.find((entry) => entry.id === id);
  if (!clip) throw new Error(`Clip ${id} does not exist.`);
  return clip;
}
/** Shared library edits also affect every person referencing a nested clip. */
function requireEditableClip(data: BlueprintNodeData, project: DirectorMotionProjectV1, id: string) {
  const clip = requireClip(project, id);
  const references = (clipId: string, visited = new Set<string>()): boolean => {
    if (clipId === id) return true;
    if (visited.has(clipId)) return false;
    visited.add(clipId);
    return requireClip(project, clipId).keyframes.some((frame) => frame.clipId && references(frame.clipId, visited));
  };
  for (const item of data.items) {
    if (item.locked === true && (project.actionTracks[item.id] ?? []).some((frame) => frame.clipId && references(frame.clipId))) {
      throw new Error(`Clip ${id} affects locked stage object ${item.id}. Unlock it before editing.`);
    }
  }
  return clip;
}

function timelineContentEnd(project: DirectorMotionProjectV1): number {
  let end = Math.max(0, ...project.cameraTrack.map((frame) => frame.time), ...(project.cameraRigs ?? []).map((rig) => rig.end));
  for (const track of Object.values(project.objectTracks)) for (const frame of track) end = Math.max(end, frame.time);
  for (const track of Object.values(project.actionTracks)) {
    for (let index = 0; index < track.length; index += 1) {
      const frame = track[index];
      end = Math.max(end, frame.time);
      if (!frame.clipId) continue;
      const clip = requireClip(project, frame.clipId);
      const clipEnd = clip.loop ? project.durationSeconds : frame.time + Math.max(0, clip.durationSeconds - (frame.actionOffsetSeconds ?? 0));
      end = Math.max(end, Math.min(clipEnd, track[index + 1]?.time ?? project.durationSeconds, project.durationSeconds));
    }
  }
  return end;
}
function checkTime(time: number, duration: number) {
  if (!Number.isFinite(time) || time < 0 || time > duration) throw new Error(`Time must be between 0 and ${duration} seconds.`);
}
function validateClipGraph(project: DirectorMotionProjectV1) {
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (clip: DirectorActionClip) => {
    if (visiting.has(clip.id)) throw new Error('Custom clips cannot recursively reference themselves.');
    if (visited.has(clip.id)) return;
    visiting.add(clip.id);
    clip.keyframes.forEach((frame) => {
      if (frame.poseId && !PERSON_POSE_MAP[frame.poseId]) throw new Error(`Pose ${frame.poseId} does not exist.`);
      if (frame.actionId && !PERSON_ACTION_MAP[frame.actionId]) throw new Error(`Action ${frame.actionId} does not exist.`);
    });
    clip.keyframes.forEach((frame) => { checkTime(frame.time, clip.durationSeconds); if (frame.clipId) visit(requireClip(project, frame.clipId)); });
    visiting.delete(clip.id); visited.add(clip.id);
  };
  project.customClips.forEach(visit);
  Object.values(project.actionTracks).flat().forEach((frame) => { if (frame.clipId) requireClip(project, frame.clipId); });
}
function getTrack(data: BlueprintNodeData, project: DirectorMotionProjectV1, track: StageTrack): StageKeyframe[] {
  if (track.kind === 'camera') return project.cameraTrack;
  if (track.kind === 'clip') return requireEditableClip(data, project, track.clipId).keyframes;
  requireEditableItem(data, track.itemId);
  return track.kind === 'object' ? project.objectTracks[track.itemId] ?? [] : project.actionTracks[track.itemId] ?? [];
}
function writeTrack(project: DirectorMotionProjectV1, track: StageTrack, frames: StageKeyframe[]): DirectorMotionProjectV1 {
  if (track.kind === 'camera') return { ...project, cameraTrack: frames as DirectorCameraKeyframe[] };
  if (track.kind === 'clip') return { ...project, customClips: project.customClips.map((clip) => clip.id === track.clipId ? { ...clip, keyframes: frames as DirectorActionKeyframe[] } : clip) };
  return track.kind === 'object'
    ? { ...project, objectTracks: { ...project.objectTracks, [track.itemId]: frames as DirectorObjectKeyframe[] } }
    : { ...project, actionTracks: { ...project.actionTracks, [track.itemId]: frames as DirectorActionKeyframe[] } };
}
function editKeyframe(data: BlueprintNodeData, project: DirectorMotionProjectV1, command: Extract<StageCommand, { type: 'keyframe.add' | 'keyframe.update' | 'keyframe.remove' }>) {
  const track = command.track, frames = getTrack(data, project, track);
  const existing = command.type === 'keyframe.add' ? undefined : frames.find((frame) => frame.id === command.keyframeId);
  if (command.type !== 'keyframe.add' && !existing) throw new Error(`Keyframe ${command.keyframeId} does not exist.`);
  if (command.type === 'keyframe.remove') return writeTrack(project, track, frames.filter((frame) => frame.id !== command.keyframeId));
  if (command.type === 'keyframe.add' && frames.some((frame) => frame.id === command.keyframe.id)) throw new Error('Keyframe id already exists.');
  const patch = command.type === 'keyframe.add' ? command.keyframe : command.patch;
  // API time is always scene time. Untouched stored clip times are already local.
  const frame = { ...existing, ...patch, ...(patch.time !== undefined && track.kind === 'clip' ? { time: patch.time - track.clipStart } : {}) };
  const parsed = stageKeyframeSchemas[track.kind].parse(frame) as StageKeyframe;
  checkTime(parsed.time, track.kind === 'clip' ? requireClip(project, track.clipId).durationSeconds : project.durationSeconds);
  if (track.kind === 'camera' && 'trackTargetId' in parsed && parsed.trackTargetId) requireItem(data, parsed.trackTargetId);
  return writeTrack(project, track, upsertDirectorKeyframe(frames, parsed));
}

/** Pure preparation. No store writes; a failed later command cannot leave partial edits. */
export function prepareStageCommands(original: BlueprintNodeData, commands: StageCommand[]): { data: BlueprintNodeData; createdIds: string[] } {
  let data = original;
  const createdIds: string[] = [];
  for (const command of commands) {
    let project = data.motionProject ?? createEmptyDirectorMotionProject();
    switch (command.type) {
      case 'person.pose': {
        requirePerson(data, command.itemId);
        if (!command.poseId && !command.pose) throw new Error('Supply a real poseId or anatomical pose.');
        const preset = command.poseId ? PERSON_POSE_MAP[command.poseId] : undefined;
        if (command.poseId && !preset) throw new Error(`Pose ${command.poseId} does not exist.`);
        const pose = overlayPersonPose(preset, command.pose) ?? {};
        if (command.time === undefined) {
          data = { ...data, items: data.items.map((item) => item.id === command.itemId ? { ...item, pose } : item) };
          continue;
        }
        checkTime(command.time, project.durationSeconds);
        const frame: DirectorActionKeyframe = { id: createDirectorMotionId('pose'), time: command.time, easing: 'hold', poseId: null, actionId: null, clipId: null, pose };
        if (command.duration !== undefined) {
          const end = command.time + command.duration;
          checkTime(end, project.durationSeconds);
          const endFrame: DirectorActionKeyframe = { ...sampleStageActionState(project, command.itemId, end, data.items), id: createDirectorMotionId('pose-end'), time: end, easing: 'hold' };
          project = { ...project, actionTracks: { ...project.actionTracks, [command.itemId]: replaceStageTrackRange(project.actionTracks[command.itemId] ?? [], command.time, end, [frame, endFrame], project.durationSeconds, (time) => sampleStageActionState(project, command.itemId, time, data.items)) } };
          createdIds.push(frame.id, endFrame.id); break;
        }
        const previous = project.actionTracks[command.itemId] ?? [];
        const baseline: DirectorActionKeyframe[] = command.time > 0 && !previous.some((entry) => entry.time < command.time!)
          ? [{ ...sampleStageActionState(project, command.itemId, 0, data.items), id: createDirectorMotionId('pose-baseline'), time: 0, easing: 'hold' }]
          : [];
        project = { ...project, actionTracks: { ...project.actionTracks, [command.itemId]: upsertDirectorKeyframe([...previous.filter((entry) => entry.time !== command.time), ...baseline], frame) } };
        createdIds.push(frame.id); break;
      }
      case 'person.action': {
        requirePerson(data, command.itemId);
        if (!PERSON_ACTION_MAP[command.actionId]) throw new Error(`Action ${command.actionId} does not exist.`);
        const end = command.start + command.duration;
        checkTime(command.start, project.durationSeconds); checkTime(end, project.durationSeconds);
        const frames: DirectorActionKeyframe[] = [
          { id: createDirectorMotionId('action'), time: command.start, easing: 'hold', poseId: null, clipId: null, actionId: command.actionId, ...(command.pose ? { pose: command.pose } : {}) },
          { ...sampleStageActionState(project, command.itemId, end, data.items), id: createDirectorMotionId('action-end'), time: end, easing: 'hold' },
        ];
        const track = replaceStageTrackRange(project.actionTracks[command.itemId] ?? [], command.start, end, frames, project.durationSeconds, (time) => sampleStageActionState(project, command.itemId, time, data.items));
        project = { ...project, actionTracks: { ...project.actionTracks, [command.itemId]: track } };
        createdIds.push(...frames.map((frame) => frame.id)); break;
      }
      case 'camera.preset': {
        const end = command.start + command.duration;
        checkTime(command.start, project.durationSeconds); checkTime(end, project.durationSeconds);
        const item = command.targetId ? requireItem(data, command.targetId) : undefined;
        if (command.presetId === 'follow-actor-route' && !item) throw new Error('Follow route requires targetId.');
        const sampled = sampleNormalizedDirectorMotion(project, command.start, data.items);
        const target = item && sampled.objects[item.id] ? { ...item, pos3d: sampled.objects[item.id].position } : item;
        const originalRoute = item ? project.objectTracks[item.id] ?? [] : [];
        const route = item ? [
          { id: 'range-start', time: 0, easing: 'linear' as const, ...sampled.objects[item.id] },
          ...originalRoute.filter((frame) => frame.time > command.start && frame.time < end).map((frame) => ({ ...frame, time: frame.time - command.start })),
          { id: 'range-end', time: command.duration, easing: 'linear' as const, ...sampleNormalizedDirectorMotion(project, end, data.items).objects[item.id] },
        ] : undefined;
        const generated = createDirectorCameraPresetTrack(command.presetId, command.duration, target, route);
        const sourceDuration = generated[generated.length - 1]?.time ?? command.duration;
        const frames = generated.map((frame) => ({ ...frame, time: command.start + frame.time / sourceDuration * command.duration }));
        const fallback = frames[0];
        const cameraTrack = replaceStageTrackRange(project.cameraTrack, command.start, end, frames, project.durationSeconds, (time) => sampleNormalizedDirectorMotion(project, time, data.items).camera ?? fallback);
        project = { ...project, cameraTrack }; createdIds.push(...frames.map((frame) => frame.id)); break;
      }
      case 'object.add': {
        if (data.items.some((item) => item.id === command.item.id)) throw new Error('Object id already exists.');
        data = { ...data, items: [...data.items, { ...command.item, ...(command.item.pos3d ? pos3dToLegacy(command.item.pos3d) : {}) }] };
        createdIds.push(command.item.id); continue;
      }
      case 'object.update': {
        const item = requireItem(data, command.itemId);
        const explicitUnlock = command.patch.locked === false && Object.keys(command.patch).length === 1;
        if (item.locked === true && !explicitUnlock) requireEditableItem(data, command.itemId);
        data = { ...data, items: data.items.map((item) => item.id === command.itemId ? { ...item, ...command.patch, ...(command.patch.pos3d ? pos3dToLegacy(command.patch.pos3d) : {}) } : item) }; continue;
      }
      case 'object.remove': {
        requireEditableItem(data, command.itemId);
        const objectTracks = { ...project.objectTracks }, actionTracks = { ...project.actionTracks };
        delete objectTracks[command.itemId]; delete actionTracks[command.itemId];
        project = { ...project, objectTracks, actionTracks, cameraTrack: project.cameraTrack.map((frame) => frame.trackTargetId === command.itemId ? { ...frame, trackTargetId: null } : frame) };
        data = { ...data, items: data.items.filter((item) => item.id !== command.itemId) }; break;
      }
      case 'camera.lookAt': {
        checkTime(command.time, project.durationSeconds);
        const sampled = sampleNormalizedDirectorMotion(project, command.time, data.items).camera;
        const position = command.position ?? sampled?.position;
        if (!position) throw new Error('Supply a position when creating the first camera keyframe.');
        let target = sampled?.target ?? { x: position.x, y: position.y, z: position.z - 1 };
        let trackTargetId: string | null = null, trackTargetBodyPart: string | null = null;
        if (command.lookAt.mode === 'target') { requireItem(data, command.lookAt.targetId); trackTargetId = command.lookAt.targetId; trackTargetBodyPart = command.lookAt.bodyPart ?? 'torso'; }
        if (command.lookAt.mode === 'point') target = command.lookAt.point;
        if (command.lookAt.mode === 'free') {
          const r = command.lookAt.rotation;
          const forward = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(r.x, r.y, r.z, 'XYZ'));
          target = { x: position.x + forward.x, y: position.y + forward.y, z: position.z + forward.z };
        }
        const existing = project.cameraTrack.find((frame) => Math.abs(frame.time - command.time) < 0.000001);
        const frame: DirectorCameraKeyframe = { id: existing?.id ?? createDirectorMotionId('camera'), time: command.time, easing: existing?.easing ?? 'smooth', position, target, fov: command.fov ?? sampled?.fov ?? data.camera?.fov ?? 45, trackTargetId, trackTargetBodyPart, ...(command.lookAt.mode === 'free' ? { freeRotation: command.lookAt.rotation } : {}) };
        project = { ...project, cameraTrack: upsertDirectorKeyframe(project.cameraTrack, frame) };
        if (!existing) createdIds.push(frame.id); break;
      }
      case 'trajectory.set': {
        const end = command.start + command.duration; checkTime(command.start, project.durationSeconds); checkTime(end, project.durationSeconds);
        const holdEnd = command.holdEndUntil ?? end;
        checkTime(holdEnd, project.durationSeconds);
        if (holdEnd < end) throw new Error('holdEndUntil cannot precede trajectory arrival.');
        if (command.method === 'line' && command.points.length !== 2) throw new Error('A line requires exactly two points.');
        const points = command.method === 'freehand' ? simplifyStageFreehand(command.points) : command.points;
        if (command.targetId === 'camera') {
          const camera = command.camera ?? sampleNormalizedDirectorMotion(project, command.start, data.items).camera;
          if (!camera) throw new Error('Supply target and fov for the first camera route.');
          const frames = createDirectorCameraRouteTrack(points, camera, command.start, end);
          if (frames.length < 2) throw new Error('Trajectory needs two distinct points.');
          const fallback = frames[0];
          const cameraTrack = replaceStageTrackRange(project.cameraTrack, command.start, end, frames, project.durationSeconds, (time) => sampleNormalizedDirectorMotion(project, time, data.items).camera ?? fallback);
          project = { ...project, cameraTrack }; createdIds.push(...frames.map((frame) => frame.id));
        } else {
          const item = requireEditableItem(data, command.targetId);
          const moving = points.some((point) => Math.hypot(point.x - points[0].x, point.y - points[0].y, point.z - points[0].z) > 0.000001);
          const sampled = sampleNormalizedDirectorMotion(project, command.start, data.items).objects[item.id];
          const generated: DirectorObjectKeyframe[] = moving
            ? createDirectorObjectRouteTrack(points, { ...item, scale3d: sampled.scale }, command.start, end)
            : [command.start, end].map((time) => ({ id: createDirectorMotionId('hold'), time, easing: 'hold', position: points[0], rotation: sampled.rotation, scale: sampled.scale, orientToPath: false }));
          const frames = generated.map((frame) => ({ ...frame, ...(command.rotation ? { rotation: command.rotation } : {}), ...(command.orientToPath !== undefined ? { orientToPath: command.orientToPath } : {}) }));
          if (frames.length < 2) throw new Error('Trajectory needs two usable points.');
          const oldProject = project;
          const heldFrames = holdEnd > end ? [...frames, { ...frames[frames.length - 1], id: createDirectorMotionId('arrival-hold'), time: holdEnd, easing: 'hold' as const }] : frames;
          const objectTrack = replaceStageTrackRange(project.objectTracks[item.id] ?? [], command.start, holdEnd, heldFrames, project.durationSeconds, (time) => sampleNormalizedDirectorMotion(oldProject, time, data.items).objects[item.id]);
          project = { ...project, objectTracks: { ...project.objectTracks, [item.id]: objectTrack } };
          if (item.category === 'person' && moving) {
            const actions = oldProject.actionTracks[item.id] ?? [];
            const nextActions: DirectorActionKeyframe[] = [
              { id: createDirectorMotionId('walk'), time: command.start, easing: 'hold', actionId: 'walk' },
              { ...sampleStageActionState(oldProject, item.id, end, data.items), id: createDirectorMotionId('action-end'), time: end, easing: 'hold' },
            ];
            const track = replaceStageTrackRange(actions, command.start, end, nextActions, project.durationSeconds, (time) => sampleStageActionState(oldProject, item.id, time, data.items));
            project = { ...project, actionTracks: { ...project.actionTracks, [item.id]: track } };
          }
          createdIds.push(...heldFrames.map((frame) => frame.id));
        } break;
      }
      case 'clip.add':
        if (project.customClips.some((clip) => clip.id === command.clip.id)) throw new Error('Clip id already exists.');
        project = { ...project, customClips: [...project.customClips, command.clip] }; createdIds.push(command.clip.id); break;
      case 'clip.update': {
        requireEditableClip(data, project, command.clipId);
        project = { ...project, customClips: project.customClips.map((clip) => clip.id === command.clipId ? { ...clip, ...command.patch } : clip) }; break;
      }
      case 'clip.split': {
        requireEditableClip(data, project, command.clipId);
        const result = splitDirectorMotionClip(project, command.clipId, command.time - command.clipStart);
        project = result.project; createdIds.push(result.rightId); break;
      }
      case 'clip.delete': requireEditableClip(data, project, command.clipId); project = deleteDirectorMotionClip(project, command.clipId); break;
      case 'keyframe.add': case 'keyframe.update': case 'keyframe.remove':
        project = editKeyframe(data, project, command); if (command.type === 'keyframe.add') createdIds.push(command.keyframe.id); break;
      case 'playback.update': {
        const last = timelineContentEnd(project);
        if (last > command.duration) throw new Error(`Timeline contains content through ${last}s; move it before shortening.`);
        project = { ...project, durationSeconds: command.duration, ...(command.loop !== undefined ? { loop: command.loop } : {}) }; break;
      }
      case 'draft.apply': {
        const include = command.include ?? ['objects', 'people', 'camera'];
        const items = command.draft.objects.filter((entry) => include.includes(entry.category === 'person' ? 'people' : 'objects')).map((entry) => ({ id: createDirectorMotionId('item'), label: entry.label, category: entry.category, presetId: entry.presetId, color: '#94a3b8', pos3d: entry.position, rotation3d: entry.rotation, scale3d: entry.scale, ...pos3dToLegacy(entry.position), ...(entry.action ? { action: entry.action } : {}) }));
        data = { ...data, items: [...data.items, ...items] }; createdIds.push(...items.map((item) => item.id));
        if (include.includes('camera') && command.draft.camera) { const frame: DirectorCameraKeyframe = { id: createDirectorMotionId('camera'), time: 0, easing: 'smooth', ...command.draft.camera, trackTargetId: null }; project = { ...project, cameraTrack: [frame, ...project.cameraTrack.filter((entry) => entry.time !== 0)] }; createdIds.push(frame.id); }
        break;
      }
    }
    validateClipGraph(project);
    data = { ...data, motionProject: project };
  }
  return { data, createdIds };
}
