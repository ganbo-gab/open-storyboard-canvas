import { expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import { projectCanvasNodeForRead } from './canvasReadProjection';

it.each([CANVAS_NODE_TYPES.imageEdit, CANVAS_NODE_TYPES.storyboardGen, CANVAS_NODE_TYPES.aiVideo])('reads current %s settings without presenting stale model defaults as active', (type) => {
  const node: CanvasNode = { id: 'generator', type, position: { x: 0, y: 0 }, data: {
    imageUrl: null, prompt: 'Test configuration',
    model: 'kie/nano-banana-2', modelId: 'old-model-alias', size: '2K', resolution: 'old-resolution', aspectRatio: '1:1',
    requestAspectRatio: '4:3', extraParams: { stale: true },
    modelConfig: { entryId: 'custom:fixture:gpt-image-2.6', ratio: 'auto', extraParams: { n: 1, size: '1024x576', quality: 'high', apiKey: 'PRIVATE_FIXTURE' } },
  } };
  const before = structuredClone(node);
  const view = projectCanvasNodeForRead(node);
  expect(view).toMatchObject({ data: {
    model: 'custom:fixture:gpt-image-2.6', size: '1024x576', requestAspectRatio: '16:9', displayAspectRatio: undefined,
    extraParams: { n: 1, size: '1024x576', quality: 'high', apiKey: '[redacted]' },
    generationConfiguration: { source: 'modelConfig', meaning: 'current-configuration', model: 'custom:fixture:gpt-image-2.6', aspectRatio: '16:9' },
  } });
  const text = JSON.stringify(view);
  for (const stale of ['kie/nano-banana-2', 'old-model-alias', 'old-resolution', 'PRIVATE_FIXTURE', '"stale"']) expect(text).not.toContain(stale);
  expect(node).toEqual(before);
});

it('does not inherit missing current settings from old image defaults', () => {
  const view = projectCanvasNodeForRead({ id: 'generator', type: CANVAS_NODE_TYPES.imageEdit, position: { x: 0, y: 0 }, data: {
    imageUrl: null, prompt: 'Test configuration',
    model: 'old-model', size: '2K', aspectRatio: '1:1', modelConfig: { entryId: 'custom:fixture:current' },
  } });
  expect(view).toMatchObject({ data: { model: 'custom:fixture:current', size: undefined, requestAspectRatio: undefined,
    displayAspectRatio: undefined, generationConfiguration: { source: 'modelConfig' } } });
});

it('keeps a legacy-only generator readable and leaves result media provenance intact', () => {
  const legacy: CanvasNode = { id: 'legacy', type: CANVAS_NODE_TYPES.imageEdit, position: { x: 0, y: 0 },
    data: { imageUrl: 'asset-media:existing-image', prompt: 'Legacy configuration', model: 'legacy-selected', size: '4K', aspectRatio: '1:1', requestAspectRatio: '9:16' } };
  expect(projectCanvasNodeForRead(legacy)).toMatchObject({ data: { model: 'legacy-selected', size: '4K', requestAspectRatio: '9:16',
    displayAspectRatio: '1:1', generationConfiguration: { source: 'legacy' } } });
  const result: CanvasNode = { ...legacy, type: CANVAS_NODE_TYPES.exportImage, data: { imageUrl: null, model: 'historical-model', size: '2K', aspectRatio: '3:2' } };
  expect(projectCanvasNodeForRead(result)).toMatchObject({ data: result.data });
  expect(projectCanvasNodeForRead(result)).not.toHaveProperty('data.generationConfiguration');
});
