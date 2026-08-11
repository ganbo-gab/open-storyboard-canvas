import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, Download, Loader2, Upload, X, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  exportTauriProjectBundle,
  importTauriProjectBundle,
  inspectTauriProjectBundle,
} from '@/commands/portability';
import { UiButton, UiModal, UiSelect } from '@/components/ui';
import type { ProjectSummary } from '@/stores/projectStore';
import {
  WEB_PROJECT_BUNDLE_MAX_BYTES,
  type PortabilityProgress,
  type ProjectBundlePreview,
  type ProjectImportMode,
} from '../application/types';
import {
  exportWebProjectBundle,
  importWebProjectBundle,
  inspectWebProjectBundle,
  type InspectedWebProjectBundle,
} from '../infrastructure/webProjectPortability';

interface ExportRequest {
  projectId: string;
  projectName: string;
}

interface ProjectPortabilityControlsProps {
  projects: ProjectSummary[];
  exportRequest: ExportRequest | null;
  onExportHandled: () => void;
  onImported: () => Promise<void>;
  onBeforeExport: (projectId: string) => Promise<void>;
}

interface ImportCandidate {
  preview: ProjectBundlePreview;
  nativePath?: string;
  webBundle?: InspectedWebProjectBundle;
}

interface ActiveOperation {
  label: string;
  progress: PortabilityProgress;
  controller: AbortController;
}

function ensureExtension(path: string, extension: string): string {
  return path.toLowerCase().endsWith(extension) ? path : `${path}${extension}`;
}

function safeFileStem(name: string): string {
  const sanitized = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ');
  return sanitized || 'project';
}

