import type { DirectorCameraKeyframe, DirectorMotionProjectV1, DirectorObjectKeyframe } from '@/features/canvas/domain/canvasNodes';
import { createDirectorMotionId, retimeDirectorTrack } from '@/features/canvas/application/directorMotion';
import type { StageCommand, StageTrack } from '../domain/stage';

export interface StageRouteRef { kind: 'camera' | 'object'; trackId: string }
export type StageRouteFrame = DirectorCameraKeyframe | DirectorObjectKeyframe;
export function stageRouteFrames(project: DirectorMotionProjectV1, ref: StageRouteRef): StageRouteFrame[] {
  return ref.kind === 'camera' ? project.cameraTrack : project.objectTracks[ref.trackId] ?? [];
}
function isRangeGuard(frame: StageRouteFrame): boolean {
  // stageRanges owns these generated boundaries; they restore the state outside
  // a drawn interval and are not user-authored route endpoints.
  return frame.id.startsWith('before-') || frame.id.startsWith('resume-');
}
export function stageRouteClosed(allFrames: readonly StageRouteFrame[]): boolean {
  const frames = allFrames.filter((frame) => !isRangeGuard(frame));
  if (frames.length < 3) return false;
  const first = frames[0].position, last = frames[frames.length - 1].position;
  return Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z) < 0.0001;
}
function replaceRoute(ref: StageRouteRef, before: readonly StageRouteFrame[], after: readonly StageRouteFrame[]): StageCommand[] {
  const track: StageTrack = ref.kind === 'camera' ? { kind: 'camera' } : { kind: 'object', itemId: ref.trackId };
  const previous = new Map(before.map((frame) => [frame.id, frame]));
  const remaining = new Map(after.map((frame) => [frame.id, frame]));
  return [...before.filter((frame) => !remaining.has(frame.id)).map((frame): StageCommand => ({ type: 'keyframe.remove', track, keyframeId: frame.id })),
    ...after.map((keyframe): StageCommand => {
      if (!previous.has(keyframe.id)) return { type: 'keyframe.add', track, keyframe };
      const { id, ...patch } = keyframe;
      return { type: 'keyframe.update', track, keyframeId: id, patch };
    })];
}
export function retimeStageRoute(project: DirectorMotionProjectV1, ref: StageRouteRef, start: number, end: number): StageCommand[] {
  const frames = stageRouteFrames(project, ref);
  if (frames.length < 2 || !Number.isFinite(start) || !Number.isFinite(end)) return [];
  const safeStart = Math.max(0, Math.min(project.durationSeconds - 0.2, start));
  const safeEnd = Math.min(project.durationSeconds, Math.max(safeStart + 0.2, end));
  const next = retimeDirectorTrack(frames, safeStart, safeEnd, project.durationSeconds);
  if (next.every((frame, i) => frame.time === frames[i].time)) return [];
  return replaceRoute(ref, frames, next);
}
/** A return endpoint closes a V1 path. Reopening keeps all preceding authored points. */
export function toggleStageRouteClosed(project: DirectorMotionProjectV1, ref: StageRouteRef): StageCommand[] {
  const allFrames = stageRouteFrames(project, ref);
  const frames = allFrames.filter((frame) => !isRangeGuard(frame));
  const guards = allFrames.filter(isRangeGuard);
  if (frames.length < 2) return [];
  const first = frames[0], last = frames[frames.length - 1];
  const span = last.time - first.time;
  if (span < 0.2) return [];
  if (stageRouteClosed(frames)) {
    return replaceRoute(ref, allFrames, [...guards, ...retimeDirectorTrack(frames.slice(0, -1), first.time, last.time, project.durationSeconds)]);
  }
  let distance = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].position, b = frames[i].position;
    distance += Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }
  const back = Math.hypot(first.position.x - last.position.x, first.position.y - last.position.y, first.position.z - last.position.z);
  if (distance < 0.0001 || back < 0.0001) return [];
  const arrival = first.time + span * distance / (distance + back);
  const next = retimeDirectorTrack(frames, first.time, arrival, project.durationSeconds);
  next.push({ ...first, id: createDirectorMotionId('route-return'), time: last.time, easing: 'linear', easingRange: undefined });
  return replaceRoute(ref, allFrames, [...guards, ...next]);
}
