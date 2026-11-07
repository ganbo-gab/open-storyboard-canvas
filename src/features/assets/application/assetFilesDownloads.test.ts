import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { assetFileKind, importAssetFile } from './assetFiles';
import { createAssetCatalogDocument, downloadSourcesFor } from './assetCatalog';
import { prepareAssetDownload } from './assetDownloads';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock('@/commands/projectState', () => ({ listProjectSummaries: vi.fn(async () => []), getProjectRecord: vi.fn() }));
beforeAll(() => {
  const values: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => { values[key] = value; },
    removeItem: (key: string) => { delete values[key]; },
  });
});

describe('asset upload and text download boundary', () => {
  it('classifies supported uploads without treating unknown binary documents as text', async () => {
    expect(assetFileKind({ name: 'image.png', type: 'image/png' })).toBe('image');
    expect(assetFileKind({ name: 'clip.mp4', type: 'video/mp4' })).toBe('video');
    expect(assetFileKind({ name: 'voice.wav', type: 'audio/wav' })).toBe('audio');
    expect(assetFileKind({ name: 'script.md', type: '' })).toBe('text');
    expect(assetFileKind({ name: 'data.json', type: 'application/json' })).toBe('text');
    expect(assetFileKind({ name: 'script.txt', type: 'application/pdf' })).toBeNull();
    expect(assetFileKind({ name: 'archive.zip', type: 'application/octet-stream' })).toBeNull();
    await expect(importAssetFile(new File(['%PDF-1.7'], 'binary.pdf', { type: 'application/pdf' }))).rejects.toThrow('Unsupported');
  });

  it('uploads, reopens and downloads Unicode text as literal content, including URL-like prefixes', async () => {
    const content = 'asset-media:literal script\n场景一 🎬\nhttps://example.invalid/not-a-request\n';
    const asset = await importAssetFile(new File([content], 'story.md', { type: 'text/markdown' }));
    expect(asset).toMatchObject({ kind: 'text', source: content, origin: 'uploaded',
      metadata: { originalFileName: 'story.md', mime: 'text/markdown', size: new TextEncoder().encode(content).byteLength } });
    const reopened = createAssetCatalogDocument();
    await reopened.initialize?.();
    expect(reopened.load().saved[asset.id].source).toBe(content);
    const [original] = await downloadSourcesFor([asset.id]);
    const download = await prepareAssetDownload(original);
    expect(download.name).toBe('story.md');
    expect((await fetch(download.url)).headers.get('content-type')).toBe('text/plain;charset=utf-8');
    expect(await (await fetch(download.url)).text()).toBe(content);
    const plain = await prepareAssetDownload({ id: 'text', name: 'Untitled', kind: 'text', source: 'data:image/png;base64,literal text' });
    expect(plain.name).toBe('Untitled.txt');
    expect(await (await fetch(plain.url)).text()).toBe('data:image/png;base64,literal text');
  });
});
