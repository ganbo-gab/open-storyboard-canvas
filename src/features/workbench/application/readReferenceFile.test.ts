// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isReferenceFile, readReferenceFile } from './readReferenceFile';

describe('reference file type boundary', () => {
  it('rejects binary documents rather than silently labeling them as images', async () => {
    const file = new File(['%PDF-1.7'], 'script.pdf', { type: 'application/pdf' });
    expect(isReferenceFile(file)).toBe(false);
    await expect(readReferenceFile(file)).rejects.toThrow();
  });

  it.each(['image/png', 'video/mp4', 'audio/wav'])('reads declared %s media without changing its bytes or type', async (mime) => {
    const file = new File(['media bytes'], 'reference', { type: mime });
    expect(isReferenceFile(file)).toBe(true);
    const reference = await readReferenceFile(file);
    expect(reference.kind).toBe(mime.split('/')[0]);
    expect(reference.name).toBe('reference');
    expect(reference.source).toBe(`data:${mime};base64,bWVkaWEgYnl0ZXM=`);
  });
});
