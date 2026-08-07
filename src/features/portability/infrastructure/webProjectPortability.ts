import { AsyncUnzipInflate, Unzip, strFromU8, strToU8, zip, type UnzipFile } from 'fflate';
import { v4 as uuidv4 } from 'uuid';
import {
  getProjectRecord,
  upsertProjectRecord,
  type ProjectRecord,
} from '@/commands/projectState';
import packageMetadata from '../../../../package.json';
import {
  collectProjectMediaSources,
  inferMediaType,
  replaceProjectMediaSources,
} from '../application/projectMedia';
import {
  PROJECT_BUNDLE_FORMAT,
  PROJECT_BUNDLE_LIMITS,
  PROJECT_BUNDLE_MAX_JSON_BYTES,
  PROJECT_BUNDLE_SCHEMA_VERSION,
  WEB_PROJECT_BUNDLE_MAX_BYTES,
  type PortabilityProgress,
  type ProjectBundleAsset,
  type ProjectBundleManifest,
  type ProjectBundlePayload,
  type ProjectBundlePreview,
  type ProjectBundleWarning,
  type ProjectImportMode,
  type ProjectImportResult,
} from '../application/types';
import {
  PortabilityValidationError,
  isSafeBundlePath,
  migrateProjectBundlePayload,
  validateProjectBundleManifest,
} from '../application/validation';

interface ProgressOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PortabilityProgress) => void;
}

export interface WebProjectExportResult {
  bytes: Uint8Array;
  preview: ProjectBundlePreview;
}

export interface InspectedWebProjectBundle {
  preview: ProjectBundlePreview;
  payload: ProjectBundlePayload;
  files: Map<string, Uint8Array>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was cancelled.', 'AbortError');
  }
}

export function assertWebProjectBundleInputSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > WEB_PROJECT_BUNDLE_MAX_BYTES) {
    throw new PortabilityValidationError(
      'size-limit',
      'Web project bundles are limited to 512 MB. Use the desktop app for larger projects.'
    );
  }
}

export function assertWebProjectArchiveEntrySize(name: string, size: number): void {
  const maxBytes = name === 'manifest.json' || name === 'project.json'
    ? PROJECT_BUNDLE_MAX_JSON_BYTES
    : PROJECT_BUNDLE_LIMITS.maxFileBytes;
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    throw new PortabilityValidationError('size-limit', `${name} exceeds its size limit.`);
  }
}

function report(
  options: ProgressOptions,
  stage: PortabilityProgress['stage'],
  completed: number,
  total: number
): void {
  throwIfAborted(options.signal);
  options.onProgress?.({ stage, completed, total });
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const stableBytes = new Uint8Array(bytes.byteLength);
  stableBytes.set(bytes);
  return bytesToHex(await crypto.subtle.digest('SHA-256', stableBytes.buffer));
}

function decodeDataUrl(source: string): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(source);
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  try {
    if (match[2]) {
      const binary = atob(match[3].replace(/\s/g, ''));
      return {
        mime,
        bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      };
    }
    return { mime, bytes: strToU8(decodeURIComponent(match[3])) };
  } catch {
    return null;
  }
}

function extensionForSource(source: string, mime: string): string {
  const mimeExtensions: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
  };
  const mapped = mimeExtensions[mime.toLowerCase()];
  if (mapped) return mapped;
  const withoutQuery = source.split(/[?#]/, 1)[0];
  const match = /\.([a-zA-Z0-9]{1,8})$/.exec(withoutQuery);
  return match?.[1]?.toLowerCase() ?? 'bin';
}

async function materializeWebSource(
  source: string,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  throwIfAborted(signal);
  const data = decodeDataUrl(source);
  if (data) return data;
  if (!source.startsWith('blob:')) return null;
  const response = await fetch(source, { signal });
  if (!response.ok) return null;
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mime: response.headers.get('content-type')?.split(';', 1)[0] ?? 'application/octet-stream',
  };
}

function zipAsync(files: Record<string, Uint8Array>, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    try {
      throwIfAborted(signal);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let terminate = () => {};
    const cleanup = () => signal?.removeEventListener('abort', handleAbort);
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      terminate();
      cleanup();
      reject(new DOMException('The operation was cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
    terminate = zip(files, { level: 6 }, (error, bytes) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(bytes);
    });
    if (signal?.aborted) handleAbort();
  });
}

