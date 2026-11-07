import { AgentQuestionCard } from './AgentQuestionCard';
import { requestUserInputSchema, type AgentQuestionBinding } from '@/features/canvas/agent/application/agentUserInput';
import { z } from 'zod';
import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton } from '@/components/ui';
import type { AgentImpactSummary } from '@/features/canvas/agent/application/agentApproval';
import { agentToolTitle } from './AgentThread';

export type AgentApprovalCardStatus = 'pending' | 'approving' | 'rejecting' | 'approved' | 'rejected' | 'failed' | 'expired';

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '[unavailable]';
  }
}

/**
 * The only decision a user must make inside a turn. Approval authority stays with the caller:
 * the card reports a decision once per click and never retries or auto-approves.
 */
export function AgentApprovalCard({
  toolName,
  questionBinding,
  summary,
  impact,
  args,
  status: rawStatus,
  expiresAt,
  disabled = false,
  approveDisabled = false,
  blockedReason,
  preview,
  notice,
  onDecide,
}: {
  toolName: string;
  questionBinding?: AgentQuestionBinding;
  summary: string;
  impact: AgentImpactSummary;
  args: unknown;
  status: AgentApprovalCardStatus;
  expiresAt: number;
  /** Both decisions are unavailable, e.g. while another decision is running. */
  disabled?: boolean;
  /** Only approval is unavailable (budget); rejecting stays possible. */
  approveDisabled?: boolean;
  /** Visible reason when the decision buttons are disabled. */
  blockedReason?: string | null;
  preview?: ReactNode;
  notice?: ReactNode;
  onDecide: (approve: boolean) => void;
}) {
  const { t } = useTranslation();
  const [cardExpanded, setCardExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const question = toolName === 'request_user_input' ? requestUserInputSchema.safeParse(args) : null;
  if (question?.success && questionBinding) return <AgentQuestionCard request={question.data} binding={questionBinding} status={rawStatus} disabled={disabled} expiresAt={expiresAt} onDecide={onDecide} />;
  const status = rawStatus === 'pending' && expiresAt <= Date.now() ? 'expired' : rawStatus;
  const deciding = status === 'approving' || status === 'rejecting';
  const terminal = status === 'approved' || status === 'rejected' || status === 'failed' || status === 'expired';
  const title = agentToolTitle(t, toolName);
  const projectName = z.object({ name: z.string() }).safeParse(args).data?.name ?? '';
  const localizedSummary = t(`ui.agent.approvalDescriptions.${toolName}`, { defaultValue: summary, name: projectName });
  const statusText = t(`canvasAgent.approvalStatus.${status}`);

  if (terminal && !cardExpanded) {
    return (
      <div className="agent-feed-enter min-w-0">
        <button type="button" className="agent-step" aria-expanded="false" onClick={() => setCardExpanded(true)}>
          <span className="agent-step__icon"><ShieldCheck aria-hidden="true" /></span>
          <span className="agent-step__title">{title}</span>
          <span className="agent-step__detail" />
          <span className="agent-step__meta">{statusText}</span>
          <ChevronRight className="agent-step__chevron" aria-hidden="true" />
        </button>
      </div>
    );
  }

  const details = [
    t(`canvasAgent.effect.${impact.effect}`),
    impact.affectedNodeCount > 0 ? t('canvasAgent.affectedNodes', { count: impact.affectedNodeCount }) : null,
    impact.affectedEdgeCount > 0 ? t('canvasAgent.affectedEdges', { count: impact.affectedEdgeCount }) : null,
    impact.model && impact.effect === 'external-submit' ? t('canvasAgent.modelLabel', { model: impact.model }) : null,
    impact.estimatedCost
      ? impact.estimatedCost.confidence === 'unknown' ? t('canvasAgent.costUnknown') : t('canvasAgent.costEstimate')
      : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <article className="agent-card agent-feed-enter" data-tone={status === 'pending' ? 'attention' : undefined} aria-label={title}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="agent-card__eyebrow">
            {deciding ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
            <span role="status">{statusText}</span>
          </p>
          <h3 className="agent-card__title">{title}</h3>
          {localizedSummary && localizedSummary !== title ? <p className="agent-card__body">{localizedSummary}</p> : null}
          {impact.summary && impact.summary !== summary && localizedSummary === summary ? <p className="agent-card__body">{impact.summary}</p> : null}
        </div>
        {terminal ? (
          <UiIconButton
            aria-label={t('canvasAgent.collapseApproval')}
            title={t('canvasAgent.collapseApproval')}
            aria-expanded="true"
            onClick={() => setCardExpanded(false)}
          >
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </UiIconButton>
        ) : null}
      </div>
      {details.length ? (
        <p className="mt-2 flex flex-wrap gap-x-2.5 gap-y-1 text-[11.5px] text-text-subtle">
          {details.map((detail) => <span key={detail} className="max-w-full truncate">{detail}</span>)}
        </p>
      ) : null}
      {preview}
      <button
        type="button"
        className="agent-disclosure mt-2"
        aria-expanded={detailsExpanded}
        onClick={() => setDetailsExpanded((value) => !value)}
      >
        {detailsExpanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
        {t('canvasAgent.viewDetails')}
      </button>
      {detailsExpanded ? <pre className="agent-raw agent-disclosure-enter mt-1.5">{stringify(args)}</pre> : null}
      {notice}
      {status === 'pending' ? (
        <>
          {blockedReason ? <p className="mt-3 text-[11.5px] leading-5 text-warning">{blockedReason}</p> : null}
          <div className="agent-card__actions">
            <UiButton variant="secondary" disabled={disabled} className="min-h-9 gap-1 text-xs" onClick={() => onDecide(false)}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              {t('canvasAgent.reject')}
            </UiButton>
            <UiButton variant="primary" disabled={disabled || approveDisabled} className="min-h-9 gap-1 text-xs" onClick={() => onDecide(true)}>
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {t('canvasAgent.approve')}
            </UiButton>
          </div>
        </>
      ) : null}
    </article>
  );
}
