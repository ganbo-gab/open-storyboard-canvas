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

  it('builds visible floor layers including a shadow-receiving catcher', () => {
    const grid = createDirectorFloorGrid();

    expect(grid.visible).toBe(true);
    expect(grid.children.every((child: { visible: boolean }) => child.visible)).toBe(true);
    expect(grid.children.some((child: { receiveShadow?: boolean; material?: { type?: string } }) =>
      child.receiveShadow === true && child.material?.type === 'ShadowMaterial')).toBe(true);
  });
});
