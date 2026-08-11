import { describe, expect, it } from 'vitest';
import { buildExternalAgentAttachments } from './externalAgentMediaAdapter';

describe('external Agent media adapter', () => {
  it('creates bounded transient IPC attachments without source paths', async () => {
    const attachments = await buildExternalAgentAttachments([{
      assetId: 'node-1:image',
      nodeId: 'node-1',
      title: 'Scene / reference.png',
      origin: 'canvas-asset',
      source: 'data:image/png;base64,AQID',
    }]);
    expect(attachments).toEqual([expect.objectContaining({
      mimeType: 'image/png',
      bytesBase64: 'AQID',
      title: 'Scene reference.png',
    })]);
    expect(JSON.stringify(attachments)).not.toContain('node-1:image');
    expect(JSON.stringify(attachments)).not.toContain('source');
  });

  it('rejects absolute local paths before IPC staging', async () => {
    await expect(buildExternalAgentAttachments([{
      assetId: 'node-1:image',
      nodeId: 'node-1',
      title: 'Private',
      origin: 'canvas-asset',
      source: '/Users/alice/private.png',
    }])).rejects.toThrow(/绝对路径/);
  });
});