function safeUnzip(bytes: Uint8Array, signal?: AbortSignal): Promise<Map<string, Uint8Array>> {
  assertWebProjectBundleInputSize(bytes.byteLength);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const files = new Map<string, Uint8Array>();
    const entryNames = new Set<string>();
    const activeFiles = new Set<UnzipFile>();
    let expandedBytes = 0;
    let declaredExpandedBytes = 0;
    let fileCount = 0;
    let pendingFiles = 0;
    let inputFinished = false;
    let settled = false;

    const cleanup = () => signal?.removeEventListener('abort', handleAbort);
    const terminateFiles = () => {
      for (const file of activeFiles) {
        try { file.terminate(); } catch { /* worker may already be closed */ }
      }
      activeFiles.clear();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      terminateFiles();
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const finishIfReady = () => {
      if (!settled && inputFinished && pendingFiles === 0) {
        settled = true;
        cleanup();
        resolve(files);
      }
    };
    const handleAbort = () => fail(new DOMException('The operation was cancelled.', 'AbortError'));
    signal?.addEventListener('abort', handleAbort, { once: true });

    const unzipper = new Unzip((file) => {
      if (settled) {
        try { file.terminate(); } catch { /* no-op */ }
        return;
      }
      try {
        fileCount += 1;
        if (fileCount > PROJECT_BUNDLE_LIMITS.maxFiles) {
          throw new PortabilityValidationError('file-limit', 'Bundle contains too many files.');
        }
        if (!isSafeBundlePath(file.name)) {
          throw new PortabilityValidationError('unsafe-path', `Unsafe ZIP entry: ${file.name}`);
        }
        if (entryNames.has(file.name)) {
          throw new PortabilityValidationError('invalid-zip', `Duplicate ZIP entry: ${file.name}`);
        }
        entryNames.add(file.name);
        if (file.originalSize !== undefined) {
          assertWebProjectArchiveEntrySize(file.name, file.originalSize);
          declaredExpandedBytes += file.originalSize;
          if (declaredExpandedBytes > PROJECT_BUNDLE_LIMITS.maxExpandedBytes) {
            throw new PortabilityValidationError('size-limit', 'Bundle exceeds the expanded-size limit.');
          }
        }
      } catch (error) {
        fail(error);
        return;
      }

      const chunks: Uint8Array[] = [];
      let fileBytes = 0;
      pendingFiles += 1;
      activeFiles.add(file);
      file.ondata = (error, chunk, final) => {
        if (settled) return;
        if (error) {
          fail(error);
          return;
        }
        fileBytes += chunk.byteLength;
        expandedBytes += chunk.byteLength;
        try {
          assertWebProjectArchiveEntrySize(file.name, fileBytes);
          if (expandedBytes > PROJECT_BUNDLE_LIMITS.maxExpandedBytes) {
            throw new PortabilityValidationError('size-limit', 'Bundle exceeds the expanded-size limit.');
          }
        } catch (sizeError) {
          fail(sizeError);
          return;
        }
        chunks.push(chunk);
        if (!final) return;
        const output = new Uint8Array(fileBytes);
        let offset = 0;
        for (const part of chunks) {
          output.set(part, offset);
          offset += part.byteLength;
        }
        files.set(file.name, output);
        activeFiles.delete(file);
        pendingFiles -= 1;
        finishIfReady();
      };
      try {
        file.start();
      } catch (error) {
        fail(error);
      }
    });
    unzipper.register(AsyncUnzipInflate);
    try {
      unzipper.push(bytes, true);
      inputFinished = true;
      finishIfReady();
    } catch (error) {
      fail(new PortabilityValidationError(
        'invalid-zip',
        error instanceof Error ? error.message : 'Project bundle is not a valid ZIP archive.'
      ));
    }
    if (signal?.aborted) handleAbort();
  });
}

function parseJsonFile(bytes: Uint8Array | undefined, name: string): unknown {
  if (!bytes) {
    throw new PortabilityValidationError('missing-critical-file', `Bundle is missing ${name}.`);
  }
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new PortabilityValidationError('invalid-json', `${name} is not valid JSON.`);
  }
}

function mimeForAssetPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  const mimeByExtension: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
  };
  return mimeByExtension[extension ?? ''] ?? 'application/octet-stream';
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export async function exportWebProjectBundle(
  projectId: string,
  options: ProgressOptions = {}
): Promise<WebProjectExportResult> {
  report(options, 'reading', 0, 1);
  const record = await getProjectRecord(projectId);
  if (!record) throw new Error('Project not found.');
  const sources = collectProjectMediaSources(record)
    .filter(({ source }) => !source.startsWith('__img_ref__:') && !source.startsWith('bundle://'));
  const replacements = new Map<string, string>();
  const assetsByPath = new Map<string, { asset: ProjectBundleAsset; bytes: Uint8Array }>();
  const warnings: ProjectBundleWarning[] = [];
  let processed = 0;
  for (const mediaSource of sources) {
    report(options, 'packing', processed, sources.length || 1);
    const materialized = await materializeWebSource(mediaSource.source, options.signal);
    if (!materialized) {
      warnings.push({
        code: /^https?:\/\//i.test(mediaSource.source) ? 'external-source' : 'unreadable-source',
        message: /^https?:\/\//i.test(mediaSource.source)
          ? 'Remote media remains linked and was not downloaded.'
          : 'A local media source could not be read in this browser.',
      });
      processed += 1;
      continue;
    }
    if (materialized.bytes.byteLength > PROJECT_BUNDLE_LIMITS.maxFileBytes) {
      throw new PortabilityValidationError('size-limit', 'A project asset exceeds the single-file limit.');
    }
    const hash = await sha256(materialized.bytes);
    const extension = extensionForSource(mediaSource.source, materialized.mime);
    const path = `assets/${hash}.${extension}`;
    const existing = assetsByPath.get(path);
    if (existing) {
      existing.asset.roles = Array.from(new Set([...existing.asset.roles, ...mediaSource.roles]));
    } else {
      assetsByPath.set(path, {
        bytes: materialized.bytes,
        asset: {
          path,
          sha256: hash,
          size: materialized.bytes.byteLength,
          mediaType: inferMediaType(mediaSource.source, materialized.mime),
          roles: mediaSource.roles,
        },
      });
    }
    replacements.set(mediaSource.source, `bundle://${path}`);
    processed += 1;
  }
  const bundledRecord = replaceProjectMediaSources(record, replacements);
  const assets = Array.from(assetsByPath.values(), ({ asset }) => asset);
  const manifest: ProjectBundleManifest = {
    format: PROJECT_BUNDLE_FORMAT,
    schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
    appVersion: packageMetadata.version,
    createdAt: new Date().toISOString(),
    project: { id: record.id, name: record.name, nodeCount: record.nodeCount },
    assets,
  };
  validateProjectBundleManifest(manifest);
  const payload: ProjectBundlePayload = {
    schemaVersion: PROJECT_BUNDLE_SCHEMA_VERSION,
    record: bundledRecord,
  };
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'project.json': strToU8(JSON.stringify(payload)),
  };
  for (const [path, entry] of assetsByPath) files[path] = entry.bytes;
  report(options, 'packing', sources.length, sources.length || 1);
  const bytes = await zipAsync(files, options.signal);
  report(options, 'done', 1, 1);
  return {
    bytes,
    preview: {
      manifest,
      projectName: record.name,
      nodeCount: record.nodeCount,
      assetCount: assets.length,
      assetBytes: assets.reduce((total, asset) => total + asset.size, 0),
      warnings,
    },
  };
}

