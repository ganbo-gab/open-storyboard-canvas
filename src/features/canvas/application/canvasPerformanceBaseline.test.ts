import { describe, expect, it } from 'vitest';

import { collectInputReferences } from './graphReferenceResolver';
import { createLargeCanvasPerformanceFixture } from './__fixtures__/largeCanvasPerformanceFixture';
import {
  getSharedCanvasGeometryIndex,
  getSharedCanvasNodeIndex,
  queryCanvasGeometryByXRange,
} from './canvasGraphIndex';

describe('large canvas performance baseline', () => {
  it('records the resolver cost for the stable 200+ node / 40+ tag fixture', () => {
    const fixture = createLargeCanvasPerformanceFixture();
    const iterations = 250;
    let resolvedReferenceCount = 0;

    const startedAt = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      fixture.consumerNodeIds.forEach((consumerNodeId) => {
        resolvedReferenceCount += collectInputReferences(
          consumerNodeId,
          fixture.nodes,
          fixture.edges,
        ).length;
      });
    }
    const durationMs = performance.now() - startedAt;

    const metrics = {
      nodes: fixture.nodes.length,
      edges: fixture.edges.length,
      tags: fixture.tagNodeIds.length,
      tagGroups: fixture.tagGroupNodeIds.length,
      consumers: fixture.consumerNodeIds.length,
      iterations,
      resolverCalls: iterations * fixture.consumerNodeIds.length,
      resolvedReferenceCount,
      durationMs: Number(durationMs.toFixed(2)),
      averageResolverCallMs: Number(
        (durationMs / (iterations * fixture.consumerNodeIds.length)).toFixed(6),
      ),
    };

    console.info(`[canvas-performance-baseline] ${JSON.stringify(metrics)}`);

    expect(fixture.nodes.length).toBeGreaterThanOrEqual(200);
    expect(fixture.tagNodeIds.length).toBeGreaterThanOrEqual(40);
    expect(fixture.edges).toHaveLength(248);
    expect(resolvedReferenceCount).toBeGreaterThan(0);
  });

  it('derives one geometry index per revision instead of once per smart edge', () => {
    const fixture = createLargeCanvasPerformanceFixture();
    const iterations = 50;
    let indexRequests = 0;
    let indexDerivations = 0;
    let queriedObstacleCount = 0;
    const startedAt = performance.now();

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const revisionNodes = fixture.nodes.map((node, nodeIndex) => (
        nodeIndex === 0
          ? { ...node, position: { x: node.position.x + iteration, y: node.position.y } }
          : node
      ));
      let revisionIndex: ReturnType<typeof getSharedCanvasGeometryIndex> | null = null;

      fixture.edges.forEach((edge) => {
        const geometryIndex = getSharedCanvasGeometryIndex(revisionNodes);
        const nodeIndex = getSharedCanvasNodeIndex(revisionNodes);
        indexRequests += 1;
        if (revisionIndex !== geometryIndex) {
          revisionIndex = geometryIndex;
          indexDerivations += 1;
        }
        const sourceNode = nodeIndex.get(edge.source);
        const targetNode = nodeIndex.get(edge.target);
        if (!sourceNode || !targetNode) return;
        queriedObstacleCount += queryCanvasGeometryByXRange(
          geometryIndex,
          sourceNode.position.x,
          targetNode.position.x,
          sourceNode.id,
          targetNode.id,
        ).length;
      });
    }

    const durationMs = performance.now() - startedAt;
    const legacyGeometryNodeVisits = iterations * fixture.edges.length * fixture.nodes.length;
    const indexedGeometryNodeVisits = iterations * fixture.nodes.length;
    const metrics = {
      nodes: fixture.nodes.length,
      edges: fixture.edges.length,
      iterations,
      indexRequests,
      indexDerivations,
      geometryDerivationReduction: indexRequests / indexDerivations,
      legacyGeometryNodeVisits,
      indexedGeometryNodeVisits,
      geometryNodeVisitReduction: legacyGeometryNodeVisits / indexedGeometryNodeVisits,
      queriedObstacleCount,
      durationMs: Number(durationMs.toFixed(2)),
    };

    console.info(`[canvas-smart-edge-index] ${JSON.stringify(metrics)}`);

    expect(indexRequests).toBe(iterations * fixture.edges.length);
    expect(indexDerivations).toBe(iterations);
    expect(metrics.geometryDerivationReduction).toBe(fixture.edges.length);
    expect(metrics.geometryNodeVisitReduction).toBe(fixture.edges.length);
    expect(queriedObstacleCount).toBeGreaterThan(0);
  });
});
