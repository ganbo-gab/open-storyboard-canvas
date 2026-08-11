import { Position } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { buildCanvasGeometryIndex } from '@/features/canvas/application/canvasGraphIndex';
import { buildOrthogonalRoute } from './edgeRouting';

function createNode(id: string, x: number, y: number, width = 120, height = 100): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.upload,
    position: { x, y },
    measured: { width, height },
    data: {
      displayName: id,
      imageUrl: null,
      previewImageUrl: null,
      aspectRatio: '1:1',
      sourceFileName: `${id}.png`,
    },
  };
}

describe('buildOrthogonalRoute', () => {
  it('uses the shared geometry index to avoid an obstacle between endpoints', () => {
    const nodes = [
      createNode('source', -120, -50),
      createNode('obstacle', 140, -50, 120, 100),
      createNode('target', 400, -50),
    ];
    const common = {
      sourceId: 'source',
      targetId: 'target',
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 400,
      targetY: 0,
      targetPosition: Position.Left,
    };
    const direct = buildOrthogonalRoute({
      ...common,
      smartAvoidance: false,
    });
    const smart = buildOrthogonalRoute({
      ...common,
      smartAvoidance: true,
      geometryIndex: buildCanvasGeometryIndex(nodes),
    });

    expect(direct.path).toContain('L 24 0 L 24 0 L 376 0');
    expect(smart.path).not.toBe(direct.path);
    expect(smart.path).toMatch(/L 24 (-?\d+(?:\.\d+)?) L 376 \1/);
  });

  it('keeps the nodes fallback identical to indexed callers', () => {
    const nodes = [
      createNode('source', -120, -50),
      createNode('obstacle', 140, -50, 120, 100),
      createNode('target', 400, -50),
    ];
    const common = {
      sourceId: 'source',
      targetId: 'target',
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 400,
      targetY: 0,
      targetPosition: Position.Left,
      smartAvoidance: true,
    };
    const fallbackRoute = buildOrthogonalRoute({
      ...common,
      nodes,
    });
    const indexedRoute = buildOrthogonalRoute({
      ...common,
      geometryIndex: buildCanvasGeometryIndex(nodes),
    });

    expect(fallbackRoute.path).not.toContain('L 24 0 L 24 0 L 376 0');
    expect(indexedRoute).toEqual(fallbackRoute);
  });
});
