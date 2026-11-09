import { describe, expect, it } from 'vitest';
import { readGenerationConfiguration } from './generationConfiguration';
import { nodeCatalog } from '../application/nodeCatalog';
import { CANVAS_NODE_TYPES } from './canvasNodes';

describe('generation configuration authority', () => {
  it('uses the selected model and pixel size instead of stale factory values', () => {
    expect(readGenerationConfiguration({ model: 'kie/nano-banana-2', size: '2K', aspectRatio: '1:1',
      extraParams: { size: '4096x4096' }, modelConfig: { entryId: 'custom:configured:gpt-image-2.6', ratio: 'auto',
        extraParams: { size: '1024x576', quality: 'high', n: 1 } } })).toEqual({
      source: 'modelConfig', model: 'custom:configured:gpt-image-2.6', size: '1024x576', aspectRatio: '16:9',
      extraParams: { size: '1024x576', quality: 'high', n: 1 },
    });
  });
  it('never borrows size, ratio or params from another legacy model when the current configuration omits them', () => {
    expect(readGenerationConfiguration({ model: 'kie/nano-banana-2', size: '2K', aspectRatio: '1:1', extraParams: { seed: 8 },
      modelConfig: { entryId: 'custom:new-model', ratio: 'auto' } })).toEqual({
      source: 'modelConfig', model: 'custom:new-model', size: undefined, aspectRatio: 'auto', extraParams: {},
    });
  });
  it('preserves explicitly stored legacy-only configuration without upgrading or inventing a provider', () => {
    expect(readGenerationConfiguration({ model: 'legacy-choice', size: '4K', requestAspectRatio: '9:16' }))
      .toMatchObject({ source: 'legacy', model: 'legacy-choice', size: '4K', aspectRatio: '9:16' });
    expect(readGenerationConfiguration({ model: 'old', modelConfig: { entryId: '' } }))
      .toEqual({ source: 'unconfigured', extraParams: {} });
  });
  it.each([CANVAS_NODE_TYPES.imageEdit, CANVAS_NODE_TYPES.storyboardGen])('does not seed new %s nodes with a fictitious model or resolution', (kind) => {
    const data = nodeCatalog.getDefinition(kind).createDefaultData();
    expect(data).not.toHaveProperty('model'); expect(data).not.toHaveProperty('size');
    expect(readGenerationConfiguration(data).model).toBeUndefined();
  });
});
