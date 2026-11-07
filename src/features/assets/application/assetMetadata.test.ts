import { describe, expect, it } from 'vitest';
import { normalizeAssetMetadata } from './assetMetadata';

describe('asset generation metadata', () => {
  it('uses submitted native mode parameters instead of unrelated legacy picker defaults', () => {
    const metadata = normalizeAssetMetadata({ sourceModelId: 'original-model', generationLastJobId: 'original-job',
      config: { size: '1K', aspectRatio: '1:1', seconds: 5, extraParams: { resolution: '1080p', ratio: '16:9', duration: 8 } },
      generationDebugContext: { private: 'not asset metadata' } });
    expect(metadata).toMatchObject({ model: 'original-model', jobId: 'original-job', resolution: '1080p', aspectRatio: '16:9', durationSeconds: 8 });
    expect(metadata.width).toBeUndefined();
    expect(metadata.height).toBeUndefined();
    expect(metadata.generationDebugContext).toBeUndefined();
    expect(metadata.config).toEqual({ size: '1K', aspectRatio: '1:1', seconds: 5, extraParams: { resolution: '1080p', ratio: '16:9', duration: 8 } });
  });

  it('retains structured duration/resolution choices and imported provenance without recursively nesting metadata', () => {
    const metadata = normalizeAssetMetadata({ assetMetadata: { model: 'original-model', jobId: 'original-job', width: 1920, height: 1080,
      references: ['/reference.png'], config: { extraParams: { output: { resolution: '1080P', duration: 6 } } } }, sourcePrompt: 'Source prompt' });
    expect(metadata).toMatchObject({ model: 'original-model', jobId: 'original-job', width: 1920, height: 1080,
      resolution: '1080P', durationSeconds: 6, references: ['/reference.png'], sourcePrompt: 'Source prompt' });
    expect(metadata.assetMetadata).toBeUndefined();
    expect(normalizeAssetMetadata(metadata)).toEqual(metadata);
  });
});
