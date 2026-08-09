import type { CanvasNode } from '../domain/canvasNodes';

const REDACTED = '[redacted]';
const MAX_COLLECTION_ITEMS = 100;
const MAX_OBJECT_DEPTH = 6;
const DEFAULT_STRING_LIMIT = 1_000;
const LONG_FORM_STRING_LIMIT = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if ([
    'apikey',
    'xapikey',
    'authorization',
    'proxyauthorization',
    'cookie',
    'setcookie',
    'token',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'bearertoken',
    'password',
    'passwd',
    'secret',
    'clientsecret',
    'privatekey',
    'credential',
    'credentials',
  ].includes(normalized)) {
    return true;
  }
  return normalized.includes('apikey')
    || /(?:access|refresh|id|bearer)token(?:value)?$/.test(normalized)
    || /(?:clientsecret|privatekey|secretkey|password|passwd|credentials?)$/.test(normalized);
}

function isLongFormKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return [
    'prompt',
    'sourceprompt',
    'baseprompt',
    'content',
    'rawcontent',
    'description',
    'note',
    'controlinstruction',
    'prompttextvalue',
  ].includes(normalized);
}

function isAssetReferenceKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return normalized.endsWith('url')
    || normalized.endsWith('uri')
    || normalized.endsWith('path')
    || normalized.endsWith('filepath');
}

function looksLikeAbsoluteLocalPath(value: string): boolean {
  return value.startsWith('file://')
    || value.startsWith('/')
    || value.startsWith('~/')
    || value.startsWith('\\\\')
    || /^[a-zA-Z]:[\\/]/.test(value);
}

function summarizeAssetReference(value: string): string {
  if (value.startsWith('data:')) return `[media:data:${value.length}]`;
  if (value.startsWith('blob:')) return '[media:blob]';
  if (value.startsWith('http://') || value.startsWith('https://')) return '[asset-reference:remote]';
  if (looksLikeAbsoluteLocalPath(value)) return '[asset-reference:local]';
  return '[asset-reference]';
}

function redactStandaloneRemoteUrl(value: string): string {
  if (!value.startsWith('http://') && !value.startsWith('https://')) {
    return value;
  }
  try {
    const url = new URL(value);
    url.searchParams.forEach((_parameterValue, parameterName) => {
      url.searchParams.set(parameterName, REDACTED);
    });
    url.hash = '';
    return url.toString();
  } catch {
    return '[asset-reference:remote]';
  }
}

export function projectCanvasReadValue(
  value: unknown,
  key = '',
  depth = 0,
): unknown {
  if (isSensitiveKey(key)) {
    return REDACTED;
  }
  if (depth > MAX_OBJECT_DEPTH) {
    return '[truncated]';
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `[binary:${value.byteLength}]`;
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return `[binary:blob:${value.size}]`;
  }
  if (typeof value === 'string') {
    if (isAssetReferenceKey(key)) {
      return summarizeAssetReference(value);
    }
    if (value.startsWith('data:') || value.startsWith('blob:')) {
      return `[media:${value.length}]`;
    }
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return redactStandaloneRemoteUrl(value);
    }
    if (looksLikeAbsoluteLocalPath(value)) {
      return '[local-path]';
    }
    const limit = isLongFormKey(key) ? LONG_FORM_STRING_LIMIT : DEFAULT_STRING_LIMIT;
    return value.length > limit ? `${value.slice(0, limit)}...` : value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => projectCanvasReadValue(item, key, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_COLLECTION_ITEMS)
        .map(([childKey, child]) => [
          childKey,
          projectCanvasReadValue(child, childKey, depth + 1),
        ]),
    );
  }
  return value;
}

export function projectCanvasNodeForRead(node: CanvasNode): unknown {
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    parentId: node.parentId ?? null,
    selected: Boolean(node.selected),
    data: projectCanvasReadValue(node.data, 'data'),
  };
}
