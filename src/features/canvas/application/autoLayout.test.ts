import { describe, expect, it } from 'vitest';

import { layoutLayered, type LayoutNode } from './autoLayout';

const node = (id: string, x: number, y: number, width = 300, height = 200): LayoutNode => ({ id, x, y, width, height });

describe('layoutLayered', () => {
  it('places every edge target in a later column and starts at the current top-left', () => {
    const nodes = [node('a', 500, 400), node('b', 0, 0), node('c', 900, 900), node('d', 40, 700)];
    const edges = [
      { source: 'b', target: 'a' },
      { source: 'a', target: 'c' },
      { source: 'd', target: 'c' },
    ];
    const positions = layoutLayered(nodes, edges);
    for (const edge of edges) {
      expect(positions.get(edge.target)!.x).toBeGreaterThan(positions.get(edge.source)!.x);
    }
    expect(Math.min(...[...positions.values()].map((p) => p.x))).toBe(0);
    expect(Math.min(...[...positions.values()].map((p) => p.y))).toBe(0);
  });

  it('never overlaps nodes stacked in the same column', () => {
    const nodes = [node('a', 0, 0, 300, 180), node('b', 0, 50, 300, 260), node('c', 0, 90, 300, 120)];
    const positions = layoutLayered(nodes, []);
    const placed = nodes
      .map((item) => ({ ...item, ...positions.get(item.id)! }))
      .sort((left, right) => left.y - right.y);
    for (let index = 1; index < placed.length; index += 1) {
      expect(placed[index].y).toBeGreaterThanOrEqual(placed[index - 1].y + placed[index - 1].height);
    }
  });

  it('terminates on cycles and still positions every node', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 0)];
    const positions = layoutLayered(nodes, [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }]);
    expect(positions.size).toBe(2);
  });
});
