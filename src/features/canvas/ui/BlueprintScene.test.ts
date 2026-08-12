import { describe, expect, it } from 'vitest';

import { createDirectorFloorGrid, createDirectorFloorHitTarget } from './BlueprintScene';

describe('Director Studio floor rendering', () => {
  it('keeps the raycast target from occluding the visible grid', () => {
    const hitTarget = createDirectorFloorHitTarget();
    const material = hitTarget.material;

    expect(material.colorWrite).toBe(false);
    expect(material.depthWrite).toBe(false);
    expect(hitTarget.name).toBe('__floor');
  });

  it('builds visible floor and line layers for an empty scene', () => {
    const grid = createDirectorFloorGrid();

    expect(grid.visible).toBe(true);
    expect(grid.children).toHaveLength(5);
    expect(grid.children.every((child: { visible: boolean }) => child.visible)).toBe(true);
    expect(grid.children.slice(1).every((child: { type: string }) => child.type === 'Mesh')).toBe(true);
  });
});
