import { memo } from 'react';
import { CheckCircle2, Download, Loader2, Plus, Video, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
  if (!isOpen) return null;
  const progressPercent = Math.round((progress?.progress ?? 0) * 100);

  return (
    <div className="absolute inset-0 z-[78] flex items-center justify-center bg-black/62 p-5 backdrop-blur-sm" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
      <section role="dialog" aria-modal="true" aria-labelledby="director-video-export-title" className="w-[460px] max-w-full overflow-hidden rounded-lg border border-white/12 bg-[#111719] shadow-2xl">
        <header className="flex h-12 items-center justify-between border-b border-white/10 px-4">
          <h2 id="director-video-export-title" className="flex items-center gap-2 text-sm font-medium text-white/88"><Video className="h-4 w-4 text-accent" />{t('directorStudio.motion.export.title')}</h2>
          <button type="button" onClick={onClose} disabled={isRecording} className="flex h-8 w-8 items-center justify-center rounded text-white/48 hover:bg-white/10 hover:text-white disabled:opacity-30 focus:outline-none focus:ring-2 focus:ring-accent/60" title={t('common.close')} aria-label={t('common.close')}><X className="h-4 w-4" /></button>
        </header>
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-[10px] text-white/52">
              <span className="mb-1 block">{t('directorStudio.motion.export.resolution')}</span>
              <select value={resolution} onChange={(event) => onResolutionChange(event.target.value as DirectorVideoResolution)} disabled={isRecording} className="h-9 w-full rounded border border-white/12 bg-[#111719] px-2 text-xs text-white outline-none focus:border-accent/70 focus:ring-1 focus:ring-accent/30">
                <option value="720p">720p · 1280×720</option>
                <option value="1080p">1080p · 1920×1080</option>
              </select>
            </label>
            <label className="block text-[10px] text-white/52">
              <span className="mb-1 block">{t('directorStudio.motion.export.fps')}</span>
              <select value={fps} onChange={(event) => onFpsChange(Number(event.target.value) as DirectorVideoFps)} disabled={isRecording} className="h-9 w-full rounded border border-white/12 bg-[#111719] px-2 text-xs text-white outline-none focus:border-accent/70 focus:ring-1 focus:ring-accent/30">
                <option value="24">24 FPS</option>
                <option value="30">30 FPS</option>
              </select>
            </label>
          </div>
          <div className="flex items-center justify-between rounded border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-white/56">
            <span>{t('directorStudio.motion.export.duration')}</span>
            <span className="font-mono text-white/78">{durationSeconds.toFixed(2)}s</span>
          </div>
          <div className="flex items-center justify-between rounded border border-white/10 bg-white/5 px-3 py-2 text-[11px] text-white/56">
            <span>{t('directorStudio.motion.export.format')}</span>
            <output aria-label={t('directorStudio.motion.export.format')} className="font-mono uppercase text-white/78">{format?.extension ?? t('directorStudio.motion.export.unsupported')}</output>
          </div>

          {isRecording ? (
            <div className="space-y-2" aria-live="polite">
              <div className="flex items-center justify-between text-[11px] text-white/64"><span>{t('directorStudio.motion.export.recording')}</span><span className="font-mono text-white/82">{progressPercent}%</span></div>
              <div className="h-2 overflow-hidden rounded bg-white/10"><div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${progressPercent}%` }} /></div>
              <div className="text-[10px] text-white/38">{t('directorStudio.motion.export.remaining', { seconds: (progress?.remainingSeconds ?? durationSeconds).toFixed(1) })}</div>
            </div>
          ) : null}
          {error ? <div role="alert" className="rounded border border-red-300/20 bg-red-500/10 px-3 py-2 text-[11px] leading-4 text-red-100">{error}</div> : null}
          {result ? <div className="flex items-center gap-2 rounded border border-emerald-300/20 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-100"><CheckCircle2 className="h-4 w-4" />{t('directorStudio.motion.export.complete', { format: result.extension.toUpperCase() })}</div> : null}

          <div className="flex flex-wrap justify-end gap-2 border-t border-white/10 pt-3">
            {result ? (
              <>
                <button type="button" onClick={onSave} className="inline-flex h-9 items-center gap-1.5 rounded bg-white px-3 text-xs text-black hover:bg-white/88 focus:outline-none focus:ring-2 focus:ring-accent/70"><Download className="h-3.5 w-3.5" />{t('directorStudio.motion.export.save')}</button>
                <button type="button" onClick={onAddToCanvas} className="inline-flex h-9 items-center gap-1.5 rounded border border-white/12 bg-white/7 px-3 text-xs text-white/78 hover:bg-white/12 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/70"><Plus className="h-3.5 w-3.5" />{t('directorStudio.motion.export.addToCanvas')}</button>
              </>
            ) : (
              <button type="button" onClick={onStart} disabled={isRecording || !format} className="inline-flex h-9 items-center gap-1.5 rounded bg-white px-3 text-xs text-black hover:bg-white/88 disabled:cursor-not-allowed disabled:opacity-35 focus:outline-none focus:ring-2 focus:ring-accent/70"><Video className="h-3.5 w-3.5" />{format ? t('directorStudio.motion.export.start') : t('directorStudio.motion.export.unsupported')}</button>
            )}
            {isRecording ? <button type="button" onClick={onCancel} className="inline-flex h-9 items-center gap-1.5 rounded border border-red-300/20 bg-red-500/10 px-3 text-xs text-red-100 hover:bg-red-500/20 focus:outline-none focus:ring-2 focus:ring-red-300/60"><Loader2 className="h-3.5 w-3.5" />{t('directorStudio.motion.export.cancel')}</button> : null}
            {!isRecording && !result ? <button type="button" onClick={onClose} className="h-9 rounded border border-white/10 bg-white/6 px-3 text-xs text-white/62 hover:bg-white/12 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/60">{t('common.cancel')}</button> : null}
          </div>
        </div>
      </section>
    </div>
  );
});
