import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleStop,
  ClipboardCopy,
  Crosshair,
  Download,
  Image,
  ImageOff,
  LoaderCircle,
  ListChecks,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
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
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unavailable]';
  }
}

export function normalizeCompactAgentMarkdown(value: string): string {
  const segments = value.split(/(```[\s\S]*?```|`[^`\n]+`|https?:\/\/\S+)/g);
  return segments.map((segment, index) => {
    if (index % 2 === 1) return segment;
    return segment
      .replace(/\*\*([^*\n]+)\*\*(?=\S)/g, '**$1**\n')
      .replace(/([^\n])\s+-\s+(?=[^\n])/g, '$1\n- ')
      .replace(/([^\n])---(?=\S)/g, '$1\n\n---\n')
      .replace(/：(?=(?:-|\d+\.|[A-Za-z][^\n]{0,20}:))/g, '：\n')
      .replace(/\s+-\s+(?=(?:节点|文件|比例|分辨率|状态|生成|资产|原始|解决|结果|Node|File|Ratio|Resolution|Status))/gi, '\n- ');
  }).join('');
}

function toolFailureText(item: Extract<AgentFeedItem, { kind: 'tool' }>): string | null {
  if (item.status !== 'failed' && item.status !== 'warning' && item.status !== 'unknown') return null;
  if (item.error?.trim()) return item.error.trim();
  if (!item.output || typeof item.output !== 'object' || Array.isArray(item.output)) return null;
  const record = item.output as Record<string, unknown>;
  const error = record.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return null;
}

function ApprovalCard({
  item,
  onApproval,
  budgetDecision,
  onBudgetLimitChange,
}: {
  item: ApprovalItem;
  onApproval: Props['onApproval'];
  budgetDecision?: AgentBudgetDecision;
  onBudgetLimitChange: Props['onBudgetLimitChange'];
}) {
  const { t } = useTranslation();
  const [cardExpanded, setCardExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState('');
  const expired = item.expiresAt <= Date.now() && item.status === 'pending';
  const status = expired ? 'expired' : item.status;
  const isDeciding = status === 'approving' || status === 'rejecting';
  const isTerminal = ['approved', 'rejected', 'failed', 'expired'].includes(status);

  if (isTerminal && !cardExpanded) {
    return (
      <button
        type="button"
        className="agent-feed-enter flex min-h-11 w-full items-center gap-2 rounded-[6px] border border-border-dark/60 bg-bg-dark/[0.45] px-3 py-2 text-left transition-[background-color,border-color] duration-150 hover:border-amber-500/30 hover:bg-amber-500/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
        onClick={() => setCardExpanded(true)}
        aria-expanded="false"
      >
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-dark">{item.toolName}</span>
        <span className="shrink-0 text-[11px] text-text-muted">{t(`canvasAgent.approvalStatus.${status}`)}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
      </button>
    );
  }

  return (
    <article
      className="agent-feed-enter rounded-[6px] border border-amber-500/[0.35] bg-amber-500/[0.07] p-3"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-text-dark">{item.toolName}</div>
          <p className="mt-1 text-xs leading-5 text-text-muted">{item.summary}</p>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-text-muted">
            <span className="rounded border border-amber-500/25 px-1.5 py-0.5">
              {t(`canvasAgent.effect.${item.impact.effect}`)}
            </span>
            {item.impact.affectedNodeCount > 0 ? (
              <span className="rounded border border-border-dark/70 px-1.5 py-0.5">
                {t('canvasAgent.affectedNodes', { count: item.impact.affectedNodeCount })}
              </span>
            ) : null}
            {item.impact.affectedEdgeCount > 0 ? (
              <span className="rounded border border-border-dark/70 px-1.5 py-0.5">
                {t('canvasAgent.affectedEdges', { count: item.impact.affectedEdgeCount })}
              </span>
            ) : null}
            {item.impact.model ? (
              <span className="max-w-full truncate rounded border border-border-dark/70 px-1.5 py-0.5">
                {t('canvasAgent.modelLabel', { model: item.impact.model })}
              </span>
            ) : null}
            {item.impact.estimatedCost ? (
              <span className="rounded border border-border-dark/70 px-1.5 py-0.5">
                {item.impact.estimatedCost.confidence === 'unknown'
                  ? t('canvasAgent.costUnknown')
                  : t('canvasAgent.costEstimate')}
              </span>
            ) : null}
          </div>
        </div>
        {isTerminal ? (
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] text-text-muted transition-colors duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            onClick={() => setCardExpanded(false)}
            aria-label={t('canvasAgent.collapseApproval')}
            title={t('canvasAgent.collapseApproval')}
            aria-expanded="true"
          >
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <button
        type="button"
        className="mt-2 inline-flex min-h-11 items-center gap-1 text-xs text-text-muted transition-colors duration-150 hover:text-text-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-9"
        onClick={() => setDetailsExpanded((value) => !value)}
        aria-expanded={detailsExpanded}
      >
        {detailsExpanded
          ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
        {t('canvasAgent.viewDetails')}
      </button>

      {detailsExpanded ? (
        <pre className="agent-disclosure-enter mt-2 max-h-48 overflow-auto rounded-[4px] bg-black/[0.08] p-2 text-[11px] leading-5 text-text-muted dark:bg-black/20">
          {stringify(item.arguments)}
        </pre>
      ) : null}

      {budgetDecision?.reason === 'budget-exceeded' ? (
        <div className="mt-3 rounded-[5px] border border-red-500/30 bg-red-500/[0.07] p-2.5" role="alert">
          <div className="flex items-start gap-2 text-[11px] leading-5 text-red-700 dark:text-red-200">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              {t('canvasAgent.budgetBlocked', {
                cost: budgetDecision.estimatedCost ?? 0,
                remaining: budgetDecision.remaining ?? 0,
              })}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.1"
              className="h-11 min-w-0 flex-1 rounded-[4px] border border-red-500/30 bg-bg-dark px-2 text-xs text-text-dark outline-none focus:border-red-400 focus:ring-2 focus:ring-red-400/20 sm:h-10"
              aria-label={t('canvasAgent.adjustBudget')}
              placeholder={t('canvasAgent.newBudgetLimit')}
              value={budgetDraft}
              onChange={(event) => setBudgetDraft(event.target.value)}
            />
            <button
              type="button"
              className="inline-flex min-h-11 items-center justify-center rounded-[4px] border border-red-500/30 px-2.5 text-xs text-red-700 transition-[background-color,transform] duration-150 hover:bg-red-500/[0.08] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 dark:text-red-200 sm:min-h-10"
              onClick={() => {
                const value = Number(budgetDraft);
                if (Number.isFinite(value) && value >= 0) onBudgetLimitChange(value);
              }}
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      ) : budgetDecision?.configured && budgetDecision.unknownCost ? (
        <div className="mt-3 text-[11px] leading-5 text-amber-700 dark:text-amber-200">
          {t('canvasAgent.unknownCostBudgetNotice', { remaining: budgetDecision.remaining ?? 0 })}
        </div>
      ) : null}

      {status === 'pending' ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={budgetDecision?.allowed === false}
            className="inline-flex min-h-11 items-center justify-center gap-1 rounded-[5px] bg-accent px-3 text-xs font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-accent/[0.85] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            onClick={() => onApproval(item, true)}
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            {t('canvasAgent.approve')}
          </button>
          <button
            type="button"
            className="inline-flex min-h-11 items-center justify-center gap-1 rounded-[5px] border border-border-dark px-3 text-xs text-text-dark transition-[background-color,transform] duration-150 hover:bg-text-dark/[0.05] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            onClick={() => onApproval(item, false)}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t('canvasAgent.reject')}
          </button>
        </div>
      ) : (
        <div className="mt-2 flex min-h-7 items-center gap-1.5 text-[11px] text-text-muted">
          {isDeciding ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden="true" /> : null}
          {t(`canvasAgent.approvalStatus.${status}`)}
        </div>
      )}
    </article>
  );
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
    <article className="agent-feed-enter rounded-[6px] border border-accent/25 bg-accent/[0.055] p-3" aria-live="polite">
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
          <li key={step.id} className="rounded-[5px] border border-border-dark/60 bg-bg-dark/55 p-2">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] bg-text-dark/[0.06] text-[10px] font-semibold text-text-muted">
                {index + 1}
              </span>
              <input
                aria-label={t('canvasAgent.planStepLabel', { index: index + 1 })}
                className="h-11 min-w-0 flex-1 rounded-[4px] border border-border-dark bg-bg-dark px-2 text-xs text-text-dark outline-none transition-[border-color,box-shadow] duration-150 focus:border-accent focus:ring-2 focus:ring-accent/[0.12] disabled:opacity-70 sm:h-9"
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
                <button
                  type="button"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-red-500/[0.08] hover:text-red-600 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 dark:hover:text-red-300 sm:h-9 sm:w-9"
                  aria-label={t('canvasAgent.removePlanStep', { index: index + 1 })}
                  title={t('canvasAgent.removePlanStep', { index: index + 1 })}
                  onClick={() => changeSteps(item.plan.steps.filter((candidate) => candidate.id !== step.id))}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-7">
              <select
                aria-label={t('canvasAgent.planStepEffect', { index: index + 1 })}
                className="h-11 rounded-[4px] border border-border-dark bg-bg-dark px-1.5 text-[10px] text-text-muted outline-none focus:border-accent focus:ring-2 focus:ring-accent/[0.12] sm:h-8"
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
              </select>
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
                  <button
                    type="button"
                    disabled={index === 0}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-[4px] text-text-muted hover:bg-text-dark/[0.05] disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:h-8 sm:w-8"
                    aria-label={t('canvasAgent.movePlanStepUp', { index: index + 1 })}
                    title={t('canvasAgent.movePlanStepUp', { index: index + 1 })}
                    onClick={() => {
                      const steps = [...item.plan.steps];
                      [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
                      changeSteps(steps);
                    }}
                  >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={index === item.plan.steps.length - 1}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-[4px] text-text-muted hover:bg-text-dark/[0.05] disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:h-8 sm:w-8"
                    aria-label={t('canvasAgent.movePlanStepDown', { index: index + 1 })}
                    title={t('canvasAgent.movePlanStepDown', { index: index + 1 })}
                    onClick={() => {
                      const steps = [...item.plan.steps];
                      [steps[index], steps[index + 1]] = [steps[index + 1], steps[index]];
                      changeSteps(steps);
                    }}
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {editable ? (
        <>
          <button
            type="button"
            disabled={item.plan.steps.length >= 12}
            className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-[4px] px-2 text-xs text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark active:scale-[0.98] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-9"
            onClick={() => changeSteps([...item.plan.steps, createAgentPlanStep(t('canvasAgent.newPlanStep'))])}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('canvasAgent.addPlanStep')}
          </button>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={!item.plan.steps.some((step) => step.title.trim())}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[5px] bg-accent px-3 text-xs font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-accent/[0.85] active:scale-[0.98] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              onClick={() => onPlanConfirm(item)}
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              {t('canvasAgent.runPlan')}
            </button>
            <button
              type="button"
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[5px] border border-border-dark px-3 text-xs text-text-dark transition-[background-color,transform] duration-150 hover:bg-text-dark/[0.05] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              onClick={() => onPlanCancel(item)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              {t('canvasAgent.cancelPlan')}
            </button>
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

export function AgentFeedCard({ item, onApproval, onLocate, onRestoreDraft, onDiagnose, onPlanChange, onPlanConfirm, onPlanCancel, budgetDecision, onBudgetLimitChange, onRollback }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
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
    return (
      <div
        className={`agent-feed-enter max-w-[96%] whitespace-pre-wrap rounded-[6px] px-2.5 py-2 text-[13px] leading-[1.65] ${
          item.role === 'user'
            ? 'ml-auto bg-accent/[0.12] text-text-dark'
            : 'border border-border-dark/60 bg-bg-dark/[0.55] text-text-dark'
        }`}
      >
        {item.role === 'assistant' ? (
          <div className="min-w-0 break-words [&_a]:text-accent [&_a]:underline [&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border-dark [&_blockquote]:pl-2.5 [&_code]:rounded [&_code]:bg-text-dark/[0.07] [&_code]:px-1 [&_code]:py-0.5 [&_h1]:mb-1.5 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_li]:my-0 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-0 [&_p+_p]:mt-2 [&_pre]:my-1.5 [&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:rounded-[5px] [&_pre]:bg-text-dark/[0.07] [&_pre]:p-2 [&_strong]:font-semibold [&_table]:my-1.5 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border-dark [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border-dark [&_th]:px-2 [&_th]:py-1 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} skipHtml>
              {normalizeCompactAgentMarkdown(item.text)}
            </ReactMarkdown>
          </div>
        ) : item.text}
        {item.attachments?.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t('canvasAgent.attachments')}>
            {item.attachments.map((attachment) => (
              <span
                key={attachment.referenceId}
                className={`inline-flex max-w-full items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[10px] ${
                  attachment.availability === 'missing'
                    ? 'border-red-500/30 bg-red-500/[0.06] text-red-700 dark:text-red-200'
                    : 'border-accent/25 bg-accent/[0.06] text-text-muted'
                }`}
                title={attachment.availability === 'missing'
                  ? t('canvasAgent.missingAttachmentNamed', { name: attachment.title })
                  : attachment.title}
              >
                {attachment.availability === 'missing'
                  ? <ImageOff className="h-3 w-3 shrink-0" aria-hidden="true" />
                  : <Image className="h-3 w-3 shrink-0" aria-hidden="true" />}
                <span className="truncate">{attachment.title}</span>
                {attachment.availability === 'missing'
                  ? <span className="shrink-0">{t('canvasAgent.missingReference')}</span>
                  : null}
              </span>
            ))}
          </div>
        ) : null}
        {item.streaming ? (
          <span
            className="ml-1 inline-block h-3 w-1 animate-pulse rounded-full bg-accent align-[-1px]"
            aria-label={t('canvasAgent.streaming')}
          />
        ) : null}
      </div>
    );
  }

  if (item.kind === 'status') {
    const icon = item.status === 'error'
      ? <CircleAlert className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-300" aria-hidden="true" />
      : item.status === 'cancelled'
        ? <CircleStop className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
        : item.status === 'completed'
          ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
          : <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" aria-hidden="true" />;
    return (
      <div
        className={`agent-feed-enter rounded-[6px] border px-3 py-2 text-xs leading-5 ${
          item.status === 'error'
            ? 'border-red-500/[0.35] bg-red-500/[0.08] text-red-700 dark:text-red-200'
            : 'border-border-dark/60 bg-bg-dark/[0.45] text-text-muted'
        }`}
        role={item.status === 'error' ? 'alert' : 'status'}
        aria-live="polite"
      >
        <div className="flex items-start gap-2">
          {icon}
          <span className="min-w-0 flex-1">{item.text}</span>
        </div>
        {item.status === 'error' && item.retryMessage ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.diagnosticMessage ? (
              <button
                type="button"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-[4px] bg-red-600 px-2.5 font-medium text-white transition-[background-color,transform] duration-150 hover:bg-red-500 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 sm:min-h-9"
                onClick={() => onDiagnose(item.diagnosticMessage!)}
              >
                <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                {t('canvasAgent.diagnoseAndContinue')}
              </button>
            ) : null}
            <button
              type="button"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-[4px] border border-current/25 px-2 transition-[background-color,transform] duration-150 hover:bg-red-500/[0.08] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 sm:min-h-9"
              onClick={() => onRestoreDraft(item.retryMessage!)}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              {t('canvasAgent.restoreDraft')}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (item.kind === 'reasoning') {
    return (
      <div className="agent-feed-enter rounded-[6px] border border-border-dark/60 bg-bg-dark/[0.45] text-xs">
        <button
          type="button"
          className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-text-muted transition-colors duration-150 hover:text-text-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <BrainCircuit className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 truncate">{item.summary}</span>
          {expanded
            ? <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            : <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        </button>
        {expanded && item.detail ? (
          <div className="agent-disclosure-enter whitespace-pre-wrap border-t border-border-dark/50 px-3 py-2 leading-5 text-text-muted">
            {item.detail}
          </div>
        ) : null}
      </div>
    );
  }

  if (item.kind === 'skill') {
    return (
      <details className="agent-feed-enter rounded-[6px] border border-accent/20 bg-accent/[0.06] text-xs text-text-muted">
        <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2 marker:content-none">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block">{t('canvasAgent.skillsLoaded', { skills: item.skillIds.join(', '), count: item.skillIds.length, tokens: item.estimatedTokens })}</span>
            <span className="mt-0.5 block text-[10px] text-text-muted/80">
              {t('canvasAgent.skillRouteSummary', {
                mode: t(`canvasAgent.skillRouteMode.${item.mode}`),
                tools: item.toolCount,
                deferred: item.deferredToolCount,
              })}
            </span>
          </span>
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </summary>
        <div className="agent-disclosure-enter border-t border-accent/15 px-3 py-2 leading-5">
          <span className="font-medium text-text-dark">{t('canvasAgent.skillRouteReason')}</span>
          <span className="ml-1">{item.reason}</span>
        </div>
      </details>
    );
  }

  if (item.kind === 'tool') {
    const failureText = toolFailureText(item);
    const generationProgress = generationProgressFromAgentOutput(item.output);
    const diagnosticBundle = item.toolName === 'diagnostics' && item.status === 'succeeded'
      ? extractSafeDiagnosticBundlePreview(item.output)
      : null;
    const diagnosticBundleJson = diagnosticBundle
      ? serializeSafeDiagnosticBundlePreview(diagnosticBundle)
      : null;
    const diagnosticIssueDraft = diagnosticBundle
      ? formatDiagnosticIssueDraft(diagnosticBundle)
      : null;
    const diagnosticStatusText = diagnosticActionStatus === 'bundle-copied'
      ? t('canvasAgent.diagnosticBundleCopied')
      : diagnosticActionStatus === 'issue-copied'
        ? t('canvasAgent.diagnosticIssueDraftCopied')
        : diagnosticActionStatus === 'downloaded'
          ? t('canvasAgent.diagnosticBundleDownloaded')
          : diagnosticActionStatus === 'failed'
            ? t('canvasAgent.diagnosticExportFailed')
            : null;
    return (
      <article className="agent-feed-enter rounded-[5px] border border-border-dark/55 bg-sky-500/[0.035] text-xs">
        <button
          type="button"
          className="flex min-h-9 w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-text-dark/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {item.status === 'executing'
            ? <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" aria-hidden="true" />
            : <Wrench className={`h-3.5 w-3.5 shrink-0 ${item.status === 'unknown' || item.status === 'warning' ? 'text-amber-600 dark:text-amber-300' : 'text-accent'}`} aria-hidden="true" />}
          <span className="min-w-0 truncate font-medium text-text-dark">
            {generationProgress
              ? generationProgress.phase === 'accepted'
                ? t('canvasAgent.generationSubmitted')
                : t('canvasAgent.generationPollingShort', {
                    attempt: generationProgress.attempt,
                    max: generationProgress.maxAttempts,
                  })
              : item.toolName}
          </span>
          <span className="ml-auto shrink-0 text-[11px] text-text-muted">
            {t(`canvasAgent.toolStatus.${item.status}`)}
          </span>
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />}
        </button>
        {expanded ? (
          <pre className="agent-disclosure-enter max-h-52 overflow-auto border-t border-border-dark/50 p-3 text-[11px] leading-5 text-text-muted">
            {stringify(item.output ?? item.input ?? item.error)}
          </pre>
        ) : null}
        {failureText ? (
          <div className={`mx-2 mb-2 flex items-start gap-1.5 rounded-[5px] border px-2.5 py-2 text-[11px] leading-5 ${item.status === 'unknown' || item.status === 'warning'
            ? 'border-amber-500/30 bg-amber-500/[0.07] text-amber-800 dark:text-amber-200'
            : 'border-red-500/30 bg-red-500/[0.07] text-red-700 dark:text-red-200'}`} role={item.status === 'failed' ? 'alert' : 'status'}>
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{failureText}</span>
          </div>
        ) : null}
        {item.generationInputNodeIds?.length || item.generationResultNodeIds?.length ? (
          <div className="m-2 flex flex-wrap gap-1.5">
            {item.generationInputNodeIds?.length ? (
              <button
                type="button"
                className="inline-flex min-h-11 items-center gap-1 rounded-[4px] px-2 text-text-dark transition-[background-color,transform] duration-150 hover:bg-text-dark/[0.05] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-9"
                onClick={() => onLocate(item.generationInputNodeIds!)}
              >
                <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
                {t('canvasAgent.locateGenerationInput')}
              </button>
            ) : null}
            {item.generationResultNodeIds?.length ? (
              <button
                type="button"
                className="inline-flex min-h-11 items-center gap-1 rounded-[4px] bg-emerald-500/[0.08] px-2 text-emerald-700 transition-[background-color,transform] duration-150 hover:bg-emerald-500/[0.14] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 dark:text-emerald-200 sm:min-h-9"
                onClick={() => onLocate(item.generationResultNodeIds!)}
              >
                <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
                {t('canvasAgent.locateGenerationResult')}
              </button>
            ) : null}
          </div>
        ) : item.nodeIds?.length ? (
          <button
            type="button"
            className="m-2 inline-flex min-h-11 items-center gap-1 rounded-[4px] px-2 text-text-dark transition-[background-color,transform] duration-150 hover:bg-text-dark/[0.05] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-9"
            onClick={() => onLocate(item.nodeIds!)}
          >
            <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
            {t('canvasAgent.locate')}
          </button>
        ) : null}
        {diagnosticBundle && diagnosticBundleJson && diagnosticIssueDraft ? (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border-dark/50 p-2">
            <button
              type="button"
              className="inline-flex min-h-11 items-center gap-1 rounded-[4px] border border-border-dark/70 px-2 text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-9"
              onClick={() => void copyDiagnosticText(diagnosticBundleJson, 'bundle-copied')}
            >
              <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
              {t('canvasAgent.copyDiagnosticBundle')}
            </button>
            <button
              type="button"
              className="inline-flex min-h-11 items-center gap-1 rounded-[4px] border border-border-dark/70 px-2 text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-9"
              onClick={() => void copyDiagnosticText(diagnosticIssueDraft, 'issue-copied')}
            >
              <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
              {t('canvasAgent.copyDiagnosticIssueDraft')}
            </button>
            <button
              type="button"
              className="inline-flex min-h-11 items-center gap-1 rounded-[4px] border border-border-dark/70 px-2 text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-9"
              onClick={() => downloadDiagnosticBundle(diagnosticBundle)}
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {t('canvasAgent.downloadDiagnosticBundle')}
            </button>
            {diagnosticStatusText ? (
              <span className={diagnosticActionStatus === 'failed' ? 'text-red-600 dark:text-red-300' : 'text-emerald-600 dark:text-emerald-300'} role="status">
                {diagnosticStatusText}
              </span>
            ) : null}
          </div>
        ) : null}
        {item.receiptId && item.rollbackToken ? (
          <button
            type="button"
            disabled={Boolean(item.rolledBackAt)}
            className="m-2 inline-flex min-h-11 items-center gap-1 rounded-[4px] border border-border-dark/70 px-2 text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-9"
            onClick={() => onRollback(item)}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {item.rolledBackAt ? t('canvasAgent.rolledBack') : t('canvasAgent.rollback')}
          </button>
        ) : null}
      </article>
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
    <ApprovalCard
      item={item}
      onApproval={onApproval}
      budgetDecision={budgetDecision}
      onBudgetLimitChange={onBudgetLimitChange}
    />
  );
}
