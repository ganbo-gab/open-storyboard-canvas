import type { ProjectRecord } from '@/commands/projectState';
import {
  PROJECT_BUNDLE_FORMAT,
  PROJECT_BUNDLE_LIMITS,
  PROJECT_BUNDLE_SCHEMA_VERSION,
  SETTINGS_BUNDLE_FORMAT,
  SETTINGS_BUNDLE_SCHEMA_VERSION,
  type ProjectBundleAsset,
  type ProjectBundleManifest,
  type ProjectBundlePayload,
  type SettingsBundlePayload,
} from './types';

export class PortabilityValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PortabilityValidationError';
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isSafeBundlePath(path: string): boolean {
  if (!path
    || path.includes('\\')
    || path.includes('\0')
    || path.startsWith('/')
    || /^[a-zA-Z]:/.test(path)) {
    return false;
  }
  return !path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '');
}

function validateAsset(value: unknown): ProjectBundleAsset {
  if (!isPlainRecord(value)) {
    throw new PortabilityValidationError('invalid-manifest', 'Asset entry must be an object.');
  }
  if (typeof value.path !== 'string' || !isSafeBundlePath(value.path)) {
    throw new PortabilityValidationError('unsafe-path', 'Asset contains an unsafe path.');
  }
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new PortabilityValidationError('invalid-manifest', 'Asset checksum is invalid.');
  }
  const pathMatch = /^assets\/([a-f0-9]{64})\.([a-z0-9]{1,8})$/.exec(value.path);
  if (!pathMatch || pathMatch[1] !== value.sha256) {
    throw new PortabilityValidationError('invalid-manifest', 'Asset path must use its SHA-256 content hash.');
  }
  if (!nonNegativeSafeInteger(value.size) || value.size > PROJECT_BUNDLE_LIMITS.maxFileBytes) {
    throw new PortabilityValidationError('size-limit', 'Asset exceeds the single-file limit.');
  }
  if (!['image', 'video', 'audio', 'binary'].includes(String(value.mediaType))) {
    throw new PortabilityValidationError('invalid-manifest', 'Asset media type is invalid.');
  }
  if (!Array.isArray(value.roles)
    || !value.roles.every((role) => typeof role === 'string' && role.length > 0)
    || new Set(value.roles).size !== value.roles.length) {
    throw new PortabilityValidationError('invalid-manifest', 'Asset roles are invalid.');
  }
  return value as unknown as ProjectBundleAsset;
}

export function validateProjectBundleManifest(value: unknown): ProjectBundleManifest {
  if (!isPlainRecord(value)) {
    throw new PortabilityValidationError('invalid-manifest', 'Manifest must be an object.');
  }
  if (value.format !== PROJECT_BUNDLE_FORMAT) {
    throw new PortabilityValidationError('invalid-format', 'This is not an Open Storyboard project bundle.');
  }
  if (typeof value.schemaVersion !== 'number') {
    throw new PortabilityValidationError('invalid-manifest', 'Manifest schema version is missing.');
  }
  if (value.schemaVersion > PROJECT_BUNDLE_SCHEMA_VERSION) {
    throw new PortabilityValidationError('future-schema', 'This bundle was created by a newer application version.');
  }
  if (value.schemaVersion < 1) {
    throw new PortabilityValidationError('unsupported-schema', 'This project bundle version is no longer supported.');
  }
  if (typeof value.appVersion !== 'string' || value.appVersion.trim() === ''
    || typeof value.createdAt !== 'string' || value.createdAt.trim() === '') {
    throw new PortabilityValidationError('invalid-manifest', 'Manifest metadata is incomplete.');
  }
  if (!isPlainRecord(value.project)
    || typeof value.project.id !== 'string'
    || typeof value.project.name !== 'string'
    || value.project.id.trim() === ''
    || !nonNegativeSafeInteger(value.project.nodeCount)) {
    throw new PortabilityValidationError('invalid-manifest', 'Project summary is invalid.');
  }
  if (!Array.isArray(value.assets) || value.assets.length > PROJECT_BUNDLE_LIMITS.maxFiles - 2) {
    throw new PortabilityValidationError('file-limit', 'Bundle contains too many files.');
  }
  const assets = value.assets.map(validateAsset);
  const totalBytes = assets.reduce((total, asset) => total + asset.size, 0);
  if (totalBytes > PROJECT_BUNDLE_LIMITS.maxExpandedBytes) {
    throw new PortabilityValidationError('size-limit', 'Bundle exceeds the expanded-size limit.');
  }
  const paths = new Set<string>();
  for (const asset of assets) {
    if (paths.has(asset.path)) {
      throw new PortabilityValidationError('invalid-manifest', `Duplicate asset path: ${asset.path}`);
    }
    paths.add(asset.path);
  }
  return { ...(value as unknown as ProjectBundleManifest), assets };
}

