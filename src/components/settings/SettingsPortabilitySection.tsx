import { useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, Download, FolderArchive, Settings2, ShieldAlert, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { readPortabilityTextFile, writePortabilityTextFile } from '@/commands/portability';
import { UiButton, UiCheckbox, UiModal } from '@/components/ui';
import {
  SETTINGS_BUNDLE_MAX_BYTES,
  type SettingsBundlePayload,
  type SettingsCategoryDiff,
  type SettingsPreviewValue,
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
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [showCredentialExportConfirm, setShowCredentialExportConfirm] = useState(false);
  const [showCredentialImportConfirm, setShowCredentialImportConfirm] = useState(false);
  const [importPayload, setImportPayload] = useState<SettingsBundlePayload | null>(null);
  const [diffs, setDiffs] = useState<SettingsCategoryDiff[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [isWorking, setIsWorking] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const previewValue = (value: SettingsPreviewValue): string => {
    if (value.kind === 'credential') {
      return value.configuredCount > 0
        ? t('portability.settings.credentialConfigured', { count: value.configuredCount })
        : t('portability.settings.credentialMissing');
    }
    return value.text;
  };

  const performExport = async () => {
    setShowCredentialExportConfirm(false);
    setIsWorking(true);
    setFeedback(null);
    try {
      const content = serializeSettingsBundle(includeCredentials);
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
    setSelectedCategories(new Set(
      nextDiffs
        .filter((diff) => diff.category !== 'credentials')
        .map((diff) => diff.category)
    ));
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
      setShowCredentialImportConfirm(false);
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
      <div className="border-b border-border-dark px-6 py-5">
        <h2 className="text-lg font-semibold text-text-dark">{t('portability.settings.title')}</h2>
        <p className="mt-1 text-sm text-text-muted">{t('portability.settings.description')}</p>
      </div>

      <div className="ui-scrollbar flex-1 space-y-6 overflow-y-auto p-6">
        <div className="grid gap-3 md:grid-cols-2">
          <section className="rounded-xl border border-border-dark bg-surface-dark/55 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-text-dark">
              <FolderArchive className="h-4 w-4 text-accent" />
              {t('portability.settings.projectTransferTitle')}
            </div>
            <p className="mt-2 text-xs leading-5 text-text-muted">{t('portability.settings.projectTransferDescription')}</p>
            <p className="mt-2 text-[11px] leading-5 text-text-muted">{t('portability.settings.projectTransferLocation')}</p>
          </section>
          <section className="rounded-xl border border-accent/25 bg-accent/[0.055] p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-text-dark">
              <Settings2 className="h-4 w-4 text-accent" />
              {t('portability.settings.settingsBackupTitle')}
            </div>
            <p className="mt-2 text-xs leading-5 text-text-muted">{t('portability.settings.settingsBackupDescription')}</p>
            <p className="mt-2 text-[11px] leading-5 text-text-muted">{t('portability.settings.settingsBackupExcludes')}</p>
          </section>
        </div>

        <section>
          <h3 className="text-sm font-medium text-text-dark">{t('portability.settings.exportTitle')}</h3>
          <p className="mt-1 text-xs text-text-muted">{t('portability.settings.exportDescription')}</p>
          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-md border border-border-dark bg-bg-dark p-3">
            <UiCheckbox
              checked={includeCredentials}
              onCheckedChange={setIncludeCredentials}
              className="mt-0.5 shrink-0"
            />
            <span>
              <span className="block text-sm text-text-dark">{t('portability.settings.includeCredentials')}</span>
              <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">{t('portability.settings.credentialsPlaintextHint')}</span>
            </span>
          </label>
          <UiButton
            type="button"
            variant="primary"
            disabled={isWorking}
            className="mt-4 gap-2"
            onClick={() => {
              if (includeCredentials) setShowCredentialExportConfirm(true);
              else void performExport();
            }}
          >
            <Download className="h-4 w-4" />
            {t('portability.settings.exportAction')}
          </UiButton>
        </section>

        <section className="border-t border-border-dark pt-6">
          <h3 className="text-sm font-medium text-text-dark">{t('portability.settings.importTitle')}</h3>
          <p className="mt-1 text-xs text-text-muted">{t('portability.settings.importDescription')}</p>
          <UiButton
            type="button"
            disabled={isWorking}
            className="mt-4 gap-2"
            onClick={() => void handleChooseImport()}
          >
            <Upload className="h-4 w-4" />
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
          <div className={`rounded-md border p-3 text-sm ${feedback.kind === 'error' ? 'border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300' : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'}`}>
            {feedback.message}
          </div>
        )}
      </div>

      <UiModal
        isOpen={showCredentialExportConfirm}
        title={t('portability.settings.credentialsWarningTitle')}
        onClose={() => setShowCredentialExportConfirm(false)}
        widthClassName="w-[min(92vw,460px)]"
        containerClassName="z-[70]"
        footer={(
          <>
            <UiButton type="button" onClick={() => setShowCredentialExportConfirm(false)}>{t('common.cancel')}</UiButton>
            <UiButton type="button" variant="primary" className="bg-red-600 hover:bg-red-500" onClick={() => void performExport()}>
              {t('portability.settings.exportUnencrypted')}
            </UiButton>
          </>
        )}
      >
        <div className="flex gap-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-text-dark">
          <ShieldAlert className="h-5 w-5 shrink-0 text-red-400" />
          <p>{t('portability.settings.credentialsWarningDescription')}</p>
        </div>
      </UiModal>

      <UiModal
        isOpen={Boolean(importPayload) && !showCredentialImportConfirm}
        title={t('portability.settings.previewTitle')}
        onClose={() => !isWorking && setImportPayload(null)}
        widthClassName="w-[min(92vw,680px)]"
        containerClassName="z-[70]"
        footer={(
          <>
            <UiButton type="button" onClick={() => setImportPayload(null)}>{t('common.cancel')}</UiButton>
            <UiButton
              type="button"
              variant="primary"
              disabled={isWorking || selectedCategories.size === 0}
              onClick={() => {
                if (selectedCategories.has('credentials')) setShowCredentialImportConfirm(true);
                else handleApply();
              }}
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
            {importPayload.includesCredentials && (
              <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {t('portability.settings.importCredentialsWarning')}
              </div>
            )}
            <div className="max-h-[46vh] overflow-y-auto border-y border-border-dark">
              {diffs.map((diff) => (
                <div
                  key={diff.category}
                  className="flex w-full items-start gap-3 border-b border-border-dark px-2 py-3 text-left last:border-b-0 hover:bg-bg-dark/60"
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
                      <span className={`text-[11px] ${diff.status === 'conflict' ? 'text-amber-700 dark:text-amber-300' : 'text-text-muted'}`}>
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
                              <span className="break-all font-mono text-[11px] text-text-dark">{previewValue(field.before)}</span>
                              <span>{t('portability.settings.after')}</span>
                              <span className="break-all font-mono text-[11px] text-text-dark">{previewValue(field.after)}</span>
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

      <UiModal
        isOpen={showCredentialImportConfirm}
        title={t('portability.settings.importCredentialsConfirmTitle')}
        onClose={() => setShowCredentialImportConfirm(false)}
        widthClassName="w-[min(92vw,460px)]"
        containerClassName="z-[70]"
        footer={(
          <>
            <UiButton type="button" onClick={() => setShowCredentialImportConfirm(false)}>{t('common.cancel')}</UiButton>
            <UiButton type="button" variant="primary" className="bg-red-600 hover:bg-red-500" onClick={handleApply}>
              {t('portability.settings.importCredentialsConfirmAction')}
            </UiButton>
          </>
        )}
      >
        <div className="flex gap-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-text-dark">
          <ShieldAlert className="h-5 w-5 shrink-0 text-red-400" />
          <p>{t('portability.settings.importCredentialsConfirmDescription')}</p>
        </div>
      </UiModal>
    </>
  );
}
