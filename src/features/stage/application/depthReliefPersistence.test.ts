import { describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type BlueprintNodeData, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { DEFAULT_DEPTH_RELIEF_PARAMETERS, normalizeDepthRelief } from '../domain/depthRelief';

const relief = { ...DEFAULT_DEPTH_RELIEF_PARAMETERS, imageUrl: 'asset-media:image%2Fpng:abc', depthUrl: '/app/images/depth.png' };

function restoredItems(items: unknown[]) {
  const node = {
    id: 'relief-stage', type: CANVAS_NODE_TYPES.blueprint, position: { x: 0, y: 0 },
    data: { mode: 'flat', items, referenceImages: [], aspectRatio: '16:9' },
  } as CanvasNode;
  useCanvasStore.getState().setCanvasData([node], []);
  return (useCanvasStore.getState().nodes[0].data as BlueprintNodeData).items;
}

describe('depth relief persistence', () => {
  it('retains a valid scene relief through normal project hydration', () => {
    const [item] = restoredItems([{ id: 'backdrop', label: 'Backdrop', x: 1, y: 2, color: '#fff', category: 'scene', relief }]);
    expect(item.relief).toEqual(relief);
    expect(item.category).toBe('scene');
  });

  it('drops corrupt or non-scene reliefs instead of admitting invalid persisted geometry', () => {
    const items = restoredItems([
      { id: 'bad-size', category: 'scene', relief: { ...relief, widthM: -1 } },
      { id: 'bad-grid', category: 'scene', relief: { ...relief, segments: 2.5 } },
      { id: 'expired-blob', category: 'scene', relief: { ...relief, depthUrl: 'blob:expired' } },
      { id: 'wrong-category', category: 'person', relief },
      { id: 'unknown-field', category: 'scene', relief: { ...relief, madeUp: true } },
    ]);
    expect(items).toHaveLength(5);
    expect(items.every((item) => item.relief === undefined)).toBe(true);
  });

  it('strictly normalizes persisted values and never coerces strings, infinity or unknown properties', () => {
    expect(normalizeDepthRelief(relief)).toEqual(relief);
    for (const invalid of [
      { ...relief, depthM: '3' }, { ...relief, fovDeg: Infinity }, { ...relief, segments: 513 },
      { ...relief, imageUrl: '' }, { ...relief, depthUrl: 'javascript:alert(1)' }, { ...relief, extra: 1 },
    ]) expect(normalizeDepthRelief(invalid)).toBeUndefined();
  });
});
