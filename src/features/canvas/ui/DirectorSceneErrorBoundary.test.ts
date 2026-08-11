import { describe, expect, it } from 'vitest';

import { isDirectorSceneModuleLoadError } from './DirectorSceneErrorBoundary';

describe('isDirectorSceneModuleLoadError', () => {
  it('recognizes browser dynamic import and chunk failures', () => {
    expect(isDirectorSceneModuleLoadError(
      new TypeError('Failed to fetch dynamically imported module: /BlueprintScene.js'),
    )).toBe(true);
    expect(isDirectorSceneModuleLoadError(new Error('ChunkLoadError: Loading chunk 42 failed.'))).toBe(true);
  });

  it('keeps ordinary scene render failures retryable without a page reload', () => {
    expect(isDirectorSceneModuleLoadError(new Error('WebGL context lost'))).toBe(false);
  });
});