export function validateProjectRecord(value: unknown): ProjectRecord {
  if (!isPlainRecord(value)
    || typeof value.id !== 'string'
    || value.id.trim() === ''
    || typeof value.name !== 'string'
    || !nonNegativeSafeInteger(value.createdAt)
    || !nonNegativeSafeInteger(value.updatedAt)
    || !nonNegativeSafeInteger(value.nodeCount)
    || typeof value.nodesJson !== 'string'
    || typeof value.edgesJson !== 'string'
    || typeof value.viewportJson !== 'string'
    || typeof value.historyJson !== 'string') {
    throw new PortabilityValidationError('invalid-project', 'Project data is incomplete or invalid.');
  }
  let nodes: unknown;
  let edges: unknown;
  let viewport: unknown;
  let history: unknown;
  try {
    nodes = JSON.parse(value.nodesJson);
    edges = JSON.parse(value.edgesJson);
    viewport = JSON.parse(value.viewportJson);
    history = JSON.parse(value.historyJson);
  } catch {
    throw new PortabilityValidationError('invalid-project', 'Project contains invalid JSON.');
  }
  if (!Array.isArray(nodes) || nodes.length !== value.nodeCount) {
    throw new PortabilityValidationError('summary-mismatch', 'Project node count does not match nodesJson.');
  }
  if (!Array.isArray(edges)) {
    throw new PortabilityValidationError('invalid-project', 'Project edgesJson must be an array.');
  }
  if (!isPlainRecord(viewport)
    || typeof viewport.x !== 'number' || !Number.isFinite(viewport.x)
    || typeof viewport.y !== 'number' || !Number.isFinite(viewport.y)
    || typeof viewport.zoom !== 'number' || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0) {
    throw new PortabilityValidationError('invalid-project', 'Project viewportJson is invalid.');
  }
  if (!isPlainRecord(history)
    || (history.past !== undefined && !Array.isArray(history.past))
    || (history.future !== undefined && !Array.isArray(history.future))) {
    throw new PortabilityValidationError('invalid-project', 'Project historyJson is invalid.');
  }
  if (value.imagePoolJson != null) {
    if (typeof value.imagePoolJson !== 'string') {
      throw new PortabilityValidationError('invalid-project', 'Project image pool is invalid.');
    }
    try {
      const pool = JSON.parse(value.imagePoolJson);
      if (!Array.isArray(pool) || !pool.every((item) => typeof item === 'string')) {
        throw new Error('invalid pool');
      }
    } catch {
      throw new PortabilityValidationError('invalid-project', 'Project image pool is invalid.');
    }
  }
  return value as unknown as ProjectRecord;
}

