import { useCanvasAgentPanelStore } from './agentPanelStore';
import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CircleAlert,
  ClipboardCopy,
  Crosshair,
  Download,
  ListChecks,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton, UiInput, UiSelect } from '@/components/ui';
import { AgentApprovalCard } from '@/features/agents/ui/AgentApprovalCard';
import { AgentMessage, AgentNotice, AgentReasoning, agentToolTitle } from '@/features/agents/ui/AgentThread';
import { AgentToolStep, agentToolFailureText } from '@/features/agents/ui/AgentToolStep';
import type { AgentBudgetDecision } from '../application/agentBudget';
import {
  diagnosticBundleFileName,
  extractSafeDiagnosticBundlePreview,
  formatDiagnosticIssueDraft,
  serializeSafeDiagnosticBundlePreview,
} from '../application/agentDiagnostics';
import { createAgentPlanStep, reviseAgentPlan, updateAgentPlanStep, type AgentPlanDraft } from '../application/agentPlan';
import type { AgentFeedItem } from './agentPanelStore';
import { generationProgressFromAgentOutput } from './agentFeedProjection';
import { applyAgentQuestionModelPreference } from './agentQuestionModelPreference';

type ApprovalItem = Extract<AgentFeedItem, { kind: 'approval' }>;
type PlanItem = Extract<AgentFeedItem, { kind: 'plan' }>;

interface Props {
  item: AgentFeedItem;
  onApproval: (item: ApprovalItem, approve: boolean) => void;
  onLocate: (nodeIds: string[]) => void;
  onRestoreDraft: (message: string) => void;
  onDiagnose: (message: string) => void;
  onPlanChange: (item: PlanItem, plan: AgentPlanDraft) => void;
  onPlanConfirm: (item: PlanItem) => void;
  onPlanCancel: (item: PlanItem) => void;
  budgetDecision?: AgentBudgetDecision;
  onBudgetLimitChange: (limit: number | null) => void;
  onRollback: (item: Extract<AgentFeedItem, { kind: 'tool' }>) => void;
  /** Turn-level withdrawal (06 §6); distinct from per-receipt rollback and ordinary ⌘Z. */
  onWithdrawTurn?: (item: Extract<AgentFeedItem, { kind: 'status' }>) => void;
  /** Approvals wait while another decision or turn runs. */
  decisionsLocked?: boolean;
}

function BudgetNotice({
  budgetDecision,
  onBudgetLimitChange,
}: {
  budgetDecision?: AgentBudgetDecision;
  onBudgetLimitChange: Props['onBudgetLimitChange'];
}) {
  const { t } = useTranslation();
  const [budgetDraft, setBudgetDraft] = useState('');
  if (budgetDecision?.reason === 'budget-exceeded') {
    return (
      <div className="mt-3 rounded-[10px] bg-danger/[0.07] p-2.5" role="alert">
        <div className="flex items-start gap-2 text-[11px] leading-5 text-danger">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {t('canvasAgent.budgetBlocked', {
              cost: budgetDecision.estimatedCost ?? 0,
              remaining: budgetDecision.remaining ?? 0,
            })}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <UiInput
            type="number"
            inputMode="decimal"
            min="0"
            step="0.1"
            className="h-10 min-w-0 flex-1 border-danger/30 text-xs"
            aria-label={t('canvasAgent.adjustBudget')}
            placeholder={t('canvasAgent.newBudgetLimit')}
            value={budgetDraft}
            onChange={(event) => setBudgetDraft(event.target.value)}
          />
          <UiButton
            variant="danger"
            className="min-h-10 text-xs"
            onClick={() => {
              const value = Number(budgetDraft);
              if (Number.isFinite(value) && value >= 0) onBudgetLimitChange(value);
            }}
          >
            {t('common.save')}
          </UiButton>
        </div>
      </div>
    );
  }
  if (budgetDecision?.configured && budgetDecision.unknownCost) {
    return (
      <p className="mt-3 text-[11px] leading-5 text-warning">
        {t('canvasAgent.unknownCostBudgetNotice', { remaining: budgetDecision.remaining ?? 0 })}
      </p>
    );
  }
  return null;
}

