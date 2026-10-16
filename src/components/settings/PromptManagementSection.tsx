import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiModal, UiSelect, UiTextArea } from '@/components/ui';
import {
  PROMPT_TEMPLATE_DEFINITIONS,
  getPromptTemplateDefaultText,
  getPromptTemplateEffectiveLanguage,
  resolvePromptTemplateText,
  type PromptLanguage,
  type PromptTemplateDefinition,
  type PromptTemplateId,
  type PromptTemplateLanguagePreference,
  type PromptTemplateScope,
} from '@/features/canvas/application/promptTemplates';
import { useSettingsStore } from '@/stores/settingsStore';

const SCOPE_ORDER: PromptTemplateScope[] = [
  'canvasPanel',
  'multiFunction',
  'camera',
  'panorama',
  'directorStudio',
  'storyboard',
  'tool',
];

const SCOPE_LABEL_KEYS: Record<PromptTemplateScope, string> = {
  canvasPanel: 'settings.promptManagement.scopes.canvasPanel',
  multiFunction: 'settings.promptManagement.scopes.multiFunction',
  camera: 'settings.promptManagement.scopes.camera',
  panorama: 'settings.promptManagement.scopes.panorama',
  directorStudio: 'settings.promptManagement.scopes.directorStudio',
  storyboard: 'settings.promptManagement.scopes.storyboard',
  tool: 'settings.promptManagement.scopes.tool',
};

function getTemplateId(definition: PromptTemplateDefinition): PromptTemplateId {
  return definition.id as PromptTemplateId;
}

interface PromptTemplateEditorProps {
  definition: PromptTemplateDefinition | null;
  promptDefaultLanguage: PromptLanguage;
  onClose: () => void;
}

