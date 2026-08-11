import { describe, expect, it } from 'vitest';

import { collectInputReferences } from './graphReferenceResolver';
import { createLargeCanvasPerformanceFixture } from './__fixtures__/largeCanvasPerformanceFixture';

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
});
