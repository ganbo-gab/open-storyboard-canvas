import { useEffect, useId, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiField, UiInput, UiTextArea } from '@/components/ui';
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
  const nameInputId = useId();
  const promptInputId = useId();

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
    <>
      <div className="border-b border-[var(--line)] px-6 py-5">
        <h2 className="text-[15px] font-semibold text-text-dark">
          {t('settings.promptPresets.title')}
        </h2>
        <p className="mt-1 text-[13px] text-text-muted">
          {t('settings.promptPresets.desc')}
        </p>
      </div>

      <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
        <section className="rounded-xl border border-[var(--line)] bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-[13px] font-semibold text-text-dark">
                {editingId
                  ? t('settings.promptPresets.editTitle')
                  : t('settings.promptPresets.addTitle')}
              </h3>
              <p className="mt-1 text-[12px] text-text-muted">
                {t('settings.promptPresets.formHint')}
              </p>
            </div>
            {editingId ? (
              <UiButton variant="ghost" size="sm" icon={<X />} onClick={resetForm}>
                {t('common.cancel')}
              </UiButton>
            ) : null}
          </div>

          <div className="mt-4 grid gap-3">
            <UiField label={t('settings.promptPresets.nameLabel')} htmlFor={nameInputId}>
              <UiInput
                id={nameInputId}
                value={form.name}
                onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))}
                placeholder={t('settings.promptPresets.namePlaceholder')}
              />
            </UiField>
            <UiField label={t('settings.promptPresets.promptLabel')} htmlFor={promptInputId}>
              <UiTextArea
                id={promptInputId}
                value={form.prompt}
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, prompt: event.target.value }))
                }
                placeholder={t('settings.promptPresets.promptPlaceholder')}
                className="h-32"
              />
            </UiField>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="min-h-5 text-[12px] text-danger">{error}</div>
            <UiButton
              variant="primary"
              size="sm"
              icon={editingId ? <Check /> : <Plus />}
              onClick={handleSubmit}
            >
              {editingId ? t('settings.promptPresets.saveEdit') : t('settings.promptPresets.addButton')}
            </UiButton>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-text-dark">
              {t('settings.promptPresets.listTitle')}
            </h3>
            <span className="text-[12px] text-text-muted">
              {t('settings.promptPresets.count', { count: promptPresets.length })}
            </span>
          </div>

          {promptPresets.length > 0 ? (
            promptPresets.map((preset) => (
              <div
                key={preset.id}
                className="rounded-xl border border-[var(--line)] bg-surface p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h4 className="truncate text-[13px] font-medium text-text-dark">{preset.name}</h4>
                    <div className="mt-1 text-[12px] text-text-subtle">
                      {t('settings.promptPresets.updatedAt', {
                        time: formatPresetDate(preset.updatedAt),
                      })}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <UiButton variant="secondary" size="sm" icon={<Pencil />} onClick={() => startEditing(preset)}>
                      {t('common.edit')}
                    </UiButton>
                    <UiButton variant="ghost" size="sm" icon={<Trash2 />} onClick={() => deletePromptPreset(preset.id)}>
                      {t('common.delete')}
                    </UiButton>
                  </div>
                </div>
                <div className="mt-3 max-h-24 overflow-hidden whitespace-pre-wrap wrap-break-word rounded-lg bg-[var(--field-bg)] p-3 text-[12px] leading-5 text-text-muted">
                  {preset.prompt}
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--line)] p-6 text-center text-[13px] text-text-muted">
              {t('settings.promptPresets.empty')}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
