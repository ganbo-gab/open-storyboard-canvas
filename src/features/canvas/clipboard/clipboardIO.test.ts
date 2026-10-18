import { describe, expect, it } from 'vitest';

import { fingerprintClipboardContent, fingerprintMediaFile } from './clipboardIO';

describe('clipboard fingerprints', () => {
  it('matches browser image files with equivalent Tauri image bytes regardless of file metadata', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 19]);
    const browserFile = new File([bytes], 'browser-image.png', {
      type: 'image/png',
      lastModified: 123,
    });
    const renamedFile = new File([bytes], 'pasted-image.png', {
      type: 'image/png',
      lastModified: 456,
    });
    const tauriFingerprint = fingerprintClipboardContent({
      image: { bytes: Array.from(bytes), mimeType: 'image/png' },
      text: 'image clipboard text must not take precedence',
    });

    expect(await fingerprintMediaFile(browserFile)).toBe(tauriFingerprint);
    expect(await fingerprintMediaFile(renamedFile)).toBe(tauriFingerprint);
    expect(await fingerprintMediaFile(new File([new Uint8Array([137, 80, 78, 71, 0, 254, 19])], 'changed.png', {
      type: 'image/png',
    }))).not.toBe(tauriFingerprint);
  });

  it('normalizes surrounding text whitespace and treats whitespace-only content as empty', () => {
    expect(fingerprintClipboardContent({ text: '  copied text\n' }))
      .toBe(fingerprintClipboardContent({ text: 'copied text' }));
    expect(fingerprintClipboardContent({ text: 'copied Text' }))
      .not.toBe(fingerprintClipboardContent({ text: 'copied text' }));
    expect(fingerprintClipboardContent({ text: ' \n\t ' })).toBeNull();
  });
});
