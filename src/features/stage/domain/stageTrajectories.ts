import type { DirectorMotionVector3 } from '@/features/canvas/domain/canvasNodes';

function distanceToSegmentSquared(point: DirectorMotionVector3, from: DirectorMotionVector3, to: DirectorMotionVector3): number {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const length = dx * dx + dy * dy + dz * dz;
  const t = length > 0 ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy + (point.z - from.z) * dz) / length)) : 0;
  return (point.x - from.x - t * dx) ** 2 + (point.y - from.y - t * dy) ** 2 + (point.z - from.z - t * dz) ** 2;
}
/** Douglas–Peucker, retaining endpoints and the largest bends rather than uniform subsampling. */
export function simplifyStageFreehand(points: readonly DirectorMotionVector3[], maxPoints = 20): DirectorMotionVector3[] {
  if (points.length <= maxPoints) return points.map((point) => ({ ...point }));
  const selected = new Set([0, points.length - 1]);
  const segments = [{ start: 0, end: points.length - 1 }];
  while (selected.size < maxPoints && segments.length) {
    let bestSegment = -1, bestPoint = -1, bestDistance = 0;
    segments.forEach(({ start, end }, index) => {
      for (let point = start + 1; point < end; point += 1) {
        const distance = distanceToSegmentSquared(points[point], points[start], points[end]);
        if (distance > bestDistance) { bestSegment = index; bestPoint = point; bestDistance = distance; }
      }
    });
    if (bestSegment < 0) break;
    const { start, end } = segments.splice(bestSegment, 1)[0];
    selected.add(bestPoint);
    segments.push({ start, end: bestPoint }, { start: bestPoint, end });
  }
  return [...selected].sort((a, b) => a - b).map((index) => ({ ...points[index] }));
}
