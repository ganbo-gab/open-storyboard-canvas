import { useEffect, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiInput, UiTextArea } from '@/components/ui';
import { useSettingsStore, type PromptPreset } from '@/stores/settingsStore';

interface PresetFormState {
  name: string;
  prompt: string;
}

const EMPTY_FORM: PresetFormState = {
  name: '',
  prompt: '',
};

function formatPresetDate(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    return '';
  }

  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  } catch {
    return '';
  }
}

export function PromptPresetsSection() {
  const { t } = useTranslation();
  const promptPresets = useSettingsStore((state) => state.promptPresets);
  const addPromptPreset = useSettingsStore((state) => state.addPromptPreset);
  const updatePromptPreset = useSettingsStore((state) => state.updatePromptPreset);
  const deletePromptPreset = useSettingsStore((state) => state.deletePromptPreset);
  const [form, setForm] = useState<PresetFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const editingPreset = editingId
    ? promptPresets.find((preset) => preset.id === editingId) ?? null
    : null;

  useEffect(() => {
    if (!editingPreset) {
      return;
    }

    setForm({
      name: editingPreset.name,
      prompt: editingPreset.prompt,
    });
    setError('');
  }, [editingPreset]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setError('');
  };

  const validateForm = (): boolean => {
    if (!form.name.trim()) {
      setError(t('settings.promptPresets.nameRequired'));
      return false;
    }
    if (!form.prompt.trim()) {
      setError(t('settings.promptPresets.promptRequired'));
      return false;
    }
    setError('');
    return true;
  };

  const handleSubmit = () => {
    if (!validateForm()) {
      return;
    }

    if (editingId) {
      updatePromptPreset(editingId, form);
    } else {
      addPromptPreset(form);
    }
    resetForm();
  };

  const startEditing = (preset: PromptPreset) => {
    setEditingId(preset.id);
    setForm({ name: preset.name, prompt: preset.prompt });
    setError('');
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border-dark px-6 py-5">
        <h2 className="text-lg font-semibold text-text-dark">
          {t('settings.promptPresets.title')}
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          {t('settings.promptPresets.desc')}
        </p>
      </div>

      <div className="ui-scrollbar flex-1 space-y-5 overflow-y-auto p-6">
        <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-text-dark">
                {editingId
                  ? t('settings.promptPresets.editTitle')
                  : t('settings.promptPresets.addTitle')}
              </h3>
              <p className="mt-1 text-xs text-text-muted">
                {t('settings.promptPresets.formHint')}
              </p>
            </div>
            {editingId ? (
              <UiButton type="button" variant="ghost" size="sm" onClick={resetForm}>
                <X className="mr-1.5 h-3.5 w-3.5" />
                {t('common.cancel')}
              </UiButton>
            ) : null}
          </div>

          <div className="mt-4 grid gap-3">
            <label className="text-xs font-medium text-text-muted">
              {t('settings.promptPresets.nameLabel')}
              <UiInput
                value={form.name}
                onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))}
                placeholder={t('settings.promptPresets.namePlaceholder')}
                className="mt-2 h-9"
              />
            </label>
            <label className="text-xs font-medium text-text-muted">
              {t('settings.promptPresets.promptLabel')}
              <UiTextArea
                value={form.prompt}
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, prompt: event.target.value }))
                }
                placeholder={t('settings.promptPresets.promptPlaceholder')}
                className="mt-2 h-32"
              />
            </label>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="min-h-5 text-xs text-red-300">{error}</div>
            <UiButton type="button" variant="primary" size="sm" onClick={handleSubmit}>
              {editingId ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Plus className="mr-1.5 h-3.5 w-3.5" />}
              {editingId ? t('settings.promptPresets.saveEdit') : t('settings.promptPresets.addButton')}
            </UiButton>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-dark">
              {t('settings.promptPresets.listTitle')}
            </h3>
            <span className="text-xs text-text-muted">
              {t('settings.promptPresets.count', { count: promptPresets.length })}
            </span>
          </div>

          {promptPresets.length > 0 ? (
            promptPresets.map((preset) => (
              <div
                key={preset.id}
                className="rounded-lg border border-border-dark bg-bg-dark p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h4 className="truncate text-sm font-medium text-text-dark">{preset.name}</h4>
                    <div className="mt-1 text-[11px] text-text-muted">
                      {t('settings.promptPresets.updatedAt', {
                        time: formatPresetDate(preset.updatedAt),
                      })}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <UiButton type="button" variant="muted" size="sm" onClick={() => startEditing(preset)}>
                      <Pencil className="mr-1.5 h-3.5 w-3.5" />
                      {t('common.edit')}
                    </UiButton>
                    <UiButton type="button" variant="ghost" size="sm" onClick={() => deletePromptPreset(preset.id)}>
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      {t('common.delete')}
                    </UiButton>
                  </div>
                </div>
                <div className="mt-3 max-h-24 overflow-hidden whitespace-pre-wrap wrap-break-word rounded-sm bg-surface-dark p-3 text-xs leading-5 text-text-muted">
                  {preset.prompt}
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-lg border border-dashed border-border-dark bg-bg-dark/50 p-6 text-center text-sm text-text-muted">
              {t('settings.promptPresets.empty')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