export async function inspectWebProjectBundle(
  bytes: Uint8Array,
  options: ProgressOptions = {}
): Promise<InspectedWebProjectBundle> {
  report(options, 'validating', 0, 1);
  const files = await safeUnzip(bytes, options.signal);
  const manifest = validateProjectBundleManifest(parseJsonFile(files.get('manifest.json'), 'manifest.json'));
  const payload = migrateProjectBundlePayload(parseJsonFile(files.get('project.json'), 'project.json'));
  const declaredEntries = new Set(['manifest.json', 'project.json', ...manifest.assets.map((asset) => asset.path)]);
  for (const path of files.keys()) {
    if (!declaredEntries.has(path)) {
      throw new PortabilityValidationError('undeclared-entry', `Bundle contains an undeclared file: ${path}`);
    }
  }
  if (manifest.project.id !== payload.record.id
    || manifest.project.name !== payload.record.name
    || manifest.project.nodeCount !== payload.record.nodeCount) {
    throw new PortabilityValidationError('summary-mismatch', 'Manifest and project summary do not match.');
  }
  const warnings: ProjectBundleWarning[] = [];
  const declaredAssetPaths = new Set(manifest.assets.map((asset) => asset.path));
  const referencedBundlePaths = new Set(
    collectProjectMediaSources(payload.record)
      .map(({ source }) => source.startsWith('bundle://') ? source.slice('bundle://'.length) : null)
      .filter((path): path is string => path !== null)
  );
  for (const path of referencedBundlePaths) {
    if (!isSafeBundlePath(path) || !path.startsWith('assets/')) {
      throw new PortabilityValidationError('unsafe-path', `Project contains an unsafe bundle reference: ${path}`);
    }
    if (!declaredAssetPaths.has(path)) {
      warnings.push({ code: 'missing-asset', message: `Project references an undeclared asset: ${path}`, path });
    }
  }
  let checked = 0;
  for (const asset of manifest.assets) {
    report(options, 'validating', checked, manifest.assets.length || 1);
    const content = files.get(asset.path);
    if (!content) {
      warnings.push({ code: 'missing-asset', message: `Missing non-critical asset: ${asset.path}`, path: asset.path });
      checked += 1;
      continue;
    }
    if (content.byteLength !== asset.size || await sha256(content) !== asset.sha256) {
      throw new PortabilityValidationError('checksum-mismatch', `Asset checksum failed: ${asset.path}`);
    }
    checked += 1;
  }
  report(options, 'done', 1, 1);
  return {
    preview: {
      manifest,
      projectName: payload.record.name,
      nodeCount: payload.record.nodeCount,
      assetCount: manifest.assets.length,
      assetBytes: manifest.assets.reduce((total, asset) => total + asset.size, 0),
      warnings,
    },
    payload,
    files,
  };
}

export async function importWebProjectBundle(
  inspected: InspectedWebProjectBundle,
  mode: ProjectImportMode,
  importedSuffix: string,
  options: ProgressOptions = {}
): Promise<ProjectImportResult> {
  report(options, 'extracting', 0, inspected.preview.manifest.assets.length || 1);
  const replacements = new Map<string, string>();
  for (const [index, asset] of inspected.preview.manifest.assets.entries()) {
    throwIfAborted(options.signal);
    const content = inspected.files.get(asset.path);
    replacements.set(
      `bundle://${asset.path}`,
      content ? bytesToDataUrl(content, mimeForAssetPath(asset.path)) : `bundle-missing://${asset.path}`
    );
    report(options, 'extracting', index + 1, inspected.preview.manifest.assets.length || 1);
  }
  for (const { source } of collectProjectMediaSources(inspected.payload.record)) {
    if (source.startsWith('bundle://') && !replacements.has(source)) {
      replacements.set(source, `bundle-missing://${source.slice('bundle://'.length)}`);
    }
  }

  const now = Date.now();
  const source = replaceProjectMediaSources(inspected.payload.record, replacements);
  let target: ProjectRecord;
  if (mode.kind === 'replace') {
    const existing = await getProjectRecord(mode.projectId);
    if (!existing) throw new Error('The project selected for replacement no longer exists.');
    target = {
      ...source,
      id: existing.id,
      name: existing.name,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
  } else {
    let targetId = uuidv4();
    while (await getProjectRecord(targetId)) targetId = uuidv4();
    target = {
      ...source,
      id: targetId,
      name: `${source.name}${importedSuffix}`,
      createdAt: now,
      updatedAt: now,
    };
  }
  report(options, 'committing', 0, 1);
  await upsertProjectRecord(target);
  report(options, 'done', 1, 1);
  return {
    project: {
      id: target.id,
      name: target.name,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
      nodeCount: target.nodeCount,
    },
    warnings: inspected.preview.warnings,
  };
}
