import { memo, useEffect, useRef } from 'react';
import { Circle, Crosshair, Radio, Target, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiIconButton } from '@/components/ui';

type Props = {
  active: boolean;
  recording: boolean;
  currentTime: number;
  timeSource?: {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => number;
  };
  targetLabel?: string | null;
  bottomOffset?: number;
  onExit: () => void;
};

export const DirectorCameraPilotHud = memo(function DirectorCameraPilotHud({
  active,
  recording,
  currentTime,
  timeSource,
  targetLabel,
  bottomOffset = 250,
  onExit,
}: Props) {
  const { t } = useTranslation();
  const timeRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!timeSource) return;
    const sync = () => {
      if (timeRef.current) timeRef.current.textContent = `${timeSource.getSnapshot().toFixed(2)}s`;
    };
    sync();
    return timeSource.subscribe(sync);
  }, [timeSource]);
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-42" aria-live="polite">
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white/85 drop-shadow-lg">
        <Crosshair className="h-7 w-7" strokeWidth={1.2} />
      </div>
      <div className="pointer-events-auto absolute left-1/2 top-16 flex -translate-x-1/2 items-center gap-2 rounded-sm border border-[var(--line)] bg-elevated px-3 py-1.5 text-[10px] text-text-muted shadow-[var(--shadow-pop)] backdrop-blur-sm">
        <Radio className={`h-3.5 w-3.5 ${recording ? 'text-danger' : 'text-accent'}`} />
        <span>{t('directorStudio.motion.pilot.active')}</span>
        <span ref={timeRef} className="font-mono text-text-subtle">{currentTime.toFixed(2)}s</span>
        {recording ? <span className="flex items-center gap-1 text-danger"><Circle className="h-2 w-2 fill-current" />REC</span> : null}
        <UiIconButton size="sm" type="button" onClick={onExit} className="ml-1 flex h-6 w-6 items-center justify-center rounded-sm" title={t('directorStudio.motion.pilot.exit')} aria-label={t('directorStudio.motion.pilot.exit')}><X className="h-3.5 w-3.5" /></UiIconButton>
      </div>
      <div className="absolute left-1/2 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-sm border border-[var(--line)] bg-elevated shadow-[var(--shadow-pop)] px-3 py-1.5 text-[10px] text-text-muted backdrop-blur-sm" style={{ bottom: bottomOffset }}>
        <span className="flex items-center gap-1"><Target className="h-3 w-3" />{targetLabel ?? t('directorStudio.motion.pilot.noTarget')}</span>
        <span className="text-text-subtle">·</span>
        <span>{t('directorStudio.motion.pilot.controls')}</span>
      </div>
    </div>
  );
});