function PromptTemplateEditor({
  definition,
  promptDefaultLanguage,
  onClose,
}: PromptTemplateEditorProps) {
  const { t } = useTranslation();
  const promptTemplateOverrides = useSettingsStore((state) => state.promptTemplateOverrides);
  const multiAnglePromptTemplate = useSettingsStore((state) => state.multiAnglePromptTemplate);
  const lightingPromptTemplate = useSettingsStore((state) => state.lightingPromptTemplate);
  const setPromptTemplateOverride = useSettingsStore((state) => state.setPromptTemplateOverride);
  const resetPromptTemplate = useSettingsStore((state) => state.resetPromptTemplate);
  const [draftTemplate, setDraftTemplate] = useState('');
  const [draftLanguage, setDraftLanguage] = useState<PromptTemplateLanguagePreference>('inherit');

  const templateId = definition ? getTemplateId(definition) : null;
  const settingsSnapshot = useMemo(
    () => ({
      promptDefaultLanguage,
      promptTemplateOverrides,
      multiAnglePromptTemplate,
      lightingPromptTemplate,
    }),
    [
      lightingPromptTemplate,
      multiAnglePromptTemplate,
      promptDefaultLanguage,
      promptTemplateOverrides,
    ]
  );

  useEffect(() => {
    if (!definition || !templateId) {
      return;
    }

    setDraftTemplate(resolvePromptTemplateText(templateId, settingsSnapshot));
    setDraftLanguage(promptTemplateOverrides[templateId]?.language ?? 'inherit');
  }, [definition, promptTemplateOverrides, settingsSnapshot, templateId]);

  if (!definition || !templateId) {
    return null;
  }

  const effectiveLanguage = draftLanguage === 'inherit' ? promptDefaultLanguage : draftLanguage;
  const defaultTemplate = getPromptTemplateDefaultText(templateId, effectiveLanguage);
  const placeholders = definition.placeholders;
  const hasPlaceholders = placeholders.length > 0;

  const handleReset = () => {
    resetPromptTemplate(templateId);
    setDraftLanguage('inherit');
    setDraftTemplate(getPromptTemplateDefaultText(templateId, promptDefaultLanguage));
  };

  const handleSave = () => {
    setPromptTemplateOverride(templateId, draftTemplate, draftLanguage);
    onClose();
  };

  return (
    <UiModal
      isOpen={Boolean(definition)}
      title={t('settings.promptManagement.editorTitle', { name: t(definition.titleKey) })}
      onClose={onClose}
      widthClassName="w-[min(92vw,760px)]"
      footer={
        <>
          <UiButton type="button" variant="ghost" size="sm" onClick={handleReset}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {t('settings.promptManagement.restoreDefault')}
          </UiButton>
          <div className="ml-auto flex gap-2">
            <UiButton type="button" variant="muted" size="sm" onClick={onClose}>
              {t('common.close')}
            </UiButton>
            <UiButton type="button" variant="primary" size="sm" onClick={handleSave}>
              {t('settings.promptManagement.saveAndClose')}
            </UiButton>
          </div>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-border-dark bg-bg-dark p-3">
          <div className="text-sm font-medium text-text-dark">{t(definition.titleKey)}</div>
          <p className="mt-1 text-xs leading-5 text-text-muted">{t(definition.descriptionKey)}</p>
        </div>

        <div className="grid gap-3 md:grid-cols-[220px_1fr]">
          <label className="text-xs font-medium text-text-muted">
            {t('settings.promptManagement.templateLanguage')}
            <UiSelect
              value={draftLanguage}
              onChange={(event) =>
                setDraftLanguage(event.target.value as PromptTemplateLanguagePreference)
              }
              className="mt-2 h-9 text-sm"
            >
              <option value="inherit">
                {t('settings.promptManagement.languageInherit', {
                  language: t(`settings.promptManagement.languages.${promptDefaultLanguage}`),
                })}
              </option>
              <option value="zh">{t('settings.promptManagement.languages.zh')}</option>
              <option value="en">{t('settings.promptManagement.languages.en')}</option>
            </UiSelect>
          </label>

          <div className="rounded-lg border border-border-dark bg-bg-dark p-3">
            <div className="text-xs font-medium text-text-muted">
              {t('settings.promptManagement.dynamicFields')}
            </div>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              {definition.dynamicDescriptionKey
                ? t(definition.dynamicDescriptionKey)
                : t('settings.promptManagement.dynamicNotes.none')}
            </p>
            {hasPlaceholders ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {placeholders.map((placeholder) => (
                  <span
                    key={placeholder}
                    className="rounded-sm bg-surface-dark px-2 py-1 font-mono text-[11px] text-text-dark"
                  >
                    {placeholder}
                  </span>
                ))}
              </div>
            ) : (
              <div className="mt-2 text-[11px] text-text-muted">
                {t('settings.promptManagement.noPlaceholders')}
              </div>
            )}
          </div>
        </div>

        <label className="block text-xs font-medium text-text-muted">
          {t('settings.promptManagement.editableTemplate')}
          <UiTextArea
            value={draftTemplate}
            onChange={(event) => setDraftTemplate(event.target.value)}
            className="mt-2 h-56 font-mono text-xs leading-5"
          />
        </label>

        <div className="rounded-lg border border-border-dark bg-bg-dark p-3">
          <div className="text-xs font-medium text-text-muted">
            {t('settings.promptManagement.defaultTemplatePreview')}
          </div>
          <div className="ui-scrollbar mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-sm bg-surface-dark p-2 font-mono text-[11px] leading-5 text-text-muted">
            {defaultTemplate}
          </div>
        </div>
      </div>
    </UiModal>
  );
}

