/** Packed attributes: position2, miter2, side1, cap2, length1, total1, rgba4, halfWidth1. */
export const VIEWPORT_EDGE_VERTEX_STRIDE = 14;
export const VIEWPORT_EDGE_WORLD_ERROR = 0.5;
export const MAX_VIEWPORT_EDGE_COUNT = 1000;
export const MAX_VIEWPORT_EDGE_COORDINATE = 1_000_000;
export const MAX_VIEWPORT_EDGE_PATH_LENGTH = 200_000;
export const MAX_VIEWPORT_EDGE_POINTS = 8192;
export const MAX_VIEWPORT_EDGE_FLOATS = 8_000_000;

export type ViewportEdgeColor = readonly [number, number, number, number];
export interface ViewportEdgeInput {
  path: string;
  color: ViewportEdgeColor;
  width: number;
  miterLimit: number;
}
type Point = readonly [number, number];
const CHUNK_FLOATS = 2048 * VIEWPORT_EDGE_VERTEX_STRIDE;
function unsupported(): never { throw new Error('Unsupported viewport edge geometry'); }
const midpoint = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const distance = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

function distanceToSegmentSquared(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
}

/** Absolute commands only. Unsupported input falls back to the application's SVG renderer. */
function flattenPath(path: string): Point[][] {
  if (typeof path !== 'string' || !path.trim() || path.length > MAX_VIEWPORT_EDGE_PATH_LENGTH) unsupported();
  const tokens: (number | string)[] = [];
  const expression = /[MLCQ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;
  let previousEnd = 0, match: RegExpExecArray | null;
  while ((match = expression.exec(path))) {
    if (!/^[\s,]*$/.test(path.slice(previousEnd, match.index))) unsupported();
    const token = /^[MLCQ]$/.test(match[0]) ? match[0] : Number(match[0]);
    if (typeof token === 'number' && (!Number.isFinite(token) || Math.abs(token) > MAX_VIEWPORT_EDGE_COORDINATE)) unsupported();
    tokens.push(token);
    previousEnd = expression.lastIndex;
  }
  if (!/^[\s,]*$/.test(path.slice(previousEnd))) unsupported();
  const subpaths: Point[][] = [];
  let index = 0, command = '', point: Point | null = null, points: Point[] | null = null, pointCount = 0;
  const append = (next: Point): void => {
    if (!points) unsupported();
    if (!points.length || distance(points[points.length - 1], next) > 1e-8) {
      if (++pointCount > MAX_VIEWPORT_EDGE_POINTS) unsupported();
      points.push(next);
    }
  };
  const pair = (): Point => {
    const x = tokens[index++], y = tokens[index++];
    if (typeof x !== 'number' || typeof y !== 'number') unsupported();
    return [x, y];
  };
  const quadratic = (a: Point, b: Point, c: Point, depth = 0): void => {
    if (distanceToSegmentSquared(b, a, c) <= VIEWPORT_EDGE_WORLD_ERROR ** 2) { append(c); return; }
    if (depth >= 20) unsupported();
    const ab = midpoint(a, b), bc = midpoint(b, c), center = midpoint(ab, bc);
    quadratic(a, ab, center, depth + 1);
    quadratic(center, bc, c, depth + 1);
  };
  const cubic = (a: Point, b: Point, c: Point, d: Point, depth = 0): void => {
    if (Math.max(distanceToSegmentSquared(b, a, d), distanceToSegmentSquared(c, a, d)) <= VIEWPORT_EDGE_WORLD_ERROR ** 2) { append(d); return; }
    if (depth >= 20) unsupported();
    const ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d);
    const abc = midpoint(ab, bc), bcd = midpoint(bc, cd), center = midpoint(abc, bcd);
    cubic(a, ab, abc, center, depth + 1);
    cubic(center, bcd, cd, d, depth + 1);
  };
  while (index < tokens.length) {
    if (typeof tokens[index] === 'string') command = tokens[index++] as string;
    if (!command) unsupported();
    if (command === 'M') {
      point = pair(); points = []; subpaths.push(points); append(point); command = 'L';
    } else {
      if (!point || !points) unsupported();
      if (command === 'L') { point = pair(); append(point); }
      else if (command === 'Q') { const control = pair(), end = pair(); quadratic(point, control, end); point = end; }
      else if (command === 'C') { const first = pair(), second = pair(), end = pair(); cubic(point, first, second, end); point = end; }
      else unsupported();
    }
  }
  return subpaths.filter(subpath => subpath.length >= 2);
}

/** Small typed chunks avoid millions of boxed numbers and large argument spreads during preparation. */
class VertexWriter {
  private readonly chunks: Float32Array[] = [];
  private current = new Float32Array(0);
  private offset = 0;
  private length = 0;

