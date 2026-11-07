import { describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, type BlueprintNodeData, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { stageItemSchema } from '../domain/stageSchemas';

describe('imported model item persistence', () => {
  it('normalizes model ids in active and saved stages and preserves legacy built-in items', () => {
    const base = { id: 'model', label: 'Model', x: 0, y: 0, color: '#fff', category: 'object' as const };
    const items = [{ ...base, importedModelId: ' model-id ' }, { ...base, id: 'bad', importedModelId: 42 }, { ...base, id: 'empty', importedModelId: ' ' }, { ...base, id: 'legacy', presetId: 'box' }];
    const data = { mode: 'flat', items, referenceImages: [], aspectRatio: '16:9' };
    const node = { id: 'stage', type: CANVAS_NODE_TYPES.blueprint, position: { x: 0, y: 0 }, data: { ...data, directorStudioProjects: [{ id: 'saved', name: 'Saved', createdAt: 1, updatedAt: 2, snapshot: data }] } } as unknown as CanvasNode;
    useCanvasStore.getState().setCanvasData([node], []);
    const restored = useCanvasStore.getState().nodes[0].data as BlueprintNodeData;
    for (const stage of [restored, restored.directorStudioProjects![0].snapshot]) {
      expect(stage.items[0].importedModelId).toBe('model-id');
      expect(stage.items[1].importedModelId).toBeUndefined();
      expect(stage.items[2].importedModelId).toBeUndefined();
      expect(stage.items[3]).toMatchObject({ presetId: 'box' });
      expect(stage.items[3].importedModelId).toBeUndefined();
    }
    expect(stageItemSchema.parse({ ...base, importedModelId: 'model-id' }).importedModelId).toBe('model-id');
    expect(stageItemSchema.safeParse({ ...base, importedModelId: 42 }).success).toBe(false);
    useCanvasStore.getState().setCanvasData([], []);
  });
});
