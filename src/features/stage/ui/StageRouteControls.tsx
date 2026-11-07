import { forwardRef } from 'react';
import { Circle, CircleDashed } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiIconButton } from '@/components/ui';
import { ScrubNumber } from './stageKit';

/** Position is projected by the Three viewport; scrubbing stays local until release. */
export const StageRouteControls = forwardRef<HTMLDivElement, {
  duration: number; maxDuration: number; closed: boolean;
  onDuration: (duration: number) => void; onToggleClosed: () => void;
}>(function StageRouteControls({ duration, maxDuration, closed, onDuration, onToggleClosed }, ref) {
  const { t } = useTranslation();
  return <div ref={ref} className="absolute left-0 top-0 z-20 flex items-center gap-1 rounded-full border border-line bg-surface/95 px-2 py-1 shadow-md"
    style={{ visibility: 'hidden' }} data-stage-route-controls
    onPointerDown={(event) => event.stopPropagation()} onPointerMove={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <UiIconButton size="sm" aria-label={t(closed ? 'ui.stage.route.open' : 'ui.stage.route.close')} title={t(closed ? 'ui.stage.route.open' : 'ui.stage.route.close')} aria-pressed={closed} onClick={onToggleClosed}>
      {closed ? <Circle className="h-4 w-4 text-accent" /> : <CircleDashed className="h-4 w-4" />}
    </UiIconButton>
    <ScrubNumber className="w-24" label={t('ui.stage.route.duration')} ariaLabel={t('ui.stage.route.durationHint')} value={duration} min={0.2} max={maxDuration} step={0.1} suffix="s" onCommit={onDuration} />
  </div>;
});
