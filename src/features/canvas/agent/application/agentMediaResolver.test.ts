import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentMediaReference,
  createAgentCanvasMediaInput,
  findAgentNodeImageSource,
  inspectAgentMediaReference,
  prepareAgentMediaSource,
  resolveAgentMediaReference,
  resolveOpaqueAgentMediaReference,
  restoreAgentMediaReferenceFromCanvas,
  revokeAgentMediaRun,
  toOpaqueAgentMediaReference,
  validateAgentTurnMediaInputs,
  validateAgentImageFile,
} from './agentMediaResolver';

describe('agent media resolver', () => {
  afterEach(() => revokeAgentMediaRun('run'));

  it('keeps the media source in temporary memory and exposes only stable metadata', () => {
    const source = 'data:image/png;base64,AAAA';
    const reference = createAgentMediaReference('run', 'node-1', source);
    expect(reference).toEqual({ id: 'run:node-1' });
    expect(inspectAgentMediaReference(reference.id)).toMatchObject({ runId: 'run', nodeId: 'node-1', mimeType: 'image/png' });
    expect(inspectAgentMediaReference(reference.id)).not.toHaveProperty('source');
    expect(resolveAgentMediaReference(reference.id)).toBe(source);
    const opaque = toOpaqueAgentMediaReference(reference);
    expect(opaque).toMatch(/^agent-media-ref:/);
    expect(opaque).not.toContain(source);
    expect(resolveOpaqueAgentMediaReference(opaque)).toBe(source);
    expect(resolveOpaqueAgentMediaReference('agent-media-ref:missing')).toBeNull();
  });

  it('fails closed for expired, local-path, non-image, and over-broad references', () => {
    const reference = createAgentMediaReference('run', 'node-1', 'https://assets.example/shot.png');
    expect(resolveAgentMediaReference(reference.id, Date.now() + 31 * 60_000)).toBeNull();
    expect(() => createAgentMediaReference('run', 'local', '/Users/example/secret.png')).toThrow(/绝对路径/);
    expect(() => createAgentMediaReference('run', 'text', 'data:text/plain;base64,AAAA')).toThrow(/图片/);
    for (let index = 0; index < 8; index += 1) createAgentMediaReference('run', `image-${index}`, `https://assets.example/${index}.png`);
    expect(() => createAgentMediaReference('run', 'image-9', 'https://assets.example/9.png')).toThrow(/最多引用/);
  });

  it('selects only a safe image field from canvas node data', () => {
    expect(findAgentNodeImageSource({ previewImageUrl: '', imageUrl: 'https://assets.example/image.webp' })).toBe('https://assets.example/image.webp');
    expect(findAgentNodeImageSource({ imageUrl: '/Users/example/image.png', content: 'text' })).toBeNull();
    expect(findAgentNodeImageSource(null)).toBeNull();
  });

  it('restores a persisted remote asset reference from the active canvas', () => {
    const source = 'https://assets.example/frame.png';
    const restored = restoreAgentMediaReferenceFromCanvas('old-run:node-1:image', [{
      id: 'node-1',
      type: 'uploadNode',
      position: { x: 0, y: 0 },
      data: { imageUrl: source },
    }] as any);
    expect(restored).toBe(source);
    expect(resolveAgentMediaReference('old-run:node-1:image')).toBe(source);
    revokeAgentMediaRun('old-run');
  });

  it('validates upload MIME, bytes, and decoded pixel limits', async () => {
    await expect(validateAgentImageFile(new File([], 'empty.png', { type: 'image/png' })))
      .rejects.toThrow(/为空/);
    await expect(validateAgentImageFile(new File(['x'], 'note.txt', { type: 'text/plain' })))
      .rejects.toThrow(/仅支持/);

    const original = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async () => ({ width: 20_000, height: 10, close() {} }) as ImageBitmap;
    await expect(validateAgentImageFile(new File(['x'], 'wide.png', { type: 'image/png' })))
      .rejects.toThrow(/边长/);
    globalThis.createImageBitmap = original;
  });

  it('keeps remote media URLs without forcing a download', async () => {
    await expect(prepareAgentMediaSource('https://assets.example/frame.webp'))
      .resolves.toBe('https://assets.example/frame.webp');
  });

  it('builds bounded turn media from stable canvas asset ids', () => {
    const media = createAgentCanvasMediaInput({
      id: 'node-1:image',
      nodeId: 'node-1',
      kind: 'image',
      title: 'Hero reference',
      sourceLabel: 'Upload',
      order: 1,
      url: 'https://assets.example/full.png',
      previewUrl: 'https://assets.example/preview.png',
    });
    expect(media).toMatchObject({
      assetId: 'node-1:image',
      nodeId: 'node-1',
      origin: 'canvas-asset',
      source: 'https://assets.example/preview.png',
    });
    expect(validateAgentTurnMediaInputs([media])).toEqual([media]);
    expect(() => validateAgentTurnMediaInputs([media, media])).toThrow(/duplicate|重复/i);
  });
});
