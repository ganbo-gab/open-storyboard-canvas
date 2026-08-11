import { memo, useEffect, useRef } from 'react';
import { Circle, Crosshair, Flag, Radio, Target, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Props = {
  active: boolean;
  recording: boolean;
  currentTime: number;
  timeSource?: {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => number;
  };
  targetLabel?: string | null;
  onExit: () => void;
};

export const DirectorCameraPilotHud = memo(function DirectorCameraPilotHud({
  active,
  recording,
  currentTime,
  timeSource,
  targetLabel,
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
    <div className="pointer-events-none absolute inset-0 z-[42]" aria-live="polite">
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white/85 drop-shadow-lg">
        <Crosshair className="h-7 w-7" strokeWidth={1.2} />
      </div>
      <div className="pointer-events-auto absolute left-1/2 top-16 flex -translate-x-1/2 items-center gap-2 rounded border border-white/15 bg-black/55 px-3 py-1.5 text-[10px] text-white/78 shadow-xl backdrop-blur">
        <Radio className={`h-3.5 w-3.5 ${recording ? 'text-red-300' : 'text-accent'}`} />
        <span>{t('directorStudio.motion.pilot.active')}</span>
        <span ref={timeRef} className="font-mono text-white/52">{currentTime.toFixed(2)}s</span>
        {recording ? <span className="flex items-center gap-1 text-red-200"><Circle className="h-2 w-2 fill-current" />REC</span> : null}
        <button type="button" onClick={onExit} className="ml-1 flex h-6 w-6 items-center justify-center rounded text-white/55 hover:bg-white/12 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/70" title={t('directorStudio.motion.pilot.exit')} aria-label={t('directorStudio.motion.pilot.exit')}><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="absolute bottom-[246px] left-1/2 flex -translate-x-1/2 items-center gap-2 rounded border border-white/10 bg-black/45 px-2.5 py-1 text-[9px] text-white/55 backdrop-blur">
        <span className="flex items-center gap-1"><Target className="h-3 w-3" />{targetLabel ?? t('directorStudio.motion.pilot.noTarget')}</span>
        <span className="text-white/28">·</span>
        <span className="flex items-center gap-1"><Flag className="h-3 w-3" />Enter</span>
        <span className="text-white/28">·</span><span>F</span><span className="text-white/28">·</span><span>Esc</span>
      </div>
    </div>
  );
});