export function PromptManagementSection() {
  const { t } = useTranslation();
  const promptDefaultLanguage = useSettingsStore((state) => state.promptDefaultLanguage);
  const promptTemplateOverrides = useSettingsStore((state) => state.promptTemplateOverrides);
  const multiAnglePromptTemplate = useSettingsStore((state) => state.multiAnglePromptTemplate);
  const lightingPromptTemplate = useSettingsStore((state) => state.lightingPromptTemplate);
  const setPromptDefaultLanguage = useSettingsStore((state) => state.setPromptDefaultLanguage);
  const setPromptTemplateLanguage = useSettingsStore((state) => state.setPromptTemplateLanguage);
  const [editingDefinition, setEditingDefinition] = useState<PromptTemplateDefinition | null>(null);

  const settingsSnapshot = useMemo(
    () => ({
      promptDefaultLanguage,
      promptTemplateOverrides,
      multiAnglePromptTemplate,
      lightingPromptTemplate,
    }),
    [
      lightingPromptTemplate,
      multiAnglePromptTemplate,
      promptDefaultLanguage,
      promptTemplateOverrides,
    ]
  );

  const groupedDefinitions = useMemo(() => {
    return SCOPE_ORDER.map((scope) => ({
      scope,
      definitions: PROMPT_TEMPLATE_DEFINITIONS.filter((definition) => definition.scope === scope),
    })).filter((group) => group.definitions.length > 0);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-4 border-b border-border-dark px-6 py-5">
        <div>
          <h2 className="text-lg font-semibold text-text-dark">
            {t('settings.promptManagement.title')}
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            {t('settings.promptManagement.desc')}
          </p>
        </div>
        <label className="w-44 shrink-0 text-xs font-medium text-text-muted">
          {t('settings.promptManagement.globalLanguage')}
          <UiSelect
            value={promptDefaultLanguage}
            onChange={(event) => setPromptDefaultLanguage(event.target.value as PromptLanguage)}
            className="mt-2 h-9 text-sm"
          >
            <option value="zh">{t('settings.promptManagement.languages.zh')}</option>
            <option value="en">{t('settings.promptManagement.languages.en')}</option>
          </UiSelect>
        </label>
      </div>

      <div className="ui-scrollbar flex-1 space-y-6 overflow-y-auto p-6">
        {groupedDefinitions.map((group) => (
          <section key={group.scope} className="space-y-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-accent" />
              <h3 className="text-sm font-semibold text-text-dark">
                {t(SCOPE_LABEL_KEYS[group.scope])}
              </h3>
            </div>

            <div className="grid gap-3">
              {group.definitions.map((definition) => {
                const id = getTemplateId(definition);
                const override = promptTemplateOverrides[id];
                const effectiveLanguage = getPromptTemplateEffectiveLanguage(id, settingsSnapshot);
                const languageValue = override?.language ?? 'inherit';
                const hasTemplateOverride = Boolean(override?.template?.trim());
                const hasLanguageOverride = Boolean(override?.language && override.language !== 'inherit');

                return (
                  <div
                    key={definition.id}
                    className="rounded-lg border border-border-dark bg-bg-dark p-4"
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-start">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-sm font-medium text-text-dark">
                            {t(definition.titleKey)}
                          </h4>
                          <span className="rounded-sm bg-surface-dark px-2 py-0.5 text-[11px] text-text-muted">
                            {t(`settings.promptManagement.languages.${effectiveLanguage}`)}
                          </span>
                          {hasTemplateOverride || hasLanguageOverride ? (
                            <span className="rounded-sm bg-accent/15 px-2 py-0.5 text-[11px] text-accent">
                              {t('settings.promptManagement.customized')}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs leading-5 text-text-muted">
                          {t(definition.descriptionKey)}
                        </p>
                      </div>

                      <div className="flex shrink-0 flex-col gap-2 sm:flex-row md:items-center">
                        <UiSelect
                          value={languageValue}
                          onChange={(event) =>
                            setPromptTemplateLanguage(
                              id,
                              event.target.value as PromptTemplateLanguagePreference
                            )
                          }
                          className="h-9 min-w-[150px] text-xs"
                          aria-label={t('settings.promptManagement.templateLanguage')}
                        >
                          <option value="inherit">
                            {t('settings.promptManagement.inheritGlobal')}
                          </option>
                          <option value="zh">{t('settings.promptManagement.languages.zh')}</option>
                          <option value="en">{t('settings.promptManagement.languages.en')}</option>
                        </UiSelect>
                        <UiButton
                          type="button"
                          variant="muted"
                          size="sm"
                          onClick={() => setEditingDefinition(definition)}
                        >
                          {t('settings.promptManagement.editPrompt')}
                        </UiButton>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <PromptTemplateEditor
        definition={editingDefinition}
        promptDefaultLanguage={promptDefaultLanguage}
        onClose={() => setEditingDefinition(null)}
      />
    </div>
  );
}
