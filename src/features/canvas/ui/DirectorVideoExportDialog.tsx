import { memo, useCallback, useEffect } from 'react';
import { CheckCircle2, Download, Loader2, Plus, Video, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton, UiSelect } from '@/components/ui';

import { UI_DIALOG_TRANSITION_MS } from '@/components/ui/motion';
import { useDialogTransition } from '@/components/ui/useDialogTransition';
import { useModalFocus } from '@/components/ui/useModalFocus';
import type {
  DirectorRecordedVideo,
  DirectorRecordingProgress,
  DirectorVideoFps,
  DirectorVideoFormat,
  DirectorVideoResolution,
} from '@/features/canvas/application/directorVideoRecording';

type Props = {
  isOpen: boolean;
  durationSeconds: number;
  format: DirectorVideoFormat | null;
  resolution: DirectorVideoResolution;
  fps: DirectorVideoFps;
  isRecording: boolean;
  progress: DirectorRecordingProgress | null;
  error: string | null;
  result: DirectorRecordedVideo | null;
  onResolutionChange: (resolution: DirectorVideoResolution) => void;
  onFpsChange: (fps: DirectorVideoFps) => void;
  onStart: () => void;
  onCancel: () => void;
  onSave: () => void;
  onAddToCanvas: () => void;
  onClose: () => void;
};