function downloadBytes(bytes: Uint8Array, name: string): void {
  const stableBytes = new Uint8Array(bytes.byteLength);
  stableBytes.set(bytes);
  const url = URL.createObjectURL(new Blob([stableBytes.buffer], { type: 'application/zip' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ProjectPortabilityControls({
  projects,
  exportRequest,
  onExportHandled,
  onImported,
  onBeforeExport,
}: ProjectPortabilityControlsProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [candidate, setCandidate] = useState<ImportCandidate | null>(null);
  const [importMode, setImportMode] = useState<'new' | 'replace'>('new');
  const [replacementId, setReplacementId] = useState('');
  const [replaceConfirm, setReplaceConfirm] = useState(false);
  const [operation, setOperation] = useState<ActiveOperation | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const progressHandler = useCallback((controller: AbortController, label: string) => {
    return (progress: PortabilityProgress) => {
      setOperation((current) => current?.controller === controller
        ? { controller, label, progress }
        : current);
    };
  }, []);

  const beginOperation = useCallback((label: string): ActiveOperation => {
    const controller = new AbortController();
    const active = {
      controller,
      label,
      progress: { stage: 'reading' as const, completed: 0, total: 1 },
    };
    setOperation(active);
    setFeedback(null);
    return active;
  }, []);

  const inspectNativePath = useCallback(async (path: string) => {
    const active = beginOperation(t('portability.project.inspecting'));
    try {
      const preview = await inspectTauriProjectBundle(path, {
        signal: active.controller.signal,
        onProgress: progressHandler(active.controller, active.label),
      });
      setCandidate({ preview, nativePath: path });
      setImportMode('new');
      setReplacementId(projects[0]?.id ?? '');
      setReplaceConfirm(false);
    } catch (error) {
      if (!active.controller.signal.aborted) {
        setFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      setOperation((current) => current?.controller === active.controller ? null : current);
    }
  }, [beginOperation, progressHandler, projects, t]);

  const inspectWebFile = useCallback(async (file: File) => {
    const active = beginOperation(t('portability.project.inspecting'));
    try {
      const inspected = await inspectWebProjectBundle(new Uint8Array(await file.arrayBuffer()), {
        signal: active.controller.signal,
        onProgress: progressHandler(active.controller, active.label),
      });
      setCandidate({ preview: inspected.preview, webBundle: inspected });
      setImportMode('new');
      setReplacementId(projects[0]?.id ?? '');
      setReplaceConfirm(false);
    } catch (error) {
      if (!active.controller.signal.aborted) {
        setFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      setOperation((current) => current?.controller === active.controller ? null : current);
    }
  }, [beginOperation, progressHandler, projects, t]);

  const handleChooseImport = useCallback(async () => {
    if (operation) return;
    if (isTauri()) {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: 'Open Storyboard Project', extensions: ['oscpack'] }],
      });
      if (typeof selected === 'string') await inspectNativePath(selected);
      return;
    }
    fileInputRef.current?.click();
  }, [inspectNativePath, operation]);

  const handleExport = useCallback(async (request: ExportRequest) => {
    const active = beginOperation(t('portability.project.exporting'));
    try {
      const filename = `${safeFileStem(request.projectName)}.oscpack`;
      if (isTauri()) {
        const selected = await saveDialog({
          defaultPath: filename,
          filters: [{ name: 'Open Storyboard Project', extensions: ['oscpack'] }],
        });
        if (!selected) return;
        await onBeforeExport(request.projectId);
        await exportTauriProjectBundle(request.projectId, ensureExtension(selected, '.oscpack'), {
          signal: active.controller.signal,
          onProgress: progressHandler(active.controller, active.label),
        });
      } else {
        await onBeforeExport(request.projectId);
        const result = await exportWebProjectBundle(request.projectId, {
          signal: active.controller.signal,
          onProgress: progressHandler(active.controller, active.label),
        });
        downloadBytes(result.bytes, filename);
      }
      setFeedback({ kind: 'success', message: t('portability.project.exportSuccess') });
    } catch (error) {
      if (!active.controller.signal.aborted) {
        setFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      setOperation((current) => current?.controller === active.controller ? null : current);
      onExportHandled();
    }
  }, [beginOperation, onBeforeExport, onExportHandled, progressHandler, t]);

  useEffect(() => {
    if (exportRequest && !operation) void handleExport(exportRequest);
  }, [exportRequest, handleExport, operation]);

  const executeImport = useCallback(async () => {
    if (!candidate) return;
    const mode: ProjectImportMode = importMode === 'replace'
      ? { kind: 'replace', projectId: replacementId }
      : { kind: 'new' };
    const active = beginOperation(t('portability.project.importing'));
    try {
      if (candidate.nativePath) {
        await importTauriProjectBundle(
          candidate.nativePath,
          mode,
          t('portability.project.importedSuffix'),
          {
            signal: active.controller.signal,
            onProgress: progressHandler(active.controller, active.label),
          }
        );
      } else if (candidate.webBundle) {
        await importWebProjectBundle(
          candidate.webBundle,
          mode,
          t('portability.project.importedSuffix'),
          {
            signal: active.controller.signal,
            onProgress: progressHandler(active.controller, active.label),
          }
        );
      }
      await onImported();
      setCandidate(null);
      setReplaceConfirm(false);
      setFeedback({ kind: 'success', message: t('portability.project.importSuccess') });
    } catch (error) {
      if (!active.controller.signal.aborted) {
        setFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      setOperation((current) => current?.controller === active.controller ? null : current);
    }
  }, [beginOperation, candidate, importMode, onImported, progressHandler, replacementId, t]);

  const handleConfirmImport = () => {
    if (importMode === 'replace' && !replaceConfirm) {
      setReplaceConfirm(true);
      return;
    }
    void executeImport();
  };

  const percent = operation
    ? Math.round((operation.progress.completed / Math.max(1, operation.progress.total)) * 100)
    : 0;

  return (
    <>
      <UiButton type="button" onClick={() => void handleChooseImport()} className="gap-2">
        <Upload className="h-4 w-4" />
        {t('portability.project.importAction')}
      </UiButton>
      <input
        ref={fileInputRef}
        type="file"
        accept=".oscpack,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = '';
          if (!file) return;
          if (file.size > WEB_PROJECT_BUNDLE_MAX_BYTES) {
            setFeedback({ kind: 'error', message: t('portability.project.webBundleTooLarge') });
            return;
          }
          void inspectWebFile(file);
        }}
      />

      {(operation || feedback) && (
        <div className={`fixed bottom-5 right-5 z-40 w-[min(420px,calc(100vw-2.5rem))] rounded-lg border p-3 shadow-xl ${
          feedback?.kind === 'error'
            ? 'border-red-500/40 bg-surface-dark'
            : 'border-border-dark bg-surface-dark'
        }`}>
          {operation ? (
            <div>
              <div className="flex items-center gap-2 text-sm text-text-dark">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="min-w-0 flex-1 break-words">{operation.label}</span>
                <span className="shrink-0 text-xs text-text-muted">{percent}%</span>
                <button
                  type="button"
                  onClick={() => operation.controller.abort()}
                  className="inline-flex min-h-9 shrink-0 items-center rounded px-2 text-xs text-text-muted hover:bg-bg-dark hover:text-text-dark"
                >
                  {t('common.cancel')}
                </button>
              </div>
              <div
                role="progressbar"
                aria-label={operation.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="mt-2 h-1 overflow-hidden rounded bg-bg-dark"
              >
                <div
                  className="h-full w-full origin-left bg-accent transition-transform"
                  style={{ transform: `scaleX(${Math.max(0, Math.min(1, percent / 100))})` }}
                />
              </div>
            </div>
          ) : (
            <div
              role={feedback?.kind === 'error' ? 'alert' : 'status'}
              aria-live={feedback?.kind === 'error' ? 'assertive' : 'polite'}
              className="flex items-start gap-2 text-sm text-text-dark"
            >
              {feedback?.kind === 'error'
                ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                : <Download className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />}
              <span className="min-w-0 flex-1 break-words">{feedback?.message}</span>
              <button
                type="button"
                onClick={() => setFeedback(null)}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded text-text-muted hover:bg-bg-dark hover:text-text-dark"
                aria-label={t('common.close')}
                title={t('common.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      )}

      <UiModal
        isOpen={Boolean(candidate)}
        title={replaceConfirm
          ? t('portability.project.replaceConfirmTitle')
          : t('portability.project.previewTitle')}
        onClose={() => {
          if (!operation) {
            setCandidate(null);
            setReplaceConfirm(false);
          }
        }}
        widthClassName="w-[min(92vw,620px)]"
        containerClassName="z-[70]"
        footer={(
          <>
            <UiButton type="button" onClick={() => { setCandidate(null); setReplaceConfirm(false); }}>
              {t('common.cancel')}
            </UiButton>
            <UiButton
              type="button"
              variant="primary"
              className={importMode === 'replace' ? 'bg-red-600 hover:bg-red-500' : ''}
              disabled={Boolean(operation) || (importMode === 'replace' && !replacementId)}
              onClick={handleConfirmImport}
            >
              {replaceConfirm ? t('portability.project.replaceConfirmAction') : t('portability.project.importAction')}
            </UiButton>
          </>
        )}
      >
        {candidate && (
          <div className="space-y-4">
            {replaceConfirm ? (
              <div className="flex gap-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-text-dark">
                <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" />
                <p>{t('portability.project.replaceConfirmDescription', {
                  name: projects.find((project) => project.id === replacementId)?.name ?? '',
                })}</p>
              </div>
            ) : (
              <>
                <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm">
                  <dt className="text-text-muted">{t('portability.project.projectName')}</dt>
                  <dd className="truncate text-text-dark">{candidate.preview.projectName}</dd>
                  <dt className="text-text-muted">{t('portability.project.appVersion')}</dt>
                  <dd className="text-text-dark">{candidate.preview.manifest.appVersion}</dd>
                  <dt className="text-text-muted">{t('portability.project.schemaVersion')}</dt>
                  <dd className="text-text-dark">{candidate.preview.manifest.schemaVersion}</dd>
                  <dt className="text-text-muted">{t('portability.project.nodeCount')}</dt>
                  <dd className="text-text-dark">{candidate.preview.nodeCount}</dd>
                  <dt className="text-text-muted">{t('portability.project.assets')}</dt>
                  <dd className="text-text-dark">{t('portability.project.assetSummary', {
                    count: candidate.preview.assetCount,
                    size: (candidate.preview.assetBytes / 1024 / 1024).toFixed(1),
                  })}</dd>
                </dl>

                {candidate.preview.warnings.length > 0 && (
                  <div className="max-h-32 overflow-auto rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                    <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-300">
                      <AlertTriangle className="h-4 w-4" />
                      {t('portability.project.warnings')}
                    </div>
                    {candidate.preview.warnings.map((warning, index) => (
                      <p key={`${warning.code}-${index}`} className="text-xs text-text-muted">{warning.message}</p>
                    ))}
                  </div>
                )}

                <div>
                  <div className="mb-2 text-xs font-medium text-text-muted">{t('portability.project.importMode')}</div>
                  <div className="grid grid-cols-2 rounded-md border border-border-dark bg-bg-dark p-1">
                    {(['new', 'replace'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={importMode === mode}
                        onClick={() => { setImportMode(mode); setReplaceConfirm(false); }}
                        className={`h-9 rounded text-sm transition-colors ${importMode === mode ? 'bg-accent text-white' : 'text-text-muted hover:text-text-dark'}`}
                      >
                        {t(`portability.project.modes.${mode}`)}
                      </button>
                    ))}
                  </div>
                  {importMode === 'replace' && (
                    <UiSelect
                      value={replacementId}
                      onChange={(event) => setReplacementId(event.target.value)}
                      className="mt-3"
                      aria-label={t('portability.project.replaceTarget')}
                    >
                      {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </UiSelect>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </UiModal>
    </>
  );
}
