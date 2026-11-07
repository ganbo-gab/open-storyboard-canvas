/** Prefer authored boundaries/playhead within six screen pixels, then tenths. */
export function snapStageTimelineTime(time: number, duration: number, pixels: number, boundaries: readonly number[], playhead: number): number {
  const clamped = Math.max(0, Math.min(duration, time));
  const threshold = Math.min(0.15, duration * 6 / Math.max(1, pixels));
  const closest = [...boundaries, playhead].filter((value) => Number.isFinite(value) && value >= 0 && value <= duration)
    .reduce<number | undefined>((best, value) => Math.abs(value - clamped) <= threshold && (best === undefined || Math.abs(value - clamped) < Math.abs(best - clamped)) ? value : best, undefined);
  return closest ?? Math.max(0, Math.min(duration, Math.round(clamped * 10) / 10));
}
