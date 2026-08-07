import { describe, expect, it } from 'vitest';
import type { ProjectRecord } from '@/commands/projectState';
import {
  PROJECT_BUNDLE_FORMAT,
  PROJECT_BUNDLE_SCHEMA_VERSION,
} from './types';
import {
  isSafeBundlePath,
  migrateProjectBundlePayload,
  validateProjectBundleManifest,
  validateSettingsBundle,
} from './validation';

const record: ProjectRecord = {
  id: 'project-1',
  name: 'Fixture',
  createdAt: 1,
  updatedAt: 2,
  nodeCount: 0,
  nodesJson: '[]',
  edgesJson: '[]',
  viewportJson: '{"x":0,"y":0,"zoom":1}',
  historyJson: '{"past":[],"future":[]}',
  imagePoolJson: '[]',
};

describe('project portability validation', () => {
  it('rejects unsafe bundle paths', () => {
    expect(isSafeBundlePath('../secret')).toBe(false);
    expect(isSafeBundlePath('assets/../../secret')).toBe(false);
    expect(isSafeBundlePath('/tmp/secret')).toBe(false);
    expect(isSafeBundlePath('C:\\secret')).toBe(false);
    expect(isSafeBundlePath('assets\\hash.png')).toBe(false);
    expect(isSafeBundlePath('assets/./hash.png')).toBe(false);
    expect(isSafeBundlePath('assets/hash.png')).toBe(true);
  });

  it('migrates the version 0 project fixture', () => {
    expect(migrateProjectBundlePayload({ schemaVersion: 0, project: record })).toEqual({
      schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
      record,
    });
  });

  it('rejects a future manifest schema', () => {
    expect(() => validateProjectBundleManifest({
      format: PROJECT_BUNDLE_FORMAT,
      schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION + 1,
      appVersion: 'future',
      createdAt: new Date().toISOString(),
      project: { id: record.id, name: record.name, nodeCount: 0 },
      assets: [],
    })).toThrow(/newer application version/i);
  });

  it('requires integer counts, runtime project shapes, and hash-named assets', () => {
    const hash = 'a'.repeat(64);
    const manifest = {
      format: PROJECT_BUNDLE_FORMAT,
      schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
      appVersion: '1.0.0',
      createdAt: new Date().toISOString(),
      project: { id: record.id, name: record.name, nodeCount: 0 },
      assets: [{
        path: `assets/${hash}.png`,
        sha256: hash,
        size: 1,
        mediaType: 'image',
        roles: ['nodes[0].data.imageUrl'],
      }],
    };
    expect(validateProjectBundleManifest(manifest).assets).toHaveLength(1);
    expect(() => validateProjectBundleManifest({
      ...manifest,
      assets: [{ ...manifest.assets[0], size: 0.5 }],
    })).toThrow(/single-file limit/i);
    expect(() => validateProjectBundleManifest({
      ...manifest,
      assets: [{ ...manifest.assets[0], mediaType: 'document' }],
    })).toThrow(/media type/i);
    expect(() => validateProjectBundleManifest({
      ...manifest,
      assets: [{ ...manifest.assets[0], path: `assets/${'b'.repeat(64)}.png` }],
    })).toThrow(/content hash/i);

    expect(() => migrateProjectBundlePayload({
      schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
      record: { ...record, nodeCount: 1 },
    })).toThrow(/node count/i);
    expect(() => migrateProjectBundlePayload({
      schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
      record: { ...record, edgesJson: '{}' },
    })).toThrow(/edgesJson/i);
    expect(() => migrateProjectBundlePayload({
      schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
      record: { ...record, viewportJson: '{"x":0,"y":0,"zoom":0}' },
    })).toThrow(/viewportJson/i);
    expect(() => migrateProjectBundlePayload({
      schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
      record: { ...record, historyJson: '[]' },
    })).toThrow(/historyJson/i);
  });

  it('rejects malformed or inconsistently declared settings credentials', () => {
    const base = {
      format: 'open-storyboard-settings',
      schemaVersion: 1,
      appVersion: '1.0.0',
      createdAt: new Date().toISOString(),
      categories: { general: {} },
    };
    expect(() => validateSettingsBundle({
      ...base,
      includesCredentials: false,
      credentials: { providerApiKeys: { provider: 'secret' } },
    })).toThrow(/not allowed/i);
    expect(() => validateSettingsBundle({
      ...base,
      includesCredentials: true,
      credentials: { providerApiKeys: { provider: 42 } },
    })).toThrow(/string map/i);
    expect(() => validateSettingsBundle({
      ...base,
      includesCredentials: true,
      credentials: { imageHost: { token: ['bad'] } },
    })).toThrow(/must be a string/i);
  });
});
