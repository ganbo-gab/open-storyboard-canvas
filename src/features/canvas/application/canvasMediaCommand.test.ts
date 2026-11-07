import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_COMMAND_VERSION, type CanvasCommand } from '../domain/canvasCommands';
import { canvasCommandRegistry } from './canvasCommandService';
import type * as Media from './media';
import type { MediaEditOperation } from './media';

const media = vi.hoisted(() => ({ edit: vi.fn() }));
vi.mock('./media', async (importOriginal) => ({ ...await importOriginal<typeof Media>(), runNodeMediaEdit: media.edit }));

beforeEach(() => {
  media.edit.mockReset().mockResolvedValue({ nodeIds: ['local-result'], processing: 'image-transform' });
  useCanvasStore.setState({ nodes: [], edges: [], revision: 0, selectedNodeId: null, history: { past: [], future: [] }, dragHistorySnapshot: null });
});

describe('local media edit command', () => {
  it('exposes every operation as a generation-free graph command and returns durable editor result references', async () => {
    const operation: MediaEditOperation = { kind: 'image.transform', rotate: 90, flipX: true };
    const command = { type: 'node.media.edit', version: CANVAS_COMMAND_VERSION, input: { nodeId: 'source', operation } } satisfies CanvasCommand;
    const definition = canvasCommandRegistry.getDefinition(command.type);
    expect(definition.effect).toBe('graph');
    expect(definition.schema.input.properties.operation.oneOf).toHaveLength(8);
    expect(canvasCommandRegistry.inspect(command, 'agent').impacts[0]).toMatchObject({ effect: 'graph', requiresExternalSideEffect: false });
    const result = await canvasCommandRegistry.executeApproved(command, 0, 'agent');
    expect(result).toMatchObject({ ok: true, output: { references: { nodeId: 'local-result', nodeIds: ['local-result'] } } });
  });

  it('validates all operation variants and refuses unsupported fields or ranges before execution', async () => {
    const valid: MediaEditOperation[] = [
      { kind: 'image.transform', rotate: 270, flipY: true }, { kind: 'video.captureFrame', timeSeconds: 0 },
      { kind: 'video.trim', startSeconds: 1, endSeconds: 3 }, { kind: 'video.crop', rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } },
      { kind: 'video.separateAudio' }, { kind: 'audio.slice', startSeconds: 0, endSeconds: 2 },
      { kind: 'audio.split', atSeconds: [1, 2, 3] }, { kind: 'audio.rate', rate: 1.5 },
    ];
    for (const operation of valid) {
      expect(canvasCommandRegistry.validate({ type: 'node.media.edit', version: CANVAS_COMMAND_VERSION, input: { nodeId: 'source', operation } }, 'agent')).toEqual([]);
    }
    const invalid = [
      { kind: 'image.transform', rotate: 45 }, { kind: 'video.captureFrame', timeSeconds: -1 },
      { kind: 'video.trim', startSeconds: 3, endSeconds: 1 }, { kind: 'video.crop', rect: { x: 0.5, y: 0, width: 0.8, height: 1 } },
      { kind: 'video.separateAudio', extra: true }, { kind: 'audio.split', atSeconds: [2, 1] },
      { kind: 'audio.rate', rate: 3 }, { kind: 'provider.generate' },
    ];
    for (const operation of invalid) {
      const command = { type: 'node.media.edit', version: CANVAS_COMMAND_VERSION, input: { nodeId: 'source', operation } } as unknown as CanvasCommand;
      expect(await canvasCommandRegistry.execute(command, 'agent')).toMatchObject({ ok: false, error: { code: 'invalid_command' } });
    }
    expect(media.edit).not.toHaveBeenCalled();
  });
});
