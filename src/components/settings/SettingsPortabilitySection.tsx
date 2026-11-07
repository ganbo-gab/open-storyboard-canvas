import { useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { Download, FolderArchive, Settings2, ShieldCheck, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { readPortabilityTextFile, writePortabilityTextFile } from '@/commands/portability';
import { UiButton, UiCheckbox, UiModal } from '@/components/ui';
import {
  SETTINGS_BUNDLE_MAX_BYTES,
  type SettingsBundlePayload,
  type SettingsCategoryDiff,
} from '@/features/portability/application/types';
import {
  applySettingsBundle,
  parseSettingsBundle,
  previewSettingsImport,
  serializeSettingsBundle,
} from '@/features/portability/application/settingsPortability';

function downloadText(content: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function ensureSettingsExtension(path: string): string {
  return path.toLowerCase().endsWith('.osc-settings.json') ? path : `${path}.osc-settings.json`;
}

export function SettingsPortabilitySection() {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importPayload, setImportPayload] = useState<SettingsBundlePayload | null>(null);
  const [diffs, setDiffs] = useState<SettingsCategoryDiff[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [isWorking, setIsWorking] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const performExport = async () => {
    setIsWorking(true);
    setFeedback(null);
    try {
      const content = serializeSettingsBundle();
      const filename = `open-storyboard-${new Date().toISOString().slice(0, 10)}.osc-settings.json`;
      if (isTauri()) {
        const selected = await saveDialog({
          defaultPath: filename,
          filters: [{ name: 'Open Storyboard Settings', extensions: ['json'] }],
        });
        if (!selected) return;
        await writePortabilityTextFile(ensureSettingsExtension(selected), content);
      } else {
        downloadText(content, filename);
      }
      setFeedback({ kind: 'success', message: t('portability.settings.exportSuccess') });
    } catch (error) {
      setFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsWorking(false);
    }
  };

  const openPreview = (raw: string) => {
    const payload = parseSettingsBundle(raw);
    const nextDiffs = previewSettingsImport(payload);
    setImportPayload(payload);
    setDiffs(nextDiffs);
    setSelectedCategories(new Set(nextDiffs.map((diff) => diff.category)));
  };

  const handleChooseImport = async () => {
    setFeedback(null);
    try {
      if (isTauri()) {
        const selected = await openDialog({
          multiple: false,
          directory: false,
          filters: [{ name: 'Open Storyboard Settings', extensions: ['json'] }],
        });
        if (typeof selected !== 'string') return;
        setIsWorking(true);
        openPreview(await readPortabilityTextFile(selected));
        setIsWorking(false);
      } else {
        fileInputRef.current?.click();
      }
    } catch (error) {
      setIsWorking(false);
      setFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleApply = () => {
    if (!importPayload) return;
    setIsWorking(true);
    setFeedback(null);
    try {
      applySettingsBundle(importPayload, selectedCategories);
      setImportPayload(null);
      setFeedback({ kind: 'success', message: t('portability.settings.importSuccess') });
    } catch (error) {
      setFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsWorking(false);
    }
  };

  const toggleCategory = (category: string) => {
    setSelectedCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  return (
    <>
      <div className="border-b border-[var(--line)] px-6 py-5">
        <h2 className="text-[15px] font-semibold text-text-dark">{t('portability.settings.title')}</h2>
        <p className="mt-1 text-[13px] text-text-muted">{t('portability.settings.description')}</p>
      </div>

      <div className="ui-scrollbar flex-1 space-y-4 overflow-y-auto p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-xl border border-[var(--line)] bg-surface p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-text-dark">
              <FolderArchive className="h-4 w-4 text-accent" />
              {t('portability.settings.projectTransferTitle')}
            </div>
            <p className="mt-2 text-xs leading-5 text-text-muted">{t('portability.settings.projectTransferDescription')}</p>
            <p className="mt-2 text-[11px] leading-5 text-text-muted">{t('portability.settings.projectTransferLocation')}</p>
          </section>
          <section className="rounded-xl border border-accent/25 bg-accent/5.5 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-text-dark">
              <Settings2 className="h-4 w-4 text-accent" />
              {t('portability.settings.settingsBackupTitle')}
            </div>
            <p className="mt-2 text-xs leading-5 text-text-muted">{t('portability.settings.settingsBackupDescription')}</p>
            <p className="mt-2 text-[11px] leading-5 text-text-muted">{t('portability.settings.settingsBackupExcludes')}</p>
          </section>
        </div>

        <section className="rounded-xl border border-[var(--line)] bg-surface p-4">
          <h3 className="text-sm font-medium text-text-dark">{t('portability.settings.exportTitle')}</h3>
          <p className="mt-1 text-xs text-text-muted">{t('portability.settings.exportDescription')}</p>
          <p className="mt-4 flex items-start gap-2 rounded-lg border border-[var(--line)] bg-[var(--field-bg)] p-3 text-xs leading-5 text-text-muted">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            {t('secrets.exportRefsOnly')}
          </p>
          <UiButton
            type="button"
            variant="primary"
            icon={<Download />}
            disabled={isWorking}
            className="mt-4"
            onClick={() => void performExport()}
          >
            {t('portability.settings.exportAction')}
          </UiButton>
        </section>

        <section className="rounded-xl border border-[var(--line)] bg-surface p-4">
          <h3 className="text-sm font-medium text-text-dark">{t('portability.settings.importTitle')}</h3>
          <p className="mt-1 text-xs text-text-muted">{t('portability.settings.importDescription')}</p>
          <UiButton
            type="button"
            icon={<Upload />}
            disabled={isWorking}
            className="mt-4"
            onClick={() => void handleChooseImport()}
          >
            {t('portability.settings.importAction')}
          </UiButton>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.osc-settings.json,application/json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = '';
              if (!file) return;
              if (file.size > SETTINGS_BUNDLE_MAX_BYTES) {
                setFeedback({ kind: 'error', message: t('portability.settings.fileTooLarge') });
                return;
              }
              setIsWorking(true);
              void file.text()
                .then(openPreview)
                .catch((error: unknown) => {
                  setFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
                })
                .finally(() => setIsWorking(false));
            }}
          />
        </section>

        {feedback && (
          <div
            role={feedback.kind === 'error' ? 'alert' : 'status'}
            className={`rounded-lg border p-3 text-sm ${feedback.kind === 'error' ? 'border-danger/30 bg-danger/10 text-danger' : 'border-success/30 bg-success/10 text-success'}`}
          >
            {feedback.message}
          </div>
        )}
      </div>

      <UiModal
        isOpen={Boolean(importPayload)}
        title={t('portability.settings.previewTitle')}
        onClose={() => !isWorking && setImportPayload(null)}
        widthClassName="w-[min(92vw,680px)]"
        containerClassName="z-70"
        footer={(
          <>
            <UiButton type="button" variant="ghost" onClick={() => setImportPayload(null)}>{t('common.cancel')}</UiButton>
            <UiButton
              type="button"
              variant="primary"
              loading={isWorking}
              disabled={isWorking || selectedCategories.size === 0}
              onClick={handleApply}
            >
              {t('portability.settings.applySelected')}
            </UiButton>
          </>
        )}
      >
        {importPayload && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-muted">
              <span>{t('portability.settings.appVersion')}: {importPayload.appVersion}</span>
              <span>{t('portability.settings.schemaVersion')}: {importPayload.schemaVersion}</span>
            </div>
            <div className="ui-scrollbar max-h-[46vh] overflow-y-auto border-y border-[var(--line)]">
              {diffs.map((diff) => (
                <div
                  key={diff.category}
                  className="flex w-full items-start gap-3 border-b border-[var(--line)] px-2 py-3 text-left last:border-b-0"
                >
                  <UiCheckbox
                    checked={selectedCategories.has(diff.category)}
                    onCheckedChange={() => toggleCategory(diff.category)}
                    aria-label={t('portability.settings.toggleCategory', {
                      category: t(`portability.settings.categories.${diff.category}`),
                    })}
                    className="mt-0.5 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm text-text-dark">
                      {t(`portability.settings.categories.${diff.category}`)}
                      <span className={`text-[11px] ${diff.status === 'conflict' ? 'text-warning' : 'text-text-muted'}`}>
                        {t(`portability.settings.status.${diff.status}`)}
                      </span>
                    </span>
                    {diff.fields.length > 0 ? (
                      <span className="mt-2 block space-y-2">
                        {diff.fields.map((field) => (
                          <span key={field.field} className="block text-xs">
                            <span className="block font-medium text-text-muted">{field.field}</span>
                            <span className="mt-0.5 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-text-muted">
                              <span>{t('portability.settings.before')}</span>
                              <span className="break-all font-mono text-[11px] text-text-dark">{field.before}</span>
                              <span>{t('portability.settings.after')}</span>
                              <span className="break-all font-mono text-[11px] text-text-dark">{field.after}</span>
                            </span>
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="mt-1 block text-xs text-text-muted">{t('portability.settings.noChanges')}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </UiModal>
    </>
  );
}
