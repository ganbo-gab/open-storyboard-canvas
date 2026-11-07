import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, CircleHelp, PauseCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { classifyGenerationFailure } from '@/features/canvas/application/generationErrorReport';
import type { CanvasGenerationJobState } from '@/features/canvas/domain/canvasNodes';
import type { NodeFrameStatus } from './NodeFrame';

/**
 * What a media result node shows while it has no media: one decision shared by every
 * result type, so image, video and audio fail and recover the same way.
 */
export type ResultFaceState =
  | { kind: 'media' }
  | { kind: 'unknown'; detail: string; safeRecovery: boolean }
  | { kind: 'recoverable'; detail: string }
  | { kind: 'failed'; detail: string }
  | { kind: 'waiting' };

export function resolveResultFaceState(input: {
  hasMedia: boolean;
  busy: boolean;
  jobState: CanvasGenerationJobState | null;
  error: string;
  safeRecovery?: boolean;
}): ResultFaceState {
  if (input.hasMedia) return { kind: 'media' };
  if (!input.busy && input.jobState === 'unknown') {
    return { kind: 'unknown', detail: input.error, safeRecovery: input.safeRecovery === true };
  }
  if (!input.busy && input.jobState === 'recoverable_wait') return { kind: 'recoverable', detail: input.error };
  if (!input.busy && input.error) return { kind: 'failed', detail: input.error };
  return { kind: 'waiting' };
}

export function resultFaceStatus(face: ResultFaceState, generating: boolean, startedAt: number | null): NodeFrameStatus | null {
  if (generating) return { kind: 'generating', startedAt };
  if (face.kind === 'failed') return { kind: 'error' };
  if (face.kind === 'unknown' || face.kind === 'recoverable') return { kind: 'attention' };
  return null;
}

/** Face for the unknown / recoverable / failed states; `null` for media and waiting. `action` is the failed state's own recovery. */
export function ResultProblemFace({ face, failedTitle, action }: { face: ResultFaceState; failedTitle: string; action?: ReactNode }) {
  const { t } = useTranslation();
  if (face.kind === 'unknown' || face.kind === 'recoverable') {
    const unknown = face.kind === 'unknown';
    return (
      <div className="node-face" data-tone="attention">
        {unknown ? <CircleHelp /> : <PauseCircle />}
        <strong>{t(unknown ? 'generationJob.unknownTitle' : 'generationJob.recoverableTitle')}</strong>
        <span className="node-face__detail select-text">{face.detail || t('generationJob.recoverableDescription')}</span>
        <span className="node-face__hint">
          {unknown
            ? t(face.safeRecovery ? 'generationJob.unknownSafeHint' : 'generationJob.unknownBlockedHint')
            : t('generationJob.recoverableHint')}
        </span>
      </div>
    );
  }
  if (face.kind === 'failed') {
    const failure = classifyGenerationFailure(face.detail);
    const title = failure.category === 'input_moderation' ? t('ui.canvas.moderationInput') : failure.category === 'output_moderation' ? t('ui.canvas.moderationOutput') : failure.moderation ? t('ui.canvas.moderationUnknown') : failedTitle;
    return (
      <div className="node-face" data-tone="error">
        <AlertTriangle />
        <strong>{title}</strong>
        <span className="node-face__detail select-text">{face.detail}</span>
        <span className="node-face__hint">{t(failure.moderation ? 'ui.canvas.moderationHint' : 'ui.canvas.retryHint')}</span>
        {action}
      </div>
    );
  }
  return null;
}

/** Estimated progress for long jobs; ticks on its own so the node body does not re-render. */
export function GenerationProgress({ startedAt, expectedDurationMs }: { startedAt: number | null; expectedDurationMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, []);
  const progress = Math.min(Math.max(0, now - (startedAt ?? now)) / Math.max(1000, expectedDurationMs), 0.96);
  return (
    <div className="node-progress" aria-hidden>
      <div className="node-progress__bar" style={{ transform: `scaleX(${progress})` }} />
    </div>
  );
}

/** "Waiting for result" that switches to "still waiting (N min)" after two minutes. */
export function WaitingLabel({
  startedAt,
  render,
}: {
  startedAt: number | null;
  render: (delayedMinutes: number | null) => ReactNode;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const minutes = startedAt === null ? 0 : Math.floor(Math.max(0, now - startedAt) / 60_000);
  return <>{render(minutes >= 2 ? minutes : null)}</>;
}
