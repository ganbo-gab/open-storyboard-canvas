import { getBezierPath, Position } from '@xyflow/system';
import { describe, expect, it } from 'vitest';
import {
  buildViewportEdgeGeometry, MAX_VIEWPORT_EDGE_COORDINATE, MAX_VIEWPORT_EDGE_COUNT,
  MAX_VIEWPORT_EDGE_FLOATS, MAX_VIEWPORT_EDGE_PATH_LENGTH, MAX_VIEWPORT_EDGE_POINTS,
  VIEWPORT_EDGE_VERTEX_STRIDE, VIEWPORT_EDGE_WORLD_ERROR, type ViewportEdgeInput,
} from './viewportEdgeGeometry';

const input = (path: string, patch: Partial<ViewportEdgeInput> = {}): ViewportEdgeInput => ({
  path, width: 1.6, color: [1, 0.5, 0, 0.26], miterLimit: 4, ...patch,
});
const mesh = (path: string): Float32Array => {
  const result = buildViewportEdgeGeometry([input(path)]);
  if (!result) throw new Error('Expected supported geometry');
  return result;
};
function centerline(data: Float32Array): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i < data.length; i += VIEWPORT_EDGE_VERTEX_STRIDE * 6) {
    if (!points.length) points.push([data[i], data[i + 1]]);
    points.push([data[i + VIEWPORT_EDGE_VERTEX_STRIDE * 2], data[i + VIEWPORT_EDGE_VERTEX_STRIDE * 2 + 1]]);
  }
  return points;
}
function nearest(point: readonly number[], a: readonly number[], b: readonly number[]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

describe('viewport edge geometry', () => {
  it('keeps absolute line endpoints, ordinary miter joins and butt-cap padding attributes', () => {
    const data = mesh('M0,0 L100,0 100,100');
    expect(data.length).toBe(12 * VIEWPORT_EDGE_VERTEX_STRIDE);
    expect(centerline(data)).toEqual([[0, 0], [100, 0], [100, 100]]);
    expect([...data.slice(5, 9)]).toEqual([-1, -0, 0, 200]);
    const corner = VIEWPORT_EDGE_VERTEX_STRIDE * 2;
    expect([...data.slice(corner + 2, corner + 4)]).toEqual([-1, 1]);
    for (let i = 0; i < data.length; i += VIEWPORT_EDGE_VERTEX_STRIDE) {
      expect(data[i + 12]).toBeCloseTo(0.26);
      expect(data[i + 13]).toBeCloseTo(0.8);
    }
  });

  it.each([
    { path: 'M0 0 C50 250 250 -150 300 100', sample: (t: number) => {
      const s = 1 - t;
      return [150 * s * s * t + 750 * s * t * t + 300 * t ** 3, 750 * s * s * t - 450 * s * t * t + 100 * t ** 3];
    } },
    { path: 'M0 0 Q150 300 300 0', sample: (t: number) => [300 * t, 600 * t * (1 - t)] },
  ])('bounds adaptive approximation error for $path', ({ path, sample }) => {
    const points = centerline(mesh(path));
    expect(points.length).toBeGreaterThan(2);
    let maximum = 0;
    for (let i = 0; i <= 1000; i++) {
      const point = sample(i / 1000);
      let error = Infinity;
      for (let j = 1; j < points.length; j++) error = Math.min(error, nearest(point, points[j - 1], points[j]));
      maximum = Math.max(maximum, error);
    }
    expect(maximum).toBeLessThanOrEqual(VIEWPORT_EDGE_WORLD_ERROR + 0.0001);
  });

  it('preserves subpaths and edge order without combining translucent edge colors', () => {
    const first = input('M0 0L100 0 M200 0L300 0');
    const second = input('M0 20L100 20', { color: [0, 0, 1, 0.55] });
    const data = buildViewportEdgeGeometry([first, second]);
    expect(data?.length).toBe(18 * VIEWPORT_EDGE_VERTEX_STRIDE);
    expect(data?.[12]).toBeCloseTo(0.26);
    expect(data?.[12 * VIEWPORT_EDGE_VERTEX_STRIDE + 12]).toBeCloseTo(0.55);
    expect(data?.[12 * VIEWPORT_EDGE_VERTEX_STRIDE + 1]).toBe(20);
    expect(centerline(mesh('M1e2,-2.5 L+30.5 4'))).toEqual([[100, -2.5], [30.5, 4]]);
  });

  it.each(['m0 0l1 1', 'M0 0H100', 'M0 0V100', 'M0 0A10 10 0 0 0 20 20', 'M0 0L1 1Z',
    'M0 0L', 'C0 0 1 1 2 2', 'M0x0L10 10', 'M0 0C1 1 2 2', 'M0 0S1 1 2 2'])('rejects unsupported or malformed d: %s', path => {
    expect(buildViewportEdgeGeometry([input(path)])).toBeNull();
  });

  it('bounds coordinates, path size, point counts and unsafe joins instead of emitting broken triangles', () => {
    expect(buildViewportEdgeGeometry([input(`M0 0L${MAX_VIEWPORT_EDGE_COORDINATE + 1} 0`)])).toBeNull();
    expect(buildViewportEdgeGeometry([input(' '.repeat(MAX_VIEWPORT_EDGE_PATH_LENGTH + 1))])).toBeNull();
    expect(buildViewportEdgeGeometry([input(`M0 0${Array.from({ length: MAX_VIEWPORT_EDGE_POINTS }, (_, i) => `L${i + 1} 0`).join('')}`)])).toBeNull();
    expect(buildViewportEdgeGeometry([input('M0 0L1 0L0 0')])).toBeNull();
    expect(buildViewportEdgeGeometry([input('M0 0L1 0L1 1', { miterLimit: 1 })])).toBeNull();
    expect(buildViewportEdgeGeometry([input('M0 0L10 0', { width: NaN })])).toBeNull();
    expect(buildViewportEdgeGeometry([input('M0 0L10 0', { color: [1, 0, 0, 2] })])).toBeNull();
  });

  it('accepts an empty/fully transparent graph and rejects edge counts above the public limit', () => {
    expect(buildViewportEdgeGeometry([])).toEqual(new Float32Array());
    expect(buildViewportEdgeGeometry([input('M0 0L100 0', { color: [0, 0, 0, 0] })])).toEqual(new Float32Array());
    expect(buildViewportEdgeGeometry(Array.from({ length: MAX_VIEWPORT_EDGE_COUNT + 1 }, () => input('M0 0L1 1')))).toBeNull();
  });

  it('prepares the full thousand-edge fixture in bounded typed storage', () => {
    const edges = Array.from({ length: MAX_VIEWPORT_EDGE_COUNT }, (_, i) => {
      const target = 350 + (i + 1) % 650;
      const [path] = getBezierPath({ sourceX: i % 40 * 300 + 240, sourceY: Math.floor(i / 40) * 300 + 110,
        sourcePosition: Position.Right, targetX: target % 40 * 300, targetY: Math.floor(target / 40) * 300 + 110, targetPosition: Position.Left });
      return input(path);
    });
    const data = buildViewportEdgeGeometry(edges);
    expect(data).toBeInstanceOf(Float32Array);
    if (!data) throw new Error('Expected complete fixture geometry');
    expect(data.length).toBeGreaterThan(4_000_000);
    expect(data.length).toBeLessThanOrEqual(MAX_VIEWPORT_EDGE_FLOATS);
    expect(data.length % (VIEWPORT_EDGE_VERTEX_STRIDE * 3)).toBe(0);
  });
});
