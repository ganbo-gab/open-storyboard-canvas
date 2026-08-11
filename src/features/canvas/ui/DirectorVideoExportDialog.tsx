import { memo, useCallback, useEffect } from 'react';
import { CheckCircle2, Download, Loader2, Plus, Video, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
    <div className="absolute inset-0 z-[78] flex items-center justify-center p-4 sm:p-5" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className={`absolute inset-0 bg-black/62 backdrop-blur-sm transition-opacity duration-[180ms] ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        onClick={requestClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="director-video-export-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`relative flex max-h-[calc(100%-2rem)] w-[460px] max-w-full flex-col overflow-hidden rounded-lg border border-white/12 bg-[#111719] shadow-2xl transition-[opacity,transform] duration-[180ms] ease-out ${isVisible ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-1 scale-[0.99] opacity-0'}`}
      >
        <header className="flex h-12 items-center justify-between border-b border-white/10 px-4">
          <h2 id="director-video-export-title" className="flex min-w-0 items-center gap-2 truncate text-sm font-medium text-white/88"><Video className="h-4 w-4 shrink-0 text-accent" /><span className="truncate">{t('directorStudio.motion.export.title')}</span></h2>
          <button type="button" onClick={requestClose} disabled={isRecording} className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-white/48 hover:bg-white/10 hover:text-white disabled:opacity-30 focus:outline-none focus:ring-2 focus:ring-accent/60" title={t('common.close')} aria-label={t('common.close')}><X className="h-4 w-4" /></button>
        </header>
        <div className="ui-scrollbar min-h-0 space-y-4 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-white/60">
              <span className="mb-1 block">{t('directorStudio.motion.export.resolution')}</span>
              <select value={resolution} onChange={(event) => onResolutionChange(event.target.value as DirectorVideoResolution)} disabled={isRecording} className="h-9 w-full rounded border border-white/12 bg-[#111719] px-2 text-xs text-white outline-none focus:border-accent/70 focus:ring-1 focus:ring-accent/30">
                <option value="720p">720p · 1280×720</option>
                <option value="1080p">1080p · 1920×1080</option>
              </select>
            </label>
            <label className="block text-xs text-white/60">
              <span className="mb-1 block">{t('directorStudio.motion.export.fps')}</span>
              <select value={fps} onChange={(event) => onFpsChange(Number(event.target.value) as DirectorVideoFps)} disabled={isRecording} className="h-9 w-full rounded border border-white/12 bg-[#111719] px-2 text-xs text-white outline-none focus:border-accent/70 focus:ring-1 focus:ring-accent/30">
                <option value="24">24 FPS</option>
                <option value="30">30 FPS</option>
              </select>
            </label>
          </div>
          <div className="flex items-center justify-between rounded border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/64">
            <span>{t('directorStudio.motion.export.duration')}</span>
            <span className="font-mono text-white/78">{durationSeconds.toFixed(2)}s</span>
          </div>
          <div className="flex items-center justify-between rounded border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/64">
            <span>{t('directorStudio.motion.export.format')}</span>
            <output aria-label={t('directorStudio.motion.export.format')} className="font-mono uppercase text-white/78">{format?.extension ?? t('directorStudio.motion.export.unsupported')}</output>
          </div>

          {isRecording ? (
            <div className="space-y-2" aria-live="polite">
              <div className="flex items-center justify-between text-xs text-white/64"><span>{t('directorStudio.motion.export.recording')}</span><span className="font-mono text-white/82">{progressPercent}%</span></div>
              <div
                role="progressbar"
                aria-label={t('directorStudio.motion.export.recording')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercent}
                className="h-2 overflow-hidden rounded bg-white/10"
              >
                <div
                  className="h-full w-full origin-left bg-accent transition-transform duration-150"
                  style={{ transform: `scaleX(${Math.max(0, Math.min(1, progressPercent / 100))})` }}
                />
              </div>
              <div className="text-xs text-white/50">{t('directorStudio.motion.export.remaining', { seconds: (progress?.remainingSeconds ?? durationSeconds).toFixed(1) })}</div>
            </div>
          ) : null}
          {error ? <div role="alert" className="rounded border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-100">{error}</div> : null}
          {result ? <div role="status" aria-live="polite" className="flex items-center gap-2 rounded border border-emerald-300/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100"><CheckCircle2 className="h-4 w-4" />{t('directorStudio.motion.export.complete', { format: result.extension.toUpperCase() })}</div> : null}

          <div className="flex flex-wrap justify-end gap-2 border-t border-white/10 pt-3">
            {result ? (
              <>
                <button type="button" data-autofocus="true" onClick={onSave} className="inline-flex h-11 items-center gap-1.5 rounded bg-white px-3 text-xs text-black hover:bg-white/88 focus:outline-none focus:ring-2 focus:ring-accent/70"><Download className="h-3.5 w-3.5" />{t('directorStudio.motion.export.save')}</button>
                <button type="button" onClick={onAddToCanvas} className="inline-flex h-11 items-center gap-1.5 rounded border border-white/12 bg-white/7 px-3 text-xs text-white/78 hover:bg-white/12 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/70"><Plus className="h-3.5 w-3.5" />{t('directorStudio.motion.export.addToCanvas')}</button>
              </>
            ) : (
              <button type="button" data-autofocus="true" onClick={onStart} disabled={isRecording || !format} className="inline-flex h-11 items-center gap-1.5 rounded bg-white px-3 text-xs text-black hover:bg-white/88 disabled:cursor-not-allowed disabled:opacity-35 focus:outline-none focus:ring-2 focus:ring-accent/70"><Video className="h-3.5 w-3.5" />{format ? t('directorStudio.motion.export.start') : t('directorStudio.motion.export.unsupported')}</button>
            )}
            {isRecording ? <button type="button" data-autofocus="true" onClick={onCancel} className="inline-flex h-11 items-center gap-1.5 rounded border border-red-300/20 bg-red-500/10 px-3 text-xs text-red-100 hover:bg-red-500/20 focus:outline-none focus:ring-2 focus:ring-red-300/60"><Loader2 className="h-3.5 w-3.5" />{t('directorStudio.motion.export.cancel')}</button> : null}
            {!isRecording && !result ? <button type="button" onClick={requestClose} className="h-11 rounded border border-white/10 bg-white/6 px-3 text-xs text-white/62 hover:bg-white/12 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/60">{t('common.cancel')}</button> : null}
          </div>
        </div>
      </div>
    </div>
  );
});
