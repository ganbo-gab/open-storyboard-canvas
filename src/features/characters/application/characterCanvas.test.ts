import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetRecord } from '@/features/assets/application/assetCatalog';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { useCanvasStore } from '@/stores/canvasStore';
import type { Character } from '../domain/types';
import { buildCharacterCanvasCommand, createCharacterCanvasCommand } from './characterCanvas';

const source = `asset-media:image%2Fpng:${'a'.repeat(64)}`;
const character: Character = { id: 'character', name: 'Actor', images: [{ assetId: 'image' }], mainImage: { assetId: 'image' }, tags: [], createdAt: 1, updatedAt: 1 };
const asset: AssetRecord = { id: 'image', kind: 'image', source, name: 'Actor portrait', createdAt: 1, favorite: false, origin: 'uploaded', metadata: {} };

beforeEach(() => useCanvasStore.setState({ nodes: [], edges: [], revision: 0, selectedNodeId: null,
  history: { past: [], future: [] }, currentViewport: { x: 0, y: 0, zoom: 1 }, canvasViewportSize: { width: 1280, height: 720 } }));

describe('character canvas application', () => {
  it('produces a typed executable image-node command prefilled with the main image and name', async () => {
    const command = await createCharacterCanvasCommand(character, { x: 10, y: 20 }, 'actor-node', { resolveAsset: async () => asset });
    expect(command).toEqual({ type: 'node.create', version: 1, input: { nodeType: 'imageNode', nodeId: 'actor-node', position: { x: 10, y: 20 }, configuration: { displayName: 'Actor', imageUrl: source } } });
    const result = canvasCommandRegistry.executeTransaction({ id: 'apply-character', origin: 'ui', expectedRevision: 0, commands: [command] });
    expect(result.ok).toBe(true);
    expect(useCanvasStore.getState().nodes[0]).toMatchObject({ id: 'actor-node', type: 'imageNode', data: { displayName: 'Actor', imageUrl: source } });
    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes).toEqual([]);
  });
  it('rejects missing/incorrect assets, empty character images and invalid positions before command creation', async () => {
    await expect(createCharacterCanvasCommand(character, undefined, undefined, { resolveAsset: async () => null })).rejects.toMatchObject({ code: 'assetNotFound' });
    expect(() => buildCharacterCanvasCommand({ ...character, images: [], mainImage: null }, asset)).toThrow();
    expect(() => buildCharacterCanvasCommand(character, { ...asset, id: 'other' })).toThrow();
    expect(() => buildCharacterCanvasCommand(character, asset, { x: Number.NaN, y: 0 })).toThrow();
  });
});

describe('generic image-prefill registry boundary', () => {
  it.each([source, '/Users/test/media/portrait.png', 'C:\\media\\portrait.png', 'asset://localhost/portrait.png', 'https://images.example.test/portrait.png'])('accepts durable image sources %s', (imageUrl) => {
    const command = { type: 'node.create' as const, version: 1 as const, input: { nodeType: 'uploadNode' as const, position: { x: 0, y: 0 }, configuration: { imageUrl } } };
    const result = canvasCommandRegistry.executeTransaction({ id: 'durable-source', origin: 'agent', expectedRevision: 0, commands: [command] });
    expect(result.ok).toBe(true);
    expect(useCanvasStore.getState().nodes[0].data).toMatchObject({ imageUrl });
  });
  it.each(['blob:old-session', 'data:image/png;base64,AQID', 'file:///etc/passwd', '/etc/passwd', 'javascript:alert(1)', 'ftp://example.test/a.png', 'relative.png', 'asset-media:image%2Fpng:broken', ' https://example.test/a.png', '//remote/path', 'https://user:secret@example.test/a.png'])('rejects unsafe/non-durable source %s without mutating graph', (imageUrl) => {
    const command = { type: 'node.create' as const, version: 1 as const, input: { nodeType: 'imageNode' as const, position: { x: 0, y: 0 }, configuration: { imageUrl } } };
    const result = canvasCommandRegistry.executeTransaction({ id: 'invalid-source', origin: 'agent', expectedRevision: 0, commands: [command] });
    expect(result.ok).toBe(false);
    expect(useCanvasStore.getState().nodes).toEqual([]);
    expect(useCanvasStore.getState().revision).toBe(0);
  });
  it('does not expose image source fields on non-image node types', () => {
    const result = canvasCommandRegistry.executeTransaction({ id: 'invalid-type', origin: 'agent', expectedRevision: 0, commands: [{ type: 'node.create', version: 1,
      input: { nodeType: 'textAnnotationNode', position: { x: 0, y: 0 }, configuration: { imageUrl: source } } }] });
    expect(result.ok).toBe(false);
    expect(useCanvasStore.getState().nodes).toEqual([]);
  });
});
