import * as THREE from 'three';
import type { BlueprintNodeData, DirectorActionClip, DirectorActionKeyframe, DirectorActionState, DirectorCameraKeyframe, DirectorMotionProjectV1, DirectorObjectKeyframe } from '@/features/canvas/domain/canvasNodes';
import { createDirectorCameraRouteTrack, createDirectorMotionId, createDirectorObjectRouteTrack, createEmptyDirectorMotionProject, deleteDirectorMotionClip, sampleNormalizedDirectorMotion, splitDirectorMotionClip, upsertDirectorKeyframe } from '@/features/canvas/application/directorMotion';
import { pos3dToLegacy } from '@/features/canvas/ui/blueprintCoordinates';
import type { StageCommand, StageKeyframe, StageTrack } from '../domain/stage';
import { stageKeyframeSchemas } from '../domain/stageSchemas';
import { simplifyStageFreehand } from '../domain/stageTrajectories';

function requireItem(data: BlueprintNodeData, id: string) {
  const item = data.items.find((entry) => entry.id === id);
  if (!item) throw new Error(`Stage object ${id} does not exist.`);
  return item;
}
function requireClip(project: DirectorMotionProjectV1, id: string) {
  const clip = project.customClips.find((entry) => entry.id === id);
  if (!clip) throw new Error(`Clip ${id} does not exist.`);
  return clip;
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
    clip.keyframes.forEach((frame) => { checkTime(frame.time, clip.durationSeconds); if (frame.clipId) visit(requireClip(project, frame.clipId)); });
    visiting.delete(clip.id); visited.add(clip.id);
  };
  project.customClips.forEach(visit);
  Object.values(project.actionTracks).flat().forEach((frame) => { if (frame.clipId) requireClip(project, frame.clipId); });
}
function getTrack(data: BlueprintNodeData, project: DirectorMotionProjectV1, track: StageTrack): StageKeyframe[] {
  if (track.kind === 'camera') return project.cameraTrack;
  if (track.kind === 'clip') return requireClip(project, track.clipId).keyframes;
  requireItem(data, track.itemId);
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
      case 'object.add': {
        if (data.items.some((item) => item.id === command.item.id)) throw new Error('Object id already exists.');
        data = { ...data, items: [...data.items, { ...command.item, ...(command.item.pos3d ? pos3dToLegacy(command.item.pos3d) : {}) }] };
        createdIds.push(command.item.id); continue;
      }
      case 'object.update': {
        requireItem(data, command.itemId);
        data = { ...data, items: data.items.map((item) => item.id === command.itemId ? { ...item, ...command.patch, ...(command.patch.pos3d ? pos3dToLegacy(command.patch.pos3d) : {}) } : item) }; continue;
      }
      case 'object.remove': {
        requireItem(data, command.itemId);
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
        if (command.method === 'line' && command.points.length !== 2) throw new Error('A line requires exactly two points.');
        const points = command.method === 'freehand' ? simplifyStageFreehand(command.points) : command.points;
        if (command.targetId === 'camera') {
          const camera = command.camera ?? sampleNormalizedDirectorMotion(project, command.start, data.items).camera;
          if (!camera) throw new Error('Supply target and fov for the first camera route.');
          const frames = createDirectorCameraRouteTrack(points, camera, command.start, end);
          if (frames.length < 2) throw new Error('Trajectory needs two distinct points.');
          project = { ...project, cameraTrack: [...project.cameraTrack.filter((frame) => frame.time < command.start || frame.time > end), ...frames].sort((a, b) => a.time - b.time) }; createdIds.push(...frames.map((frame) => frame.id));
        } else {
          const item = requireItem(data, command.targetId);
          const frames = createDirectorObjectRouteTrack(points, item, command.start, end);
          if (frames.length < 2) throw new Error('Trajectory needs two distinct points.');
          project = { ...project, objectTracks: { ...project.objectTracks, [item.id]: [...(project.objectTracks[item.id] ?? []).filter((frame) => frame.time < command.start || frame.time > end), ...frames].sort((a, b) => a.time - b.time) } };
          if (item.category === 'person') {
            const actions = project.actionTracks[item.id] ?? [];
            const resume: DirectorActionState = sampleNormalizedDirectorMotion(project, end, data.items).actions[item.id] ?? {};
            const preceding = [...actions].reverse().find((frame) => frame.time <= end);
            if (preceding && (preceding.actionId || preceding.clipId)) {
              resume.actionOffsetSeconds = (preceding.actionOffsetSeconds ?? 0) + end - preceding.time;
            }
            const nextActions: DirectorActionKeyframe[] = [
              ...actions.filter((frame) => frame.time < command.start || frame.time > end),
              { id: createDirectorMotionId('walk'), time: command.start, easing: 'linear', actionId: 'walk' },
              { ...resume, id: createDirectorMotionId('action-end'), time: end, easing: 'linear' },
            ];
            project = { ...project, actionTracks: { ...project.actionTracks, [item.id]: nextActions.sort((a, b) => a.time - b.time) } };
          }
          createdIds.push(...frames.map((frame) => frame.id));
        } break;
      }
      case 'clip.add':
        if (project.customClips.some((clip) => clip.id === command.clip.id)) throw new Error('Clip id already exists.');
        project = { ...project, customClips: [...project.customClips, command.clip] }; createdIds.push(command.clip.id); break;
      case 'clip.update': {
        requireClip(project, command.clipId);
        project = { ...project, customClips: project.customClips.map((clip) => clip.id === command.clipId ? { ...clip, ...command.patch } : clip) }; break;
      }
      case 'clip.split': {
        const result = splitDirectorMotionClip(project, command.clipId, command.time - command.clipStart);
        project = result.project; createdIds.push(result.rightId); break;
      }
      case 'clip.delete': requireClip(project, command.clipId); project = deleteDirectorMotionClip(project, command.clipId); break;
      case 'keyframe.add': case 'keyframe.update': case 'keyframe.remove':
        project = editKeyframe(data, project, command); if (command.type === 'keyframe.add') createdIds.push(command.keyframe.id); break;
      case 'playback.update': {
        const last = Math.max(0, ...project.cameraTrack.map((frame) => frame.time), ...Object.values(project.objectTracks).flat().map((frame) => frame.time), ...Object.values(project.actionTracks).flat().map((frame) => frame.time));
        if (last > command.duration) throw new Error(`Timeline contains a keyframe at ${last}s; move it before shortening.`);
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
