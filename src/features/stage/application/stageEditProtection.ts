import type { BlueprintNodeData } from '@/features/canvas/domain/canvasNodes';

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Legacy editor callbacks still cross this guard until all edits use commands.
 * A locked object may only be explicitly unlocked, without another edit piggybacking.
 */
export function assertStageEditUnlocked(before: BlueprintNodeData, patch: Partial<BlueprintNodeData>): void {
  for (const item of before.items) {
    if (!item.locked) continue;
    if (patch.items) {
      const next = patch.items.find((candidate) => candidate.id === item.id);
      if (!next || (!same(item, next) && !(next.locked === false && same({ ...item, locked: false }, next)))) {
        throw new Error(item.label);
      }
    }
    if (patch.motionProject) {
      const oldMotion = before.motionProject;
      const next = patch.motionProject;
      if (!same(oldMotion?.objectTracks[item.id] ?? [], next.objectTracks[item.id] ?? [])
        || !same(oldMotion?.actionTracks[item.id] ?? [], next.actionTracks[item.id] ?? [])
        || ((oldMotion?.actionTracks[item.id] ?? []).some((frame) => frame.clipId)
          && !same(oldMotion?.customClips ?? [], next.customClips))) throw new Error(item.label);
    }
    if (patch.customActionPoses && item.action && !same(before.customActionPoses?.[item.action], patch.customActionPoses[item.action])) throw new Error(item.label);
  }
}
