import type { SettingsCategory } from '@/features/settings/settingsEvents';
import type { ChannelCapability } from '../application/channelCapabilities';
import type { ChannelProfileV2 } from '../domain/profile';
import { builtInPresets } from './index';

/**
 * Display-only metadata for the template catalog. Executable profiles stay untouched; capabilities
 * are always derived from the profile's models. Text lives in `ui.channels.templates.<id>.*`.
 */
export type TemplateSetup = 'key' | 'relay' | 'workspace' | 'manual';

export interface TemplateCatalogEntry {
  profile: ChannelProfileV2;
  /** i18n key prefix: `.title`, `.vendor`, `.summary`. */
  textKey: string;
  setup: TemplateSetup;
  /** Official documentation from the profile, when the preset was verified against one. */
  docsUrl?: string;
}

const SETUP: Record<string, TemplateSetup> = {
  'openai-compatible': 'relay',
  'generic-async': 'manual',
  'generic-audio-json': 'manual',
  'alibaba-wan-video': 'workspace',
};

export const templateCatalog: TemplateCatalogEntry[] = builtInPresets.map((profile) => ({
  profile,
  textKey: `ui.channels.templates.${profile.id}`,
  setup: SETUP[profile.id] ?? 'key',
  ...(profile.docsUrl ? { docsUrl: profile.docsUrl } : {}),
}));

export function findTemplate(presetId: string): TemplateCatalogEntry | undefined {
  return templateCatalog.find((entry) => entry.profile.id === presetId);
}

/** Example hosts shipped in presets that must be replaced before any request can work. */
export function baseUrlNeedsReplacement(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host.endsWith('.invalid') || host.includes('your-workspace-id');
  } catch {
    return false;
  }
}

/**
 * Integrations that are not HTTP templates. They keep their own settings sections and runtimes;
 * cards only route there. Cloud H3 is the MiniMax template, the local H3 card is a ComfyUI workflow.
 */
export interface SpecialAdapterEntry {
  id: 'comfyui' | 'comfyui-h3-local' | 'dreamina-cli';
  capabilities: ChannelCapability[];
  category: SettingsCategory;
  textKey: string;
}

export const specialAdapterCatalog: SpecialAdapterEntry[] = [
  { id: 'comfyui', capabilities: ['image', 'video'], category: 'comfyui', textKey: 'ui.channels.adapters.comfyui' },
  { id: 'comfyui-h3-local', capabilities: ['video'], category: 'comfyui', textKey: 'ui.channels.adapters.comfyuiH3' },
  { id: 'dreamina-cli', capabilities: ['image', 'video'], category: 'dreamina', textKey: 'ui.channels.adapters.dreamina' },
];
