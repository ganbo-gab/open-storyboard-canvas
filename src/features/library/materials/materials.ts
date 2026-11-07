import type { PromptPreset } from '@/stores/settingsStore';

export type MaterialKind = 'style' | 'effect' | 'cameraMotion' | 'preset';
export type MaterialSource = { type: 'builtIn' | 'custom' } | { type: 'promptPreset' | 'promptFavorite' | 'promptTemplate'; id: string };
export interface MaterialEntry {
  id: string;
  kind: MaterialKind;
  name: string;
  prompt: string;
  previewAsset?: string;
  tags: string[];
  enabled: boolean;
  order: number;
  builtIn: boolean;
  source: MaterialSource;
}
export type MaterialInput = Pick<MaterialEntry, 'kind' | 'name' | 'prompt'> & Partial<Pick<MaterialEntry, 'previewAsset' | 'tags' | 'enabled'>>;
export type MaterialPatch = Partial<Omit<MaterialInput, 'kind'>>;
export class MaterialError extends Error {
  constructor(public readonly code: 'invalid-entry' | 'not-found' | 'invalid-order' | 'invalid-import', message: string) { super(message); this.name = 'MaterialError'; }
}
export function normalizeMaterialOrder(entries: MaterialEntry[]): MaterialEntry[] {
  return [...entries].sort((a, b) => a.order - b.order).map((entry, order) => ({ ...entry, order }));
}
export function validateMaterialInput(input: MaterialInput): MaterialInput {
  if (!['style', 'effect', 'cameraMotion', 'preset'].includes(input.kind) || !input.name.trim() || !input.prompt.trim()) {
    throw new MaterialError('invalid-entry', 'Material name and prompt are required');
  }
  return { kind: input.kind, name: input.name.trim(), prompt: input.prompt.trim(), previewAsset: input.previewAsset, enabled: input.enabled, tags: [...new Set((input.tags ?? []).map(tag => tag.trim()).filter(Boolean))] };
}
/** Presets retain their canonical id/content/timestamps in settings, not a second persisted copy. */
export function migratePromptPresets(input: unknown): MaterialEntry[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.flatMap((value: unknown): MaterialEntry[] => {
    if (!value || typeof value !== 'object') return [];
    const raw = value as Partial<PromptPreset>;
    if (typeof raw.id !== 'string' || !raw.id.trim() || seen.has(raw.id) || typeof raw.prompt !== 'string' || !raw.prompt.trim()) return [];
    seen.add(raw.id);
    return [{ id: `preset:${raw.id}`, kind: 'preset', name: raw.name?.trim() || 'Untitled preset', prompt: raw.prompt.trim(), tags: [], enabled: true, order: seen.size - 1, builtIn: false, source: { type: 'promptPreset', id: raw.id } }];
  });
}
/** Adding a disabled entry is a no-op; repeated application is idempotent at paragraph boundaries. */
export function applyMaterialToPrompt(prompt: string, entry: MaterialEntry): string {
  const base = prompt.replace(/\r\n/g, '\n').trim();
  const addition = entry.prompt.replace(/\r\n/g, '\n').trim();
  if (!entry.enabled || !addition || base === addition || base.endsWith(`\n\n${addition}`)) return base;
  return base ? `${base}\n\n${addition}` : addition;
}
