import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MULTI_FUNCTION_ITEMS } from '@/features/canvas/ui/MultiFunctionPanel';
import { resolvePromptTemplateText } from '@/features/canvas/application/promptTemplates';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePromptLibraryStore } from '@/stores/promptLibraryStore';
import type { PromptDraft } from './usePromptDraft';

export interface ComposerPromptOption {
  id: string;
  label: string;
  hint?: string;
  prompt: string;
  group: 'preset' | 'favorite' | 'image';
}

/** Prompt choices are materialized into the editable draft, never an invisible request prefix. */
export function useSourceCommands(withFunctions: boolean): ComposerPromptOption[] {
  const { t } = useTranslation();
  const presets = useSettingsStore(state => state.promptPresets);
  const overrides = useSettingsStore(state => state.promptTemplateOverrides);
  const favorites = usePromptLibraryStore(state => state.favoritePrompts);
  return useMemo(() => [
    ...presets.map(preset => ({ id: `preset:${preset.id}`, label: preset.name, prompt: preset.prompt, group: 'preset' as const })),
    ...Object.values(favorites).map(entry => ({ id: `favorite:${entry.id}`, label: entry.title, hint: entry.category, prompt: entry.prompt, group: 'favorite' as const })),
    ...(withFunctions ? MULTI_FUNCTION_ITEMS.map(item => ({ id: `function:${item.id}`, label: t(item.titleKey), hint: t(item.descKey),
      prompt: resolvePromptTemplateText(item.promptTemplateId, useSettingsStore.getState()), group: 'image' as const })) : []),
  ], [presets, favorites, withFunctions, overrides, t]);
}

export function applyComposerPrompt(draft: PromptDraft, prompt: string, replace = false): void {
  const current = draft.read().trimEnd();
  const text = prompt.trim();
  if (!text) return;
  const next = replace || !current ? text : current === text || current.endsWith(`\n\n${text}`) ? current : `${current}\n\n${text}`;
  (draft.apply ?? draft.flush)(next);
}