function PlanCard({
  item,
  onPlanChange,
  onPlanConfirm,
  onPlanCancel,
}: Pick<Props, 'onPlanChange' | 'onPlanConfirm' | 'onPlanCancel'> & { item: PlanItem }) {
  const { t } = useTranslation();
  const editable = item.plan.status === 'pending';

  const changeSteps = (steps: AgentPlanDraft['steps']) => {
    onPlanChange(item, reviseAgentPlan(item.plan, steps));
  };

  return (
    <article className="agent-card agent-feed-enter" data-tone={editable ? 'attention' : undefined} aria-live="polite">
      <div className="flex items-start gap-2">
        <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-text-dark">{t('canvasAgent.planTitle')}</div>
          <div className="mt-1 text-[11px] text-text-muted">
            {t('canvasAgent.planRevision', { revision: item.plan.revision, count: item.plan.steps.length })}
          </div>
        </div>
      </div>

      <ol className="mt-3 space-y-2">
        {item.plan.steps.map((step, index) => (
          <li key={step.id} className="rounded-[5px] border border-[var(--line)] bg-[var(--field-bg)] p-2">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] bg-text-dark/6 text-[10px] font-semibold text-text-muted">
                {index + 1}
              </span>
              <UiInput
                aria-label={t('canvasAgent.planStepLabel', { index: index + 1 })}
                className="h-11 min-w-0 flex-1 text-xs sm:h-9"
                disabled={!editable}
                maxLength={240}
                value={step.title}
                onChange={(event) => changeSteps(item.plan.steps.map((candidate) => (
                  candidate.id === step.id
                    ? updateAgentPlanStep(candidate, { title: event.target.value })
                    : candidate
                )))}
              />
              {editable ? (
                <UiIconButton
                  className="h-11 w-11 text-danger sm:h-9 sm:w-9"
                  aria-label={t('canvasAgent.removePlanStep', { index: index + 1 })}
                  title={t('canvasAgent.removePlanStep', { index: index + 1 })}
                  onClick={() => changeSteps(item.plan.steps.filter((candidate) => candidate.id !== step.id))}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </UiIconButton>
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-7">
              <UiSelect
                aria-label={t('canvasAgent.planStepEffect', { index: index + 1 })}
                className="h-11 w-auto text-[10px] sm:h-8"
                disabled={!editable}
                value={step.effect}
                onChange={(event) => changeSteps(item.plan.steps.map((candidate) => (
                  candidate.id === step.id
                    ? updateAgentPlanStep(candidate, { effect: event.target.value as typeof step.effect })
                    : candidate
                )))}
              >
                {(['read', 'canvas-write', 'config-write', 'external-submit'] as const).map((effect) => (
                  <option key={effect} value={effect}>{t(`canvasAgent.effect.${effect}`)}</option>
                ))}
              </UiSelect>
              <span className="text-[10px] text-text-muted">
                {step.cost.confidence === 'unknown'
                  ? t('canvasAgent.costUnknown')
                  : t('canvasAgent.costKnown', { value: step.cost.value ?? 0 })}
              </span>
              <span className="text-[10px] text-text-muted">
                {step.duration.confidence === 'range'
                  ? t('canvasAgent.durationRange', { min: step.duration.min, max: step.duration.max })
                  : t('canvasAgent.durationUnknown')}
              </span>
              {editable ? (
                <span className="ml-auto inline-flex items-center">
                  <UiIconButton
                    disabled={index === 0}
                    className="h-11 w-11 sm:h-8 sm:w-8"
                    aria-label={t('canvasAgent.movePlanStepUp', { index: index + 1 })}
                    title={t('canvasAgent.movePlanStepUp', { index: index + 1 })}
                    onClick={() => {
                      const steps = [...item.plan.steps];
                      [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
                      changeSteps(steps);
                    }}
                  >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                  </UiIconButton>
                  <UiIconButton
                    disabled={index === item.plan.steps.length - 1}
                    className="h-11 w-11 sm:h-8 sm:w-8"
                    aria-label={t('canvasAgent.movePlanStepDown', { index: index + 1 })}
                    title={t('canvasAgent.movePlanStepDown', { index: index + 1 })}
                    onClick={() => {
                      const steps = [...item.plan.steps];
                      [steps[index], steps[index + 1]] = [steps[index + 1], steps[index]];
                      changeSteps(steps);
                    }}
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                  </UiIconButton>
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {editable ? (
        <>
          <UiButton
            variant="ghost"
            disabled={item.plan.steps.length >= 12}
            className="mt-2 min-h-11 gap-1.5 text-xs sm:min-h-9"
            onClick={() => changeSteps([...item.plan.steps, createAgentPlanStep(t('canvasAgent.newPlanStep'))])}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('canvasAgent.addPlanStep')}
          </UiButton>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <UiButton
              variant="primary"
              disabled={!item.plan.steps.some((step) => step.title.trim())}
              className="min-h-11 gap-1.5 text-xs"
              onClick={() => onPlanConfirm(item)}
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              {t('canvasAgent.runPlan')}
            </UiButton>
            <UiButton
              variant="secondary"
              className="min-h-11 gap-1.5 text-xs"
              onClick={() => onPlanCancel(item)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              {t('canvasAgent.cancelPlan')}
            </UiButton>
          </div>
        </>
      ) : (
        <div className="mt-3 text-[11px] text-text-muted">
          {item.plan.status === 'approved' ? t('canvasAgent.planApproved') : t('canvasAgent.planCancelled')}
        </div>
      )}
    </article>
  );
}

export function AgentFeedCard({ item, onApproval, onLocate, onRestoreDraft, onDiagnose, onPlanChange, onPlanConfirm, onPlanCancel, budgetDecision, onBudgetLimitChange, onRollback, onWithdrawTurn, decisionsLocked = false }: Props) {
  const { t } = useTranslation();
  const [diagnosticActionStatus, setDiagnosticActionStatus] = useState<'bundle-copied' | 'issue-copied' | 'downloaded' | 'failed' | null>(null);

  const copyDiagnosticText = async (text: string, status: 'bundle-copied' | 'issue-copied') => {
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await globalThis.navigator.clipboard.writeText(text);
      setDiagnosticActionStatus(status);
    } catch {
      setDiagnosticActionStatus('failed');
    }
  };

  const downloadDiagnosticBundle = (output: unknown) => {
    const serialized = serializeSafeDiagnosticBundlePreview(output);
    const fileName = diagnosticBundleFileName(output);
    if (!serialized || !fileName) {
      setDiagnosticActionStatus('failed');
      return;
    }
    let url: string | null = null;
    let anchor: HTMLAnchorElement | null = null;
    try {
      url = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }));
      anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      setDiagnosticActionStatus('downloaded');
    } catch {
      setDiagnosticActionStatus('failed');
    } finally {
      anchor?.remove();
      if (url) URL.revokeObjectURL(url);
    }
  };

  if (item.kind === 'message') {
    return <AgentMessage role={item.role} text={item.text} attachments={item.attachments} streaming={item.streaming} />;
  }

  if (item.kind === 'status') {
    const recoverable = item.status === 'error' && item.retryMessage;
    const withdrawable = onWithdrawTurn && item.runId && item.status !== 'running';
    return (
      <AgentNotice
        tone={item.status}
        detail={item.errorDetail}
        actions={recoverable || withdrawable ? (
          <>
            {recoverable && item.diagnosticMessage ? (
              <UiButton variant="destructive" size="sm" className="gap-1.5 text-xs" onClick={() => onDiagnose(item.diagnosticMessage!)}>
                <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                {t('canvasAgent.diagnoseAndContinue')}
              </UiButton>
            ) : null}
            {recoverable ? (
              <UiButton variant="secondary" size="sm" className="gap-1.5 text-xs" onClick={() => onRestoreDraft(item.retryMessage!)}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {t('canvasAgent.restoreDraft')}
              </UiButton>
            ) : null}
            {withdrawable ? (
              <UiButton
                variant="secondary"
                size="sm"
                disabled={Boolean(item.withdrawnAt)}
                className="gap-1.5 text-xs"
                title={t('canvasAgent.withdrawTurnHint')}
                onClick={() => onWithdrawTurn?.(item)}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {item.withdrawnAt ? t('canvasAgent.withdrawnTurn') : t('canvasAgent.withdrawTurn')}
              </UiButton>
            ) : null}
          </>
        ) : undefined}
      >
        {item.text}
      </AgentNotice>
    );
  }

  if (item.kind === 'reasoning') {
    return <AgentReasoning summary={item.summary} detail={item.detail} />;
  }

  if (item.kind === 'skill') {
    return (
      <details className="agent-feed-enter min-w-0 text-xs text-text-muted">
        <summary className="agent-step cursor-pointer list-none marker:content-none">
          <span className="agent-step__icon"><Sparkles aria-hidden="true" /></span>
          <span className="agent-step__detail">
            {/* Feed persisted before token counters were exempt from redaction holds a masked string; the number is unrecoverable. */}
            {Number.isFinite(item.estimatedTokens)
              ? t('canvasAgent.skillsLoaded', { skills: item.skillIds.join(', '), count: item.skillIds.length, tokens: item.estimatedTokens })
              : t('canvasAgent.skillsLoadedNoEstimate', { skills: item.skillIds.join(', '), count: item.skillIds.length })}
          </span>
          <ChevronRight className="agent-step__chevron" aria-hidden="true" />
        </summary>
        <div className="agent-step-body leading-5">
          <p>
            {t('canvasAgent.skillRouteSummary', {
              mode: t(`canvasAgent.skillRouteMode.${item.mode}`),
              tools: item.toolCount,
              deferred: item.deferredToolCount,
            })}
          </p>
          <p className="mt-1">
            <span className="font-medium text-text-dark">{t('canvasAgent.skillRouteReason')}</span>
            <span className="ml-1">{item.reason}</span>
          </p>
        </div>
      </details>
    );
  }

  if (item.kind === 'tool') {
    const generationProgress = generationProgressFromAgentOutput(item.output);
    const diagnosticBundle = item.toolName === 'diagnostics' && item.status === 'succeeded'
      ? extractSafeDiagnosticBundlePreview(item.output)
      : null;
    const diagnosticBundleJson = diagnosticBundle ? serializeSafeDiagnosticBundlePreview(diagnosticBundle) : null;
    const diagnosticIssueDraft = diagnosticBundle ? formatDiagnosticIssueDraft(diagnosticBundle) : null;
    const diagnosticStatusText = diagnosticActionStatus === 'bundle-copied'
      ? t('canvasAgent.diagnosticBundleCopied')
      : diagnosticActionStatus === 'issue-copied'
        ? t('canvasAgent.diagnosticIssueDraftCopied')
        : diagnosticActionStatus === 'downloaded'
          ? t('canvasAgent.diagnosticBundleDownloaded')
          : diagnosticActionStatus === 'failed'
            ? t('canvasAgent.diagnosticExportFailed')
            : null;
    const locateActions = item.generationInputNodeIds?.length || item.generationResultNodeIds?.length ? (
      <>
        {item.generationInputNodeIds?.length ? (
          <UiButton variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => onLocate(item.generationInputNodeIds!)}>
            <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
            {t('canvasAgent.locateGenerationInput')}
          </UiButton>
        ) : null}
        {item.generationResultNodeIds?.length ? (
          <UiButton variant="ghost" size="sm" className="gap-1 bg-success/8 text-xs text-success" onClick={() => onLocate(item.generationResultNodeIds!)}>
            <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
            {t('canvasAgent.locateGenerationResult')}
          </UiButton>
        ) : null}
      </>
    ) : item.nodeIds?.length ? (
      <UiButton variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => onLocate(item.nodeIds!)}>
        <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
        {t('canvasAgent.locate')}
      </UiButton>
    ) : null;
    const exportActions = diagnosticBundle && diagnosticBundleJson && diagnosticIssueDraft ? (
      <>
        <UiButton variant="secondary" size="sm" className="gap-1 text-xs" onClick={() => void copyDiagnosticText(diagnosticBundleJson, 'bundle-copied')}>
          <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
          {t('canvasAgent.copyDiagnosticBundle')}
        </UiButton>
        <UiButton variant="secondary" size="sm" className="gap-1 text-xs" onClick={() => void copyDiagnosticText(diagnosticIssueDraft, 'issue-copied')}>
          <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
          {t('canvasAgent.copyDiagnosticIssueDraft')}
        </UiButton>
        <UiButton variant="secondary" size="sm" className="gap-1 text-xs" onClick={() => downloadDiagnosticBundle(diagnosticBundle)}>
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          {t('canvasAgent.downloadDiagnosticBundle')}
        </UiButton>
        {diagnosticStatusText ? (
          <span className={`self-center text-[11px] ${diagnosticActionStatus === 'failed' ? 'text-danger' : 'text-success'}`} role="status">
            {diagnosticStatusText}
          </span>
        ) : null}
      </>
    ) : null;
    const rollbackAction = item.receiptId && item.rollbackToken ? (
      <UiButton variant="secondary" size="sm" disabled={Boolean(item.rolledBackAt)} className="gap-1 text-xs" onClick={() => onRollback(item)}>
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        {item.rolledBackAt ? t('canvasAgent.rolledBack') : t('canvasAgent.rollback')}
      </UiButton>
    ) : null;
    return (
      <AgentToolStep
        title={generationProgress
          ? generationProgress.phase === 'accepted'
            ? t('canvasAgent.generationSubmitted')
            : t('canvasAgent.generationPollingShort', { attempt: generationProgress.attempt, max: generationProgress.maxAttempts })
          : agentToolTitle(t, item.toolName)}
        status={item.status}
        raw={item.output ?? item.input ?? item.error}
        failure={agentToolFailureText(item.status, item.error, item.output)}
      >
        {locateActions || exportActions || rollbackAction ? <>{locateActions}{exportActions}{rollbackAction}</> : null}
      </AgentToolStep>
    );
  }

  if (item.kind === 'plan') {
    return (
      <PlanCard
        item={item}
        onPlanChange={onPlanChange}
        onPlanConfirm={onPlanConfirm}
        onPlanCancel={onPlanCancel}
      />
    );
  }

  return (
    <AgentApprovalCard
      toolName={item.toolName}
      questionBinding={{ projectId: useCanvasAgentPanelStore.getState().projectId ?? '', runId: item.runId, callId: item.approvalId }}
      summary={item.summary}
      impact={item.impact}
      args={item.arguments}
      status={item.status}
      expiresAt={item.expiresAt}
      disabled={decisionsLocked}
      approveDisabled={budgetDecision?.allowed === false}
      notice={<BudgetNotice budgetDecision={budgetDecision} onBudgetLimitChange={onBudgetLimitChange} />}
      onDecide={(approve) => {
        if (approve) applyAgentQuestionModelPreference(item, {
          projectId: useCanvasAgentPanelStore.getState().projectId ?? '', runId: item.runId, callId: item.approvalId,
        });
        onApproval(item, approve);
      }}
    />
  );
}
