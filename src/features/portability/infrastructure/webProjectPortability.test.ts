import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteProjectRecord,
  getProjectRecord,
  upsertProjectRecord,
  type ProjectRecord,
} from '@/commands/projectState';
import {
  PROJECT_BUNDLE_MAX_JSON_BYTES,
  WEB_PROJECT_BUNDLE_MAX_BYTES,
} from '../application/types';
import {
  assertWebProjectArchiveEntrySize,
  assertWebProjectBundleInputSize,
  exportWebProjectBundle,
  importWebProjectBundle,
  inspectWebProjectBundle,
} from './webProjectPortability';

const createdIds: string[] = [];

afterEach(async () => {
  await Promise.all(createdIds.splice(0).map((id) => deleteProjectRecord(id)));
});

function fixtureRecord(): ProjectRecord {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  return {
    id: 'portability-source',
    name: 'Portable Project',
    createdAt: 1,
    updatedAt: 2,
    nodeCount: 1,
    nodesJson: JSON.stringify([{ id: 'node', data: { imageUrl: '__img_ref__:0' } }]),
    edgesJson: '[]',
    viewportJson: '{"x":0,"y":0,"zoom":1}',
    historyJson: JSON.stringify({ past: [], future: [], imagePool: [image] }),
    imagePoolJson: JSON.stringify([image]),
  };
}

describe('web project portability', () => {
  it('round-trips a project under a new id', async () => {
    const source = fixtureRecord();
    createdIds.push(source.id);
    await upsertProjectRecord(source);
    const exported = await exportWebProjectBundle(source.id);
    const inspected = await inspectWebProjectBundle(exported.bytes);
    const imported = await importWebProjectBundle(inspected, { kind: 'new' }, ' (Imported)');
    createdIds.push(imported.project.id);
    const restored = await getProjectRecord(imported.project.id);
    expect(restored?.id).not.toBe(source.id);
    expect(restored?.name).toBe('Portable Project (Imported)');
    expect(restored?.nodesJson).toBe(source.nodesJson);
    expect(restored?.imagePoolJson).toContain('data:image/png;base64');
  });

  it('rejects traversal, undeclared files, and checksum corruption', async () => {
    await expect(inspectWebProjectBundle(zipSync({
      '../manifest.json': strToU8('{}'),
    }))).rejects.toThrow(/unsafe/i);

    const source = fixtureRecord();
    createdIds.push(source.id);
    await upsertProjectRecord(source);
    const exported = await exportWebProjectBundle(source.id);
    const files = unzipSync(exported.bytes);
    await expect(inspectWebProjectBundle(zipSync({
      ...files,
      'extra.txt': strToU8('undeclared'),
    }))).rejects.toThrow(/undeclared/i);

    const manifest = JSON.parse(strFromU8(files['manifest.json'])) as { assets: Array<{ path: string }> };
    files[manifest.assets[0].path] = strToU8('corrupted');
    await expect(inspectWebProjectBundle(zipSync(files))).rejects.toThrow(/checksum/i);
  });

  it('enforces Web archive and critical JSON byte limits before parsing', () => {
    expect(() => assertWebProjectBundleInputSize(WEB_PROJECT_BUNDLE_MAX_BYTES + 1)).toThrow(/512 MB/i);
    expect(() => assertWebProjectArchiveEntrySize(
      'project.json',
      PROJECT_BUNDLE_MAX_JSON_BYTES + 1
    )).toThrow(/size limit/i);
    expect(() => assertWebProjectArchiveEntrySize('asset.bin', 1024)).not.toThrow();
  });

  it('reports and rewrites project bundle references omitted from the manifest', async () => {
    const source = fixtureRecord();
    createdIds.push(source.id);
    await upsertProjectRecord(source);
    const exported = await exportWebProjectBundle(source.id);
    const files = unzipSync(exported.bytes);
    const payload = JSON.parse(strFromU8(files['project.json'])) as {
      record: ProjectRecord;
    };
    const missingHash = 'b'.repeat(64);
    payload.record.nodesJson = JSON.stringify([{
      id: 'node',
      data: { imageUrl: `bundle://assets/${missingHash}.png` },
    }]);
    files['project.json'] = strToU8(JSON.stringify(payload));

    const inspected = await inspectWebProjectBundle(zipSync(files));
    expect(inspected.preview.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-asset', path: `assets/${missingHash}.png` }),
    ]));
    const imported = await importWebProjectBundle(inspected, { kind: 'new' }, ' (Imported)');
    createdIds.push(imported.project.id);
    const restored = await getProjectRecord(imported.project.id);
    expect(restored?.nodesJson).toContain(`bundle-missing://assets/${missingHash}.png`);
  });

  it('round-trips nested image, video, audio, panorama, and Director Studio media', async () => {
    const source = fixtureRecord();
    source.id = 'portability-mixed-media';
    source.nodesJson = JSON.stringify([{
      id: 'node',
      data: {
        localVideoUrl: 'data:video/mp4;base64,dmlkZW8=',
        localAudioUrl: 'data:audio/wav;base64,YXVkaW8=',
        backgroundPanoramaUrl: 'data:image/jpeg;base64,cGFub3JhbWE=',
        directorStudioProjects: [{
          coverUrl: 'data:image/png;base64,Y292ZXI=',
          snapshot: {
            snapshotHistory: ['data:image/png;base64,aGlzdG9yeQ=='],
            referenceImages: [{ url: 'data:image/png;base64,cmVm' }],
          },
        }],
      },
    }]);
    createdIds.push(source.id);
    await upsertProjectRecord(source);

    const exported = await exportWebProjectBundle(source.id);
    expect(new Set(exported.preview.manifest.assets.map((asset) => asset.mediaType))).toEqual(
      new Set(['image', 'video', 'audio'])
    );
    const inspected = await inspectWebProjectBundle(exported.bytes);
    const imported = await importWebProjectBundle(inspected, { kind: 'new' }, ' (Imported)');
    createdIds.push(imported.project.id);
    const restored = await getProjectRecord(imported.project.id);
    expect(restored?.nodesJson).toContain('data:video/mp4;base64');
    expect(restored?.nodesJson).toContain('data:audio/wav;base64');
    expect(restored?.nodesJson).toContain('data:image/jpeg;base64');
    expect(restored?.nodesJson).toContain('data:image/png;base64');
  });
});
