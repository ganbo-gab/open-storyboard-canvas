import { describe, expect, it } from 'vitest';

import { createLargeCanvasPerformanceFixture } from './__fixtures__/largeCanvasPerformanceFixture';
import {
  buildCanvasGeometryIndex,
  getSharedCanvasGeometryIndex,
  getSharedCanvasNodeIndex,
  queryCanvasGeometryByXRange,
} from './canvasGraphIndex';

describe('canvasGraphIndex', () => {
  it('shares one geometry derivation across all edge consumers', () => {
    const fixture = createLargeCanvasPerformanceFixture();
    const first = getSharedCanvasGeometryIndex(fixture.nodes);

    fixture.edges.forEach(() => {
      expect(getSharedCanvasGeometryIndex(fixture.nodes)).toBe(first);
    });
    expect(first.obstacles).toHaveLength(fixture.nodes.length);
  });

  it('keeps route identity stable for data-only updates and invalidates geometry changes', () => {
    const fixture = createLargeCanvasPerformanceFixture();
    const first = getSharedCanvasGeometryIndex(fixture.nodes);
    const dataOnlyNodes = fixture.nodes.map((node, index) => (
      index === 0
        ? { ...node, data: { ...node.data, displayName: 'Updated without moving' } }
        : node
    ));
    const dataOnly = getSharedCanvasGeometryIndex(dataOnlyNodes);
    expect(dataOnly).toBe(first);

    const resizedNodes = dataOnlyNodes.map((node, index) => (
      index === 0
        ? { ...node, measured: { width: 480, height: 260 } }
        : node
    ));
    const resized = getSharedCanvasGeometryIndex(resizedNodes);
    expect(resized).not.toBe(dataOnly);

    const movedNodes = resizedNodes.map((node, index) => (
      index === 0
        ? { ...node, position: { x: node.position.x + 20, y: node.position.y } }
        : node
    ));
    expect(getSharedCanvasGeometryIndex(movedNodes)).not.toBe(resized);
  });

  it('returns only obstacles in the requested x range and excludes route endpoints', () => {
    const fixture = createLargeCanvasPerformanceFixture();
    const index = buildCanvasGeometryIndex(fixture.nodes);
    const source = fixture.nodes[0];
    const nearby = queryCanvasGeometryByXRange(
      index,
      source.position.x,
      source.position.x + 300,
      source.id,
    );

    expect(nearby.some((obstacle) => obstacle.id === source.id)).toBe(false);
    expect(nearby.length).toBeGreaterThan(0);
    expect(nearby.every((obstacle) => obstacle.right >= source.position.x)).toBe(true);
    expect(nearby.every((obstacle) => obstacle.left <= source.position.x + 300)).toBe(true);
  });

  it('builds one reusable id lookup for each nodes revision', () => {
    const fixture = createLargeCanvasPerformanceFixture();
    const first = getSharedCanvasNodeIndex(fixture.nodes);
    const second = getSharedCanvasNodeIndex(fixture.nodes);

    expect(second).toBe(first);
    expect(first.get(fixture.nodes[0].id)).toBe(fixture.nodes[0]);
  });
});
