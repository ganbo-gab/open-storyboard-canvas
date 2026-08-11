import { Clock3, Download, Loader2, PauseCircle, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { CanvasGenerationJobState } from '@/features/canvas/domain/canvasNodes';

type VisibleGenerationJobState = Extract<
  CanvasGenerationJobState,
  'queued' | 'submitting' | 'running' | 'recoverable_wait' | 'materializing'
>;

interface GenerationJobStatusProps {
  state?: CanvasGenerationJobState | null;
  phase?: string | null;
  networkRoute?: 'system' | 'direct' | 'custom-proxy' | null;
  className?: string;
}

function isVisibleState(value: CanvasGenerationJobState | null | undefined): value is VisibleGenerationJobState {
  return value === 'queued'
    || value === 'submitting'
    || value === 'running'
    || value === 'recoverable_wait'
    || value === 'materializing';
}

function StatusIcon({ state }: { state: VisibleGenerationJobState }) {
  const className = 'h-3.5 w-3.5 shrink-0';
  if (state === 'queued') return <Clock3 className={className} aria-hidden="true" />;
  if (state === 'submitting') return <Send className={className} aria-hidden="true" />;
  if (state === 'materializing') return <Download className={className} aria-hidden="true" />;
  if (state === 'recoverable_wait') return <PauseCircle className={className} aria-hidden="true" />;
  return <Loader2 className={`${className} motion-safe:animate-spin`} aria-hidden="true" />;
}

export function GenerationJobStatus({
  state,
  phase,
  networkRoute,
  className = '',
}: GenerationJobStatusProps) {
  const { t } = useTranslation();
  if (!isVisibleState(state)) return null;

  const details = [
    phase ? t(`generationJob.phase.${phase}`, { defaultValue: phase }) : null,
    networkRoute ? t(`generationJob.route.${networkRoute}`) : null,
  ].filter((value): value is string => Boolean(value));
  const isPaused = state === 'recoverable_wait';

  return (
    <div
      className={`pointer-events-none absolute inset-x-2 bottom-2 z-20 flex min-h-8 items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12px] shadow-lg backdrop-blur-md transition-colors duration-200 ${
        isPaused
          ? 'border-amber-300/45 bg-amber-950/90 text-amber-100'
          : 'border-white/15 bg-[rgba(15,23,42,0.84)] text-white'
      } ${className}`}
      role="status"
      aria-live="polite"
    >
      <StatusIcon state={state} />
      <span className="min-w-0 flex-1 truncate font-medium">
        {t(`generationJob.status.${state}`)}
      </span>
      {details.length > 0 ? (
        <span className="max-w-[48%] truncate text-[11px] text-current opacity-70">
          {details.join(' · ')}
        </span>
      ) : null}
    </div>
  );
}
