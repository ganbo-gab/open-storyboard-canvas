import { useState, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, LoaderCircle, ShieldCheck, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CanvasAgentToolEvent } from '@/features/canvas/agent/infrastructure/sdkRuntime';
import { AgentFailureNotice } from './AgentFailureNotice';
import { readableAgentFailure } from './agentFailureText';

export type AgentToolStepStatus = CanvasAgentToolEvent['status'];

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '[unavailable]';
  }
}

/** Failure text a tool reported through `error` or a structured `{ error }` output. */
export function agentToolFailureText(status: AgentToolStepStatus, error: string | undefined, output: unknown): string | null {
  if (status !== 'failed' && status !== 'warning' && status !== 'unknown') return null;
  if (error?.trim()) return error.trim();
  if (!output || typeof output !== 'object' || Array.isArray(output) || !('error' in output)) return null;
  const reported = output.error;
  if (typeof reported === 'string' && reported.trim()) return reported.trim();
  if (reported && typeof reported === 'object' && 'message' in reported
    && typeof reported.message === 'string' && reported.message.trim()) {
    return reported.message.trim();
  }
  return null;
}

/**
 * One tool call in the quiet step timeline: title, live status, raw input/output on demand,
 * the reported failure, and owner-specific recovery actions underneath.
 */
export function AgentToolStep({
  title,
  status,
  raw,
  failure,
  compactFailure = false,
  children,
}: {
  title: string;
  status: AgentToolStepStatus;
  raw?: unknown;
  failure?: string | null;
  compactFailure?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const caution = status === 'warning' || status === 'unknown';
  const tone = status === 'failed' ? 'danger' : caution ? 'warning' : status === 'executing' ? 'running' : undefined;
  const hasRaw = raw !== undefined && raw !== null;
  return (
    <div className="agent-feed-enter min-w-0">
      <button
        type="button"
        className="agent-step"
        data-tone={tone}
        aria-expanded={hasRaw ? expanded : undefined}
        disabled={!hasRaw}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="agent-step__icon">
          {status === 'executing'
            ? <LoaderCircle className="animate-spin" aria-hidden="true" />
            : status === 'awaiting-approval'
              ? <ShieldCheck aria-hidden="true" />
              : status === 'failed' || caution
                ? <CircleAlert aria-hidden="true" />
                : <Wrench aria-hidden="true" />}
        </span>
        <span className={`agent-step__title ${status === 'executing' ? 'agent-shimmer' : ''}`}>{title}</span>
        <span className="agent-step__detail" />
        <span className="agent-step__meta">{t(`canvasAgent.toolStatus.${status}`)}</span>
        {hasRaw ? <ChevronRight className="agent-step__chevron" aria-hidden="true" /> : null}
      </button>
      {expanded && hasRaw ? (
        <div className="agent-step-body">
          <pre className="agent-raw">{stringify(raw)}</pre>
        </div>
      ) : null}
      {failure ? (
        <AgentFailureNotice summary={readableAgentFailure(failure, t)} detail={failure} compact={compactFailure} tone={caution ? 'warning' : 'danger'} />
      ) : null}
      {children ? <div className="agent-step-actions">{children}</div> : null}
    </div>
  );
}
