import { isSecretRef, type SecretRef } from '@/features/secrets/secretStore';
import { isPlainRecord } from './validation';

const SECRET_KEY_PATTERN = /(?:(?:api|access|private|client|x)[-_ ]?key|comfyOrgKey|token|password|passwd|passphrase|secret|session|authorization|cookie|credential|signature|bearer|dreamina|^auth$|^sig$)/i;
const TOKEN_LIMIT_KEYS = /^(?:maxOutputTokens|maxTokens|max_tokens|max_output_tokens|contextWindow)$/;
const REFERENCE_KEYS = /(?:credential|secret|password|token|apiKey|apiKeys|agnes).*Refs?$/i;
const UNSAFE_KEYS = { ['__proto__']: true, prototype: true, constructor: true } as const satisfies Readonly<Record<string, true>>;

export function isPortableSecretRef(value: unknown): value is SecretRef {
  return isSecretRef(value) && Object.keys(value).length === 2;
}

export function isPortableSecretToken(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = /^__SC_SECRET_([A-Za-z0-9_-]+)__$/.exec(value);
  if (!match) return false;
  try {
    const binary = atob(match[1].replace(/-/g, '+').replace(/_/g, '/'));
    return isPortableSecretRef(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))));
  } catch {
    return false;
  }
}

export function isPortableCredentialReference(value: unknown): boolean {
  return isPortableSecretRef(value) || isPortableSecretToken(value)
    || (isPlainRecord(value) && Object.values(value).every((entry) => isPortableSecretRef(entry) || isPortableSecretToken(entry)));
}

export function isCredentialKey(key: string): boolean {
  return !TOKEN_LIMIT_KEYS.test(key) && SECRET_KEY_PATTERN.test(key);
}

function isTemplate(value: unknown): boolean {
  return typeof value === 'string' && /^(?:Bearer\s+|Basic\s+)?{{[^{}]+}}$/i.test(value);
}

function decoded(value: string): string {
  try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; }
}

function redactString(value: string, authNames: ReadonlySet<string>): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      const sanitized = redactValue(parsed, '', authNames);
      return JSON.stringify(parsed) === JSON.stringify(sanitized) ? value : JSON.stringify(sanitized);
    } catch {
      if ([...value.matchAll(/["']([^"']+)["']\s*:/g)].some((match) => isCredentialKey(match[1]))) {
        return '[redacted: invalid encoded credentials]';
      }
    }
  }
  return value
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^/\s?#]*@/gi, '$1')
    .replace(/(^|[?&#])([^?&#=\s]+)=([^&#\s]*)/g, (entry: string, separator: string, name: string, content: string) => {
      if (!isCredentialKey(decoded(name)) && !/^key$/i.test(decoded(name)) && !authNames.has(decoded(name).toLowerCase())) return entry;
      return isPortableSecretToken(decoded(content)) || isTemplate(decoded(content))
        ? entry : `${separator}${name}=`;
    })
    .replace(/^([\w-]+)[ \t]*:[ \t]*([^\r\n]*)$/gm, (entry: string, name: string, content: string) => {
      if (!isCredentialKey(name) && !authNames.has(name.toLowerCase())) return entry;
      return isPortableSecretToken(content.replace(/^(?:Bearer|Basic)\s+/i, '').trim()) || isTemplate(content.trim())
        ? entry : `${name}: [redacted]`;
    })
    .replace(/\b(Bearer|Basic)\s+([A-Za-z0-9+/_.~=-]+)/gi, (entry: string, scheme: string, credential: string) =>
      isPortableSecretToken(credential) ? entry : `${scheme} [redacted]`);
}

function redactValue(value: unknown, key: string, inheritedAuthNames: ReadonlySet<string>): unknown {
  if (Object.hasOwn(UNSAFE_KEYS, key)) return undefined;
  if (key === 'includesCredentials' && value === false) return false;
  if (REFERENCE_KEYS.test(key)) return isPortableSecretRef(value)
    || (isPlainRecord(value) && Object.values(value).every(isPortableSecretRef)) ? value : undefined;
  if (isCredentialKey(key)) {
    if (isPortableCredentialReference(value) || isTemplate(value)) return value;
    // Current channels and old provider contracts declare transport metadata, not values.
    if (key === 'auth' && isPlainRecord(value) && ['bearer', 'header', 'query', 'none'].includes(String(value.type ?? value.mode))) {
      const auth: Record<string, unknown> = value.type !== undefined ? { type: value.type } : { mode: value.mode };
      if (typeof value.name === 'string') auth.name = value.name;
      if (typeof value.prefix === 'string') auth.prefix = redactString(value.prefix, inheritedAuthNames);
      return auth;
    }
    if (key === 'auth' && typeof value === 'boolean') return value;
    return undefined;
  }
  if (typeof value === 'string') return redactString(value, inheritedAuthNames);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, '', inheritedAuthNames)).filter((item) => item !== undefined);
  if (!isPlainRecord(value)) return value;
  const authNames = new Set(inheritedAuthNames);
  const extraParams = isPlainRecord(value.extraParams) ? value.extraParams : undefined;
  const directAuth = isPlainRecord(value.auth) ? value.auth : undefined;
  const legacyAuth = extraParams && isPlainRecord(extraParams.auth) ? extraParams.auth : undefined;
  for (const name of [directAuth?.name, legacyAuth?.name, value.authName, extraParams?.authName]) {
    if (typeof name === 'string') authNames.add(name.toLowerCase());
  }
  const descriptor = typeof value.key === 'string' ? value.key : typeof value.name === 'string' ? value.name : undefined;
  const sensitiveEntry = descriptor !== undefined && (isCredentialKey(descriptor) || authNames.has(descriptor.toLowerCase()));
  const output: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (sensitiveEntry && ['value', 'default', 'content'].includes(childKey) && !isPortableSecretToken(child) && !isTemplate(child)) {
      output[childKey] = '[redacted]';
      continue;
    }
    if ((authNames.has(childKey.toLowerCase()) || (/^(?:queryParams|query|headers|extraHeaders)$/i.test(key) && /^key$/i.test(childKey)))
      && !isPortableSecretToken(child) && !isTemplate(child)) continue;
    const sanitized = redactValue(child, childKey, authNames);
    if (sanitized !== undefined) output[childKey] = sanitized;
  }
  return output;
}

/** Never reads the vault; old settings, request snapshots, and encoded backups are untrusted. */
export function redactPortableCredentials<T>(value: T): T {
  return redactValue(value, '', new Set()) as T;
}
