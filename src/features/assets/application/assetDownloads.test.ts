// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadAsset } from './assetDownloads';

afterEach(() => vi.restoreAllMocks());

describe('explicit asset download action', () => {
  it('exports text content as UTF-8 bytes with a text filename and removes the temporary download element', async () => {
    const content = 'asset-media:literal text\n分镜 🎬\n';
    let exportedUrl = '';
    let exportedName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      exportedUrl = this.href;
      exportedName = this.download;
      expect(document.body.contains(this)).toBe(true);
    });
    await downloadAsset({ id: 'script', kind: 'text', name: 'Storyboard', source: content });
    expect(exportedName).toBe('Storyboard.txt');
    expect(await (await fetch(exportedUrl)).text()).toBe(content);
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
