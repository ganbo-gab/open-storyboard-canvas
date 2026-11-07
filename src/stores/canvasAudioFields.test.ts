import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from './canvasStore';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

beforeEach(() => useCanvasStore.setState({ nodes: [], edges: [], history: { past: [], future: [] }, selectedNodeId: null }));
describe('persisted audio channel fields', () => {
  it('retains a selected audio mode and sanitizes explicit slots using the shared node normalizer', () => {
    const persisted = { id: 'audio', type: CANVAS_NODE_TYPES.aiAudio, position: { x: 0, y: 0 }, data: {
      prompt: 'Speak', modelId: 'custom:audio:model', channelModeId: 'clone',
      referenceSlots: { voice: ['/voice.wav', '', 42], empty: [] },
    } };
    useCanvasStore.getState().setCanvasData([persisted as unknown as CanvasNode], []);
    expect(useCanvasStore.getState().nodes[0].data).toMatchObject({ channelModeId: 'clone', referenceSlots: { voice: ['/voice.wav'] } });
    expect(useCanvasStore.getState().nodes[0].data.referenceSlots).not.toHaveProperty('empty');
  });
  it('keeps an intentionally empty slot map while dropping an invalid persisted mode ID', () => {
    const persisted = { id: 'audio', type: CANVAS_NODE_TYPES.aiAudio, position: { x: 0, y: 0 }, data: { prompt: 'Speak', channelModeId: 42, referenceSlots: {} } };
    useCanvasStore.getState().setCanvasData([persisted as unknown as CanvasNode], []);
    expect(useCanvasStore.getState().nodes[0].data).toMatchObject({ channelModeId: undefined, referenceSlots: {} });
  });
});