export function migrateProjectBundlePayload(value: unknown): ProjectBundlePayload {
  if (!isPlainRecord(value)) {
    throw new PortabilityValidationError('invalid-project', 'Project payload must be an object.');
  }
  if (value.schemaVersion === PROJECT_BUNDLE_SCHEMA_VERSION) {
    return {
      schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
      record: validateProjectRecord(value.record),
    };
  }
  if (value.schemaVersion === 0 && isPlainRecord(value.project)) {
    return {
      schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
      record: validateProjectRecord(value.project),
    };
  }
  if (typeof value.schemaVersion === 'number' && value.schemaVersion > PROJECT_BUNDLE_SCHEMA_VERSION) {
    throw new PortabilityValidationError('future-schema', 'Project data uses a newer schema version.');
  }
  throw new PortabilityValidationError('unsupported-schema', 'Project data schema is unsupported.');
}

export function validateSettingsBundle(value: unknown): SettingsBundlePayload {
  if (!isPlainRecord(value) || value.format !== SETTINGS_BUNDLE_FORMAT) {
    throw new PortabilityValidationError('invalid-format', 'This is not an Open Storyboard settings bundle.');
  }
  if (typeof value.schemaVersion !== 'number') {
    throw new PortabilityValidationError('invalid-settings', 'Settings schema version is missing.');
  }
  if (value.schemaVersion > SETTINGS_BUNDLE_SCHEMA_VERSION) {
    throw new PortabilityValidationError('future-schema', 'These settings were created by a newer application version.');
  }
  if (value.schemaVersion !== SETTINGS_BUNDLE_SCHEMA_VERSION) {
    throw new PortabilityValidationError('unsupported-schema', 'Settings schema is unsupported.');
  }
  if (typeof value.appVersion !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.includesCredentials !== 'boolean'
    || !isPlainRecord(value.categories)
    || !Object.values(value.categories).every(isPlainRecord)) {
    throw new PortabilityValidationError('invalid-settings', 'Settings bundle is incomplete or invalid.');
  }
  if (value.credentials !== undefined && !isPlainRecord(value.credentials)) {
    throw new PortabilityValidationError('invalid-settings', 'Settings credentials section is invalid.');
  }
  if (value.includesCredentials === false && value.credentials !== undefined) {
    throw new PortabilityValidationError('invalid-settings', 'Credential data is not allowed when includesCredentials is false.');
  }
  if (isPlainRecord(value.credentials)) {
    const allowedCredentialFields = new Set([
      'providerApiKeys',
      'agnesApiKey',
      'customProviderApiKeys',
      'imageHost',
    ]);
    if (Object.keys(value.credentials).some((field) => !allowedCredentialFields.has(field))) {
      throw new PortabilityValidationError('invalid-settings', 'Settings credentials contain an unknown field.');
    }
    const validateStringMap = (candidate: unknown, field: string): void => {
      if (candidate === undefined) return;
      if (!isPlainRecord(candidate) || !Object.values(candidate).every((item) => typeof item === 'string')) {
        throw new PortabilityValidationError('invalid-settings', `${field} must be a string map.`);
      }
    };
    validateStringMap(value.credentials.providerApiKeys, 'providerApiKeys');
    validateStringMap(value.credentials.customProviderApiKeys, 'customProviderApiKeys');
    if (value.credentials.agnesApiKey !== undefined && typeof value.credentials.agnesApiKey !== 'string') {
      throw new PortabilityValidationError('invalid-settings', 'agnesApiKey must be a string.');
    }
    if (value.credentials.imageHost !== undefined) {
      if (!isPlainRecord(value.credentials.imageHost)) {
        throw new PortabilityValidationError('invalid-settings', 'imageHost credentials must be an object.');
      }
      if (Object.keys(value.credentials.imageHost).some((field) => !['email', 'password', 'token'].includes(field))) {
        throw new PortabilityValidationError('invalid-settings', 'imageHost credentials contain an unknown field.');
      }
      for (const field of ['email', 'password', 'token']) {
        const fieldValue = value.credentials.imageHost[field];
        if (fieldValue !== undefined && typeof fieldValue !== 'string') {
          throw new PortabilityValidationError('invalid-settings', `imageHost.${field} must be a string.`);
        }
      }
    }
  }
  return value as unknown as SettingsBundlePayload;
}
