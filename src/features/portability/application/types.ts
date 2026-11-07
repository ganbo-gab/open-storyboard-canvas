import type { ProjectRecord } from '@/commands/projectState';

export const PROJECT_BUNDLE_FORMAT = 'open-storyboard-project' as const;
export const PROJECT_BUNDLE_SCHEMA_VERSION = 1 as const;
export const SETTINGS_BUNDLE_FORMAT = 'open-storyboard-settings' as const;
export const SETTINGS_BUNDLE_SCHEMA_VERSION = 2 as const;

export const PROJECT_BUNDLE_LIMITS = {
  maxExpandedBytes: 4 * 1024 * 1024 * 1024,
  maxFileBytes: 1024 * 1024 * 1024,
  maxFiles: 10_000,
} as const;

export const PROJECT_BUNDLE_MAX_JSON_BYTES = 64 * 1024 * 1024;
export const WEB_PROJECT_BUNDLE_MAX_BYTES = 512 * 1024 * 1024;
export const SETTINGS_BUNDLE_MAX_BYTES = 16 * 1024 * 1024;

export type BundleMediaType = 'image' | 'video' | 'audio' | 'binary';

export interface ProjectBundleAsset {
  path: string;
  sha256: string;
  size: number;
  mediaType: BundleMediaType;
  roles: string[];
}

export interface ProjectBundleManifest {
  format: typeof PROJECT_BUNDLE_FORMAT;
  schemaVersion: typeof PROJECT_BUNDLE_SCHEMA_VERSION;
  appVersion: string;
  createdAt: string;
  project: {
    id: string;
    name: string;
    nodeCount: number;
  };
  assets: ProjectBundleAsset[];
}

export interface ProjectBundlePayload {
  schemaVersion: typeof PROJECT_BUNDLE_SCHEMA_VERSION;
  record: ProjectRecord;
}

export interface ProjectBundleWarning {
  code: 'missing-asset' | 'unreadable-source' | 'external-source' | 'unknown-media';
  message: string;
  path?: string;
}

export interface ProjectBundlePreview {
  manifest: ProjectBundleManifest;
  projectName: string;
  nodeCount: number;
  assetCount: number;
  assetBytes: number;
  warnings: ProjectBundleWarning[];
}

export type ProjectImportMode =
  | { kind: 'new' }
  | { kind: 'replace'; projectId: string };

export interface ProjectImportResult {
  project: {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    nodeCount: number;
  };
  warnings: ProjectBundleWarning[];
}

export type PortabilityProgressStage =
  | 'reading'
  | 'packing'
  | 'validating'
  | 'extracting'
  | 'committing'
  | 'done';

export interface PortabilityProgress {
  stage: PortabilityProgressStage;
  completed: number;
  total: number;
}

export interface SettingsBundlePayload {
  format: typeof SETTINGS_BUNDLE_FORMAT;
  schemaVersion: 1 | typeof SETTINGS_BUNDLE_SCHEMA_VERSION;
  appVersion: string;
  createdAt: string;
  /** Legacy metadata retained for readers; portable bundles never contain vault values. */
  includesCredentials: false;
  categories: Record<string, Record<string, unknown>>;
}

export interface SettingsCategoryDiff {
  category: string;
  status: 'add' | 'update' | 'unchanged' | 'conflict';
  changedFields: string[];
  fields: SettingsFieldDiff[];
}

/** Truncated JSON text of a setting; credentials never reach previews. */
export type SettingsPreviewValue = string;

export interface SettingsFieldDiff {
  field: string;
  before: SettingsPreviewValue;
  after: SettingsPreviewValue;
  sensitive?: boolean;
}