export const DirectorVideoExportDialog = memo(function DirectorVideoExportDialog({
  isOpen,
  durationSeconds,
  format,
  resolution,
  fps,
  isRecording,
  progress,
  error,
  result,
  onResolutionChange,
  onFpsChange,
  onStart,
  onCancel,
  onSave,
  onAddToCanvas,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);
  const requestClose = useCallback(() => {
    if (!isRecording) {
      onClose();
    }
  }, [isRecording, onClose]);
  const { dialogRef, onKeyDown } = useModalFocus({
    isOpen: isOpen && shouldRender,
    onClose: requestClose,
  });

  useEffect(() => {
    if (!isOpen || !shouldRender) {
      return;
    }

    const dialog = dialogRef.current;
    const activeElement = document.activeElement;
    const activeControlIsUsable = activeElement instanceof HTMLElement
      && dialog?.contains(activeElement)
      && !activeElement.matches(':disabled');
    if (!dialog || activeControlIsUsable) {
      return;
    }

    dialog.querySelector<HTMLElement>('[data-autofocus="true"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [dialogRef, isOpen, isRecording, result, shouldRender]);

  if (!shouldRender) return null;
  const progressPercent = Math.round((progress?.progress ?? 0) * 100);

  return (
    <div className="absolute inset-0 z-78 flex items-center justify-center p-4 sm:p-5" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
      <UiButton variant="ghost" size="sm"
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className={`absolute inset-0 h-full w-full rounded-none bg-[var(--scrim)] p-0 backdrop-blur-xs transition-opacity duration-180 hover:bg-[var(--scrim)] active:scale-100 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        onClick={requestClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="director-video-export-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`relative flex max-h-[calc(100%-2rem)] w-[460px] max-w-full flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-elevated shadow-[var(--shadow-pop)] transition-[opacity,transform,translate,scale,rotate] duration-180 ease-out ${isVisible ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-1 scale-[0.99] opacity-0'}`}
      >
        <header className="flex h-12 items-center justify-between border-b border-[var(--line)] px-4">
          <h2 id="director-video-export-title" className="flex min-w-0 items-center gap-2 truncate text-sm font-medium text-text-dark"><Video className="h-4 w-4 shrink-0 text-accent" /><span className="truncate">{t('directorStudio.motion.export.title')}</span></h2>
          <UiIconButton size="sm" type="button" onClick={requestClose} disabled={isRecording} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm" title={t('common.close')} aria-label={t('common.close')}><X className="h-4 w-4" /></UiIconButton>
        </header>
        <div className="ui-scrollbar min-h-0 space-y-4 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-text-muted">
              <span className="mb-1 block">{t('directorStudio.motion.export.resolution')}</span>
              <UiSelect aria-label={t('directorStudio.motion.export.resolution')} value={resolution} onChange={(event) => onResolutionChange(event.target.value as DirectorVideoResolution)} disabled={isRecording} className="h-9 w-full rounded-sm px-2 text-xs">
                <option value="720p">720p · 1280×720</option>
                <option value="1080p">1080p · 1920×1080</option>
              </UiSelect>
            </label>
            <label className="block text-xs text-text-muted">
              <span className="mb-1 block">{t('directorStudio.motion.export.fps')}</span>
              <UiSelect aria-label={t('directorStudio.motion.export.fps')} value={String(fps)} onChange={(event) => onFpsChange(Number(event.target.value) as DirectorVideoFps)} disabled={isRecording} className="h-9 w-full rounded-sm px-2 text-xs">
                <option value="24">24 FPS</option>
                <option value="30">30 FPS</option>
              </UiSelect>
            </label>
          </div>
          <div className="flex items-center justify-between rounded-sm border border-[var(--line)] bg-[var(--hover)] px-3 py-2 text-xs text-text-muted">
            <span>{t('directorStudio.motion.export.duration')}</span>
            <span className="font-mono text-text-muted">{durationSeconds.toFixed(2)}s</span>
          </div>
          <div className="flex items-center justify-between rounded-sm border border-[var(--line)] bg-[var(--hover)] px-3 py-2 text-xs text-text-muted">
            <span>{t('directorStudio.motion.export.format')}</span>
            <output aria-label={t('directorStudio.motion.export.format')} className="font-mono uppercase text-text-muted">{format?.extension ?? t('directorStudio.motion.export.unsupported')}</output>
          </div>

          {isRecording ? (
            <div className="space-y-2" aria-live="polite">
              <div className="flex items-center justify-between text-xs text-text-muted"><span>{t('directorStudio.motion.export.recording')}</span><span className="font-mono text-text-dark">{progressPercent}%</span></div>
              <div
                role="progressbar"
                aria-label={t('directorStudio.motion.export.recording')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercent}
                className="h-2 overflow-hidden rounded-sm bg-[var(--press)]"
              >
                <div
                  className="h-full w-full origin-left bg-accent transition-transform duration-150"
                  style={{ transform: `scaleX(${Math.max(0, Math.min(1, progressPercent / 100))})` }}
                />
              </div>
              <div className="text-xs text-text-subtle">{t('directorStudio.motion.export.remaining', { seconds: (progress?.remainingSeconds ?? durationSeconds).toFixed(1) })}</div>
            </div>
          ) : null}
          {error ? <div role="alert" className="rounded-sm border border-danger/20 bg-danger/10 px-3 py-2 text-xs leading-5 text-danger">{error}</div> : null}
          {result ? <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-sm border border-success/20 bg-success/10 px-3 py-2 text-xs text-success"><CheckCircle2 className="h-4 w-4" />{t('directorStudio.motion.export.complete', { format: result.extension.toUpperCase() })}</div> : null}

          <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--line)] pt-3">
            {result ? (
              <>
                <UiButton variant="primary" size="sm" type="button" data-autofocus="true" onClick={onSave} className="inline-flex h-11 items-center gap-1.5 rounded-sm px-3 text-xs"><Download className="h-3.5 w-3.5" />{t('directorStudio.motion.export.save')}</UiButton>
                <UiButton variant="secondary" size="sm" type="button" onClick={onAddToCanvas} className="inline-flex h-11 items-center gap-1.5 rounded-sm px-3 text-xs"><Plus className="h-3.5 w-3.5" />{t('directorStudio.motion.export.addToCanvas')}</UiButton>
              </>
            ) : (
              <UiButton variant="primary" size="sm" type="button" data-autofocus="true" onClick={onStart} disabled={isRecording || !format} className="inline-flex h-11 items-center gap-1.5 rounded-sm px-3 text-xs"><Video className="h-3.5 w-3.5" />{format ? t('directorStudio.motion.export.start') : t('directorStudio.motion.export.unsupported')}</UiButton>
            )}
            {isRecording ? <UiButton variant="danger" size="sm" type="button" data-autofocus="true" onClick={onCancel} className="inline-flex h-11 items-center gap-1.5 rounded-sm px-3 text-xs"><Loader2 className="h-3.5 w-3.5" />{t('directorStudio.motion.export.cancel')}</UiButton> : null}
            {!isRecording && !result ? <UiButton variant="secondary" size="sm" type="button" onClick={requestClose} className="h-11 rounded-sm px-3 text-xs">{t('common.cancel')}</UiButton> : null}
          </div>
        </div>
      </div>
    </div>
  );
});
