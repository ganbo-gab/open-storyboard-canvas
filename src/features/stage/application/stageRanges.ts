import type { DirectorActionState, DirectorMotionProjectV1, BlueprintItem } from '@/features/canvas/domain/canvasNodes';
import { createDirectorMotionId, sampleNormalizedDirectorMotion } from '@/features/canvas/application/directorMotion';

type Frame = { id: string; time: number; easing: 'linear' | 'smooth' | 'hold'; easingRange?: [number, number] };
/** A one-microsecond guard retains outside keyframes without claiming exact discontinuity precision. */
export const STAGE_RANGE_GUARD_SECONDS = 0.000001;

function segmentRange<T extends Frame>(track: T[], time: number): { easing: T['easing']; easingRange?: [number, number] } {
  const index = track.findIndex((frame) => frame.time > time);
  if (index <= 0) return { easing: 'linear' };
  const from = track[index - 1], to = track[index];
  const range = to.easingRange ?? [0, 1];
  const fraction = (time - from.time) / (to.time - from.time);
  return { easing: to.easing, easingRange: [range[0], range[0] + fraction * (range[1] - range[0])] };
}

/** Replace only an explicitly requested interval, preserving outside frames and sampled boundary states. */
export function replaceStageTrackRange<T extends Frame>(
  track: T[], start: number, end: number, replacements: T[], duration: number,
  sample: (time: number) => Omit<T, 'id' | 'time' | 'easing'>,
  makeId: (suffix: string) => string = (suffix) => createDirectorMotionId(suffix),
): T[] {
  if (![start, end, duration].every(Number.isFinite) || start < 0 || !(end > start) || end > duration || !replacements.length) throw new Error('A replacement needs a positive interval within the timeline and frames.');
  if (replacements.some((frame) => !Number.isFinite(frame.time) || frame.time < start || frame.time > end)) throw new Error('Replacement frames must be inside their interval.');
  const sorted = [...track].sort((a, b) => a.time - b.time);
  // Path-facing derives headings from adjacent points. Materialize old headings before changing neighbors.
  const preserveHeading = (frame: T): T => 'orientToPath' in frame && frame.orientToPath === true
    ? { ...frame, ...sample(frame.time), orientToPath: false }
    : frame;
  const before = sorted.filter((frame) => frame.time < start).map(preserveHeading);
  let after = sorted.filter((frame) => frame.time > end).map(preserveHeading);
  const guards: T[] = [];
  if (start > 0 && !before.some((frame) => frame.time >= start - STAGE_RANGE_GUARD_SECONDS)) {
    const time = Math.max(0, start - STAGE_RANGE_GUARD_SECONDS);
    guards.push({ ...sample(time), id: makeId('before'), time, ...segmentRange(sorted, time) } as T);
  }
  if (end < duration && !after.some((frame) => frame.time <= end + STAGE_RANGE_GUARD_SECONDS)) {
    const time = Math.min(duration, end + STAGE_RANGE_GUARD_SECONDS);
    guards.push({ ...sample(time), id: makeId('resume'), time, easing: 'hold', easingRange: undefined } as T);
    const next = after[0];
    const previous = [...sorted].reverse().find((frame) => frame.time <= time);
    if (next && previous && next.time > previous.time) {
      const range = next.easingRange ?? [0, 1];
      const fraction = (time - previous.time) / (next.time - previous.time);
      after = [{ ...next, easingRange: [range[0] + fraction * (range[1] - range[0]), range[1]] }, ...after.slice(1)];
    }
  }
  return [...before, ...guards, ...replacements.map((frame, index) => index === 0 ? { ...frame, easing: 'hold' as const, easingRange: undefined } : frame), ...after].sort((a, b) => a.time - b.time);
}

/** Resume procedural/clip phase rather than restarting it at a range boundary. */
export function sampleStageActionState(project: DirectorMotionProjectV1, itemId: string, time: number, items: BlueprintItem[]): DirectorActionState {
  const sampled = sampleNormalizedDirectorMotion(project, time, items).actions[itemId] ?? {};
  const preceding = [...(project.actionTracks[itemId] ?? [])].reverse().find((frame) => frame.time <= time);
  if (preceding?.actionId || preceding?.clipId) return {
    ...sampled, pose: preceding.pose,
    actionOffsetSeconds: (preceding.actionOffsetSeconds ?? 0) + time - preceding.time,
  };
  return { poseId: null, actionId: null, clipId: null, pose: sampled.pose ?? items.find((item) => item.id === itemId)?.pose ?? {}, ...(sampled.bodyControls ? { bodyControls: sampled.bodyControls } : {}) };
}