  vertex(position: Point, mx: number, my: number, side: number, cx: number, cy: number,
    length: number, total: number, color: ViewportEdgeColor, halfWidth: number): void {
    if (this.length + VIEWPORT_EDGE_VERTEX_STRIDE > MAX_VIEWPORT_EDGE_FLOATS) unsupported();
    if (this.offset === this.current.length) {
      this.current = new Float32Array(CHUNK_FLOATS);
      this.chunks.push(this.current);
      this.offset = 0;
    }
    const data = this.current;
    let i = this.offset;
    data[i++] = position[0]; data[i++] = position[1];
    data[i++] = mx; data[i++] = my; data[i++] = side;
    data[i++] = cx; data[i++] = cy; data[i++] = length; data[i++] = total;
    data[i++] = color[0]; data[i++] = color[1]; data[i++] = color[2]; data[i++] = color[3];
    data[i++] = halfWidth;
    this.offset = i; this.length += VIEWPORT_EDGE_VERTEX_STRIDE;
  }

  finish(): Float32Array {
    const output = new Float32Array(this.length);
    let offset = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const used = i === this.chunks.length - 1 ? this.offset : this.chunks[i].length;
      output.set(this.chunks[i].subarray(0, used), offset); offset += used;
    }
    return output;
  }
}

function ribbon(points: readonly Point[], edge: ViewportEdgeInput, writer: VertexWriter): void {
  const count = points.length, tangents = new Float64Array((count - 1) * 2);
  const lengths = new Float64Array(count), miters = new Float64Array(count * 2);
  for (let i = 0; i < count - 1; i++) {
    const dx = points[i + 1][0] - points[i][0], dy = points[i + 1][1] - points[i][1], size = Math.hypot(dx, dy);
    if (!(size > 1e-8)) unsupported();
    tangents[i * 2] = dx / size; tangents[i * 2 + 1] = dy / size;
    lengths[i + 1] = lengths[i] + size;
  }
  for (let i = 0; i < count; i++) {
    if (i === 0 || i === count - 1) {
      const segment = i === 0 ? 0 : count - 2;
      miters[i * 2] = -tangents[segment * 2 + 1]; miters[i * 2 + 1] = tangents[segment * 2];
    } else {
      const beforeX = -tangents[(i - 1) * 2 + 1], beforeY = tangents[(i - 1) * 2];
      const afterX = -tangents[i * 2 + 1], afterY = tangents[i * 2];
      const sumX = beforeX + afterX, sumY = beforeY + afterY, size = Math.hypot(sumX, sumY);
      if (size < 1e-6) unsupported();
      const mx = sumX / size, my = sumY / size, dot = mx * afterX + my * afterY;
      if (Math.abs(dot) < 1e-6 || 1 / Math.abs(dot) > edge.miterLimit + 1e-6) unsupported();
      miters[i * 2] = mx / dot; miters[i * 2 + 1] = my / dot;
    }
  }
  const vertex = (i: number, side: number): void => {
    const segment = i === 0 ? 0 : count - 2, sign = i === 0 ? -1 : i === count - 1 ? 1 : 0;
    writer.vertex(points[i], miters[i * 2], miters[i * 2 + 1], side,
      tangents[segment * 2] * sign, tangents[segment * 2 + 1] * sign,
      lengths[i], lengths[count - 1], edge.color, edge.width / 2);
  };
  for (let i = 0; i < count - 1; i++) {
    vertex(i, -1); vertex(i, 1); vertex(i + 1, -1);
    vertex(i + 1, -1); vertex(i, 1); vertex(i + 1, 1);
  }
}

/** Solid butt/miter geometry only; null means render the original SVGs. Edge order is unchanged. */
export function buildViewportEdgeGeometry(edges: readonly ViewportEdgeInput[]): Float32Array | null {
  const inputs: readonly ViewportEdgeInput[] = edges;
  if (!Array.isArray(edges) || edges.length > MAX_VIEWPORT_EDGE_COUNT) return null;
  try {
    const writer = new VertexWriter();
    for (const edge of inputs) {
      if (!edge || !Number.isFinite(edge.width) || edge.width <= 0 || edge.width > 2048
        || !Array.isArray(edge.color) || edge.color.length !== 4
        || edge.color.some((value: number) => !Number.isFinite(value) || value < 0 || value > 1)
        || !Number.isFinite(edge.miterLimit) || edge.miterLimit < 1 || edge.miterLimit > 16) return null;
      const subpaths = flattenPath(edge.path);
      if (edge.color[3] === 0) continue;
      for (const points of subpaths) ribbon(points, edge, writer);
    }
    return writer.finish();
  } catch { return null; }
}
