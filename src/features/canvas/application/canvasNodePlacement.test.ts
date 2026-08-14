import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import { findRelatedCanvasNodePositions } from './canvasNodePlacement';

function node(id: string, x: number, y: number, width = 300, height = 240): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.imageEdit,
    position: { x, y },
    measured: { width, height },
    data: {} as CanvasNode['data'],
  };
}

function overlaps(
  position: { x: number; y: number },
  size: { width: number; height: number },
  obstacle: CanvasNode,
): boolean {
  const width = obstacle.measured?.width ?? 300;
  const height = obstacle.measured?.height ?? 240;
  return position.x < obstacle.position.x + width + 18
    && position.x + size.width + 18 > obstacle.position.x
    && position.y < obstacle.position.y + height + 18
    && position.y + size.height + 18 > obstacle.position.y;
}

describe('findRelatedCanvasNodePositions', () => {
  it('chooses a roomy nearby gap instead of walking down a long first-fit column', () => {
    const nodes = [
      node('source', 0, 0, 460, 520),
      node('right-1', 500, 0, 420, 300),
      node('right-2', 500, 330, 420, 300),
      node('below', 0, 560, 360, 300),
    ];
    const [position] = findRelatedCanvasNodePositions({
      nodes,
      relatedNodeId: 'source',
      desired: { x: 488, y: 0 },
      size: { width: 384, height: 288 },
    });
    expect(Math.hypot(position.x - 488, position.y)).toBeLessThan(1_500);
    expect(position.y).toBeLessThan(1_800);
    expect(position).not.toEqual({ x: 488, y: 660 });
    expect(nodes.every((obstacle) => !overlaps(position, { width: 384, height: 288 }, obstacle))).toBe(true);
  });

  it('reserves separate collision-free slots for a batch', () => {
    const positions = findRelatedCanvasNodePositions({
      nodes: [node('source', 0, 0)],
      relatedNodeId: 'source',
      desired: { x: 332, y: 0 },
      size: { width: 220, height: 180 },
      count: 3,
    });
    expect(new Set(positions.map(({ x, y }) => `${x}:${y}`))).toHaveLength(3);
    positions.forEach((position, index) => {
      expect(overlaps(position, { width: 220, height: 180 }, node('source', 0, 0))).toBe(false);
      positions.slice(index + 1).forEach((other) => {
        expect(overlaps(position, { width: 220, height: 180 }, node('reserved', other.x, other.y, 220, 180))).toBe(false);
      });
    });
  });
});
