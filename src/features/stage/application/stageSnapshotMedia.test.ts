import { expect, it } from 'vitest';
import { screenshotExportOptions } from './stageSnapshotMedia';
it('preserves long-edge sizing for portrait, landscape and full viewport captures', () => {
  expect(screenshotExportOptions(16 / 9, 1080, { width: 900, height: 600 })).toEqual({ frameAspect: 16 / 9, targetWidth: 1920, targetHeight: 1080 });
  expect(screenshotExportOptions(9 / 16, 1080, { width: 900, height: 600 })).toEqual({ frameAspect: 9 / 16, targetWidth: 1080, targetHeight: 1920 });
  expect(screenshotExportOptions(null, 1080, { width: 900, height: 600 })).toEqual({ targetWidth: 1620, targetHeight: 1080 });
});
