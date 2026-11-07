import { z } from 'zod';
import type { StateStorage } from 'zustand/middleware';

const legacyDraftSchema = z.object({ provider: z.string(), endpoint: z.string() }).strict();
export const imageHostSettingsSchema = z.object({
  version: z.literal(2),
  enabled: z.boolean(),
  uploadUrl: z.string(),
  fileField: z.string(),
  responseUrlPath: z.string(),
  extraHeaders: z.record(z.string(), z.string()),
  migrationNotice: z.enum(['retired-provider', 'custom-endpoint', 'imported']).optional(),
  legacyDraft: legacyDraftSchema.optional(),
}).strict();
export type ImageHostSettings = z.infer<typeof imageHostSettingsSchema>;
export const DEFAULT_IMAGE_HOST_SETTINGS: ImageHostSettings = {
  version: 2, enabled: false, uploadUrl: '', fileField: 'file', responseUrlPath: 'data.url', extraHeaders: {},
};
const oldHostSchema = z.object({
  provider: z.enum(['pixhost', 'seedvault']),
  pixhost: z.object({ apiBaseUrl: z.string().optional() }).optional(),
  seedvault: z.object({ apiBaseUrl: z.string().optional() }).optional(),
});

function endpointWithoutCredentials(value: string): string {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return '';
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href.replace(/\/+$/, '');
  } catch { return ''; }
}

/** Every legacy provider is retired. A custom endpoint remains a readable, disabled draft. */
export function normalizeImageHostSettings(input: unknown): ImageHostSettings {
  const current = imageHostSettingsSchema.safeParse(input);
  if (current.success) return current.data;
  const old = oldHostSchema.safeParse(input);
  if (!old.success) return { ...DEFAULT_IMAGE_HOST_SETTINGS, extraHeaders: {} };
  const endpoint = endpointWithoutCredentials(old.data[old.data.provider]?.apiBaseUrl ?? '');
  const hostname = endpoint ? new URL(endpoint).hostname.toLowerCase() : '';
  const retired = !hostname || hostname === 'api.pixhost.to' || hostname === 'img.seedvault.cn';
  return {
    ...DEFAULT_IMAGE_HOST_SETTINGS, extraHeaders: {},
    migrationNotice: retired ? 'retired-provider' : 'custom-endpoint',
    legacyDraft: { provider: old.data.provider, endpoint },
    // No credential or implicit /tokens login is inherited. Review these fields before enabling.
    ...(!retired ? {
      uploadUrl: `${endpoint}/${old.data.provider === 'pixhost' ? 'images' : 'upload'}`,
      fileField: old.data.provider === 'pixhost' ? 'img' : 'file',
      responseUrlPath: old.data.provider === 'pixhost' ? 'show_url' : 'data.links.url',
    } : {}),
  };
}

export function imageHostConfigurationError(settings: ImageHostSettings): string | null {
  try {
    const url = new URL(settings.uploadUrl.trim());
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || url.hash) return 'settings.imageHosting.errors.uploadUrl';
  } catch { return 'settings.imageHosting.errors.uploadUrl'; }
  if (!settings.fileField.trim() || /[\r\n"\x00]/.test(settings.fileField)) return 'settings.imageHosting.errors.fileField';
  if (!/^(?:\$\.)?[A-Za-z0-9_-]+(?:\[\d+\]|\.[A-Za-z0-9_-]+)*$/.test(settings.responseUrlPath.trim())) return 'settings.imageHosting.errors.responsePath';
  if (Object.entries(settings.extraHeaders).some(([name, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
    || /^(?:content-type|content-length|host)$/i.test(name) || /[\r\n\x00]/.test(value))) return 'settings.imageHosting.errors.headers';
  return null;
}

/** Imports never enable an external upload target, including a previously enabled custom target. */
export function importedImageHostSettings(input: unknown): ImageHostSettings {
  return { ...normalizeImageHostSettings(input), enabled: false, migrationNotice: 'imported' };
}

const settingsEnvelopeSchema = z.object({ state: z.record(z.string(), z.unknown()) }).passthrough();

/** Retire old accounts before generic vault migration can write their obsolete passwords/tokens. */
export function retireImageHostStorage(storage: StateStorage): StateStorage {
  const sanitize = (raw: string): string => {
    try {
      const envelope = settingsEnvelopeSchema.safeParse(JSON.parse(raw));
      if (!envelope.success || !Object.hasOwn(envelope.data.state, 'imageHostSettings')) return raw;
      return JSON.stringify({ ...envelope.data, state: { ...envelope.data.state,
        imageHostSettings: normalizeImageHostSettings(envelope.data.state.imageHostSettings) } });
    } catch { return raw; }
  };
  return {
    async getItem(name) {
      const raw = await storage.getItem(name);
      if (raw === null) return null;
      const next = sanitize(raw);
      if (next !== raw && await storage.getItem(name) === raw) await storage.setItem(name, next);
      return next;
    },
    setItem: (name, raw) => storage.setItem(name, sanitize(raw)),
    removeItem: (name) => storage.removeItem(name),
  };
}
