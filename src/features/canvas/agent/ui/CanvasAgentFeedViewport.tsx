import type { ComponentProps, RefObject } from 'react';
import { Bot, CheckCheck, ChevronRight, Plus, ShieldCheck, Wrench, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton } from '@/components/ui';
import { AgentEmptyState } from '@/features/agents/ui/AgentThread';
import { canvasAgentBudgetLedger } from '../application/agentBudget';
import type { AgentPlanDraft } from '../application/agentPlan';
import { AgentFeedCard } from './AgentFeedCard';
import { GenerationTasksPanel } from './GenerationTasksPanel';
import type { AgentFeedItem } from './agentPanelStore';

type ToolGroupItem = {
  id: string;
  kind: 'tool-group';
  tools: Array<Extract<AgentFeedItem, { kind: 'tool' }>>;
};

export function projectAgentFeedForDisplay(
  feed: AgentFeedItem[],
  isRunning: boolean,
  showCompletedTools: boolean,
): Array<AgentFeedItem | ToolGroupItem> {
  let activeTurnStart = feed.length;
  if (isRunning) {
    for (let index = feed.length - 1; index >= 0; index -= 1) {
      const item = feed[index];
      if (item.kind === 'message' && item.role === 'user') {
        activeTurnStart = index;
        break;
      }
    }
  }
  const output: Array<AgentFeedItem | ToolGroupItem> = [];
  let completedTools: ToolGroupItem['tools'] = [];
  const flushTools = () => {
    if (showCompletedTools && completedTools.length) {
      output.push({
        id: `tool-group:${completedTools[0].id}:${completedTools.length}`,
        kind: 'tool-group',
        tools: completedTools,
      });
    }
    completedTools = [];
  };
  for (const [index, item] of feed.entries()) {
    if (item.kind === 'message' && item.role === 'user') flushTools();
    const isLiveTool = isRunning && index >= activeTurnStart;
    const isLocatableGenerationReceipt = item.kind === 'tool'
      && Boolean(item.generationInputNodeIds?.length || item.generationResultNodeIds?.length);
    if (item.kind === 'tool' && item.status === 'succeeded' && !isLiveTool && !isLocatableGenerationReceipt) {
      completedTools.push(item);
      continue;
    }
    output.push(item);
  }
  flushTools();
  return output;
}

type Props = {
  projectId: string;
  activeView: 'conversation' | 'history' | 'tasks';
  nodes: ComponentProps<typeof GenerationTasksPanel>['nodes'];
  displayedFeed: AgentFeedItem[];
  sessions: Array<{ id: string; title: string; updatedAt: number }>;
  isRunning: boolean;
  showCompletedTools: boolean;
  pendingCount: number;
  hasPendingPlan: boolean;
  showNewItems: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onStartConversation: () => void;
  onLoadSession: (sessionId: string) => void;
  onApproval: (item: Extract<AgentFeedItem, { kind: 'approval' }>, approve: boolean) => void;
  onBatchApproval: (items: Array<Extract<AgentFeedItem, { kind: 'approval' }>>, approve: boolean) => void;
  onLocate: (nodeIds: string[]) => void;
  onRestoreDraft: (message: string) => void;
  onDiagnose: (message: string) => void;
  onPlanChange: (item: Extract<AgentFeedItem, { kind: 'plan' }>, plan: AgentPlanDraft) => void;
  onPlanConfirm: (item: Extract<AgentFeedItem, { kind: 'plan' }>) => void;
  onPlanCancel: (item: Extract<AgentFeedItem, { kind: 'plan' }>) => void;
  onRollback: (item: Extract<AgentFeedItem, { kind: 'tool' }>) => void;
  onWithdrawTurn?: (item: Extract<AgentFeedItem, { kind: 'status' }>) => void;
  onJumpToLatest: () => void;
};

type ApprovalItem = Extract<AgentFeedItem, { kind: 'approval' }>;

function approvalCommandType(item: ApprovalItem): string {
  const args = item.arguments;
  return args && typeof args === 'object' && 'type' in args && typeof args.type === 'string' ? args.type : '';
}

/**
 * UI projection only: same run + tool + command type become one card; each approval is still resolved
 * individually. Paid/external work stays one card per approval so cost and budget checks remain visible.
 */
function groupPendingApprovals(items: readonly ApprovalItem[]): ApprovalItem[][] {
  const groups = new Map<string, ApprovalItem[]>();
  for (const item of items) {
    const key = item.impact.externalSideEffect || item.toolName === 'request_user_input'
      ? item.id
      : `${item.runtimeId ?? 'builtin'}\u0000${item.runId}\u0000${item.toolName}\u0000${approvalCommandType(item)}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()];
}

export function CanvasAgentFeedViewport({
  projectId,
  activeView,
  nodes,
  displayedFeed,
  sessions,
  isRunning,
  showCompletedTools,
  pendingCount,
  hasPendingPlan,
  showNewItems,
  scrollRef,
  onScroll,
  onStartConversation,
  onLoadSession,
  onApproval,
  onBatchApproval,
  onLocate,
  onRestoreDraft,
  onDiagnose,
  onPlanChange,
  onPlanConfirm,
  onPlanCancel,
  onRollback,
  onWithdrawTurn,
  onJumpToLatest,
}: Props) {
  const { t } = useTranslation();
  const pendingApprovals = displayedFeed.filter(
    (item): item is ApprovalItem => (
      item.kind === 'approval' && item.status === 'pending' && item.expiresAt > Date.now()
    ),
  );
  const actionableApprovals = pendingApprovals.filter(item => item.toolName !== 'request_user_input');
  const onlyQuestions = pendingApprovals.length > 0 && actionableApprovals.length === 0;
  const approvalGroups = groupPendingApprovals(pendingApprovals);
  const regularFeed = pendingApprovals.length
    ? displayedFeed.filter((item) => item.kind !== 'approval' || item.status !== 'pending' || item.expiresAt <= Date.now())
    : displayedFeed;
  const visibleRegularFeed = projectAgentFeedForDisplay(regularFeed, isRunning, showCompletedTools);

  return (
    <div
      ref={scrollRef}
      className={`ui-scrollbar relative min-h-0 flex-1 ${
        activeView === 'tasks' ? 'overflow-hidden' : 'overflow-y-auto p-3'
      }`}
      onScroll={onScroll}
    >
      {activeView === 'tasks' ? (
        <div key={activeView} className="agent-view-enter flex h-full min-h-0 flex-col">
          <GenerationTasksPanel nodes={nodes} />
        </div>
      ) : (
        <div key={activeView} className="agent-view-enter">
          {activeView === 'history' ? (
            <div className="space-y-2">
              <UiButton
                variant="secondary"
                disabled={isRunning || pendingCount > 0 || hasPendingPlan}
                className="min-h-11 w-full justify-start gap-2 text-xs"
                onClick={onStartConversation}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('canvasAgent.newConversation')}
              </UiButton>
              {sessions.length ? sessions.map((session) => (
                <UiButton
                  variant="ghost"
                  key={session.id}
                  type="button"
                  disabled={isRunning || pendingCount > 0 || hasPendingPlan}
                  className="h-auto w-full flex-col items-stretch rounded-[5px] border border-[var(--line)] px-3 py-2.5 text-left hover:border-[var(--line-strong)]"
                  onClick={() => onLoadSession(session.id)}
                >
                  <div className="truncate text-xs text-text-dark">{session.title}</div>
                  <div className="mt-1 text-[10px] text-text-muted">
                    {new Date(session.updatedAt).toLocaleString()}
                  </div>
                </UiButton>
              )) : (
                <div className="px-3 py-8 text-center text-xs text-text-muted">
                  {t('canvasAgent.noHistory')}
                </div>
              )}
            </div>
          ) : displayedFeed.length ? (
            <div className="flex flex-col gap-3">
              {visibleRegularFeed.map((item) => item.kind === 'tool-group' ? (
                <details key={item.id} className="agent-feed-enter min-w-0 text-xs text-text-muted">
                  <summary className="agent-step cursor-pointer list-none marker:content-none">
                    <span className="agent-step__icon"><Wrench aria-hidden="true" /></span>
                    <span className="agent-step__detail">{t('canvasAgent.completedToolCount', { count: item.tools.length })}</span>
                    <ChevronRight className="agent-step__chevron" aria-hidden="true" />
                  </summary>
                  <div className="agent-step-body flex flex-col gap-0.5">
                    {item.tools.map((tool) => (
                      <AgentFeedCard key={tool.id} item={tool} onApproval={onApproval} onLocate={onLocate} onRestoreDraft={onRestoreDraft} onDiagnose={onDiagnose} onPlanChange={onPlanChange} onPlanConfirm={onPlanConfirm} onPlanCancel={onPlanCancel} onBudgetLimitChange={(limit) => { canvasAgentBudgetLedger.setLimit(projectId, limit); }} onRollback={onRollback} />
                    ))}
                  </div>
                </details>
              ) : (
                <AgentFeedCard
                  key={item.id}
                  item={item}
                  onApproval={onApproval}
                  onLocate={onLocate}
                  onRestoreDraft={onRestoreDraft}
                  onDiagnose={onDiagnose}
                  onPlanChange={onPlanChange}
                  onPlanConfirm={onPlanConfirm}
                  onPlanCancel={onPlanCancel}
                  budgetDecision={item.kind === 'approval'
                    ? canvasAgentBudgetLedger.evaluate(projectId, item.impact)
                    : undefined}
                  onBudgetLimitChange={(limit) => { canvasAgentBudgetLedger.setLimit(projectId, limit); }}
                  onRollback={onRollback}
                  onWithdrawTurn={onWithdrawTurn}
                  decisionsLocked={isRunning}
                />
              ))}
              {pendingApprovals.length ? (
                <section className={onlyQuestions ? 'agent-feed-enter' : 'agent-feed-enter rounded-[18px] bg-warning/[0.06] p-1.5'} aria-label={t(onlyQuestions ? 'canvasAgent.question.title' : 'canvasAgent.approvalQueueTitle')}>
                  {!onlyQuestions ? <header className="flex items-center gap-2 px-2 pb-1.5 pt-1.5">
                    <p className="agent-card__eyebrow text-warning">
                      <ShieldCheck aria-hidden="true" />
                      <span>{t(onlyQuestions ? 'canvasAgent.question.title' : 'canvasAgent.approvalQueueTitle')}</span>
                    </p>
                    {!onlyQuestions ? <span className="ml-auto text-[11px] text-text-subtle">{t('canvasAgent.approvalQueueCount', { count: actionableApprovals.length })}</span> : null}
                  </header> : null}
                  <div className={onlyQuestions ? 'flex flex-col gap-2' : 'ui-scrollbar flex max-h-[min(46vh,420px)] flex-col gap-2 overflow-y-auto'}>
                    {approvalGroups.map((group) => group.length === 1 ? (
                      <AgentFeedCard
                        key={group[0].id}
                        item={group[0]}
                        onApproval={onApproval}
                        onLocate={onLocate}
                        onRestoreDraft={onRestoreDraft}
                        onDiagnose={onDiagnose}
                        onPlanChange={onPlanChange}
                        onPlanConfirm={onPlanConfirm}
                        onPlanCancel={onPlanCancel}
                        budgetDecision={canvasAgentBudgetLedger.evaluate(projectId, group[0].impact)}
                        onBudgetLimitChange={(limit) => { canvasAgentBudgetLedger.setLimit(projectId, limit); }}
                        onRollback={onRollback}
                        decisionsLocked={isRunning}
                      />
                    ) : (
                      <article key={group[0].id} className="agent-card" aria-label={t('canvasAgent.mergedApprovalTitle', { count: group.length })}>
                        <div className="flex items-center gap-2">
                          <h3 className="agent-card__title mt-0 min-w-0 flex-1">{group[0].summary}</h3>
                          <span className="rounded-full bg-warning/15 px-1.5 text-[10px] text-warning">×{group.length}</span>
                        </div>
                        <p className="agent-card__body">{t('canvasAgent.mergedApprovalHint', { count: group.length })}</p>
                        <ol className="ui-scrollbar mt-2 max-h-40 list-decimal space-y-1 overflow-y-auto pl-5 text-[11.5px] leading-4 text-text-muted">
                          {group.map((item) => <li key={item.id} className="wrap-break-word">{item.impact.summary || item.summary}</li>)}
                        </ol>
                        <div className="agent-card__actions">
                          <UiButton variant="secondary" disabled={isRunning} className="min-h-9 text-xs" onClick={() => onBatchApproval(group, false)}>
                            {t('canvasAgent.rejectGroup', { count: group.length })}
                          </UiButton>
                          <UiButton variant="primary" disabled={isRunning} className="min-h-9 text-xs" onClick={() => onBatchApproval(group, true)}>
                            {t('canvasAgent.approveGroup', { count: group.length })}
                          </UiButton>
                        </div>
                      </article>
                    ))}
                  </div>
                  {actionableApprovals.length > 1 ? <footer className="sticky bottom-0 mt-1.5 grid grid-cols-2 gap-2 rounded-[14px] bg-elevated p-2 shadow-[var(--shadow-pop)]">
                    <UiButton
                      variant="primary"
                      disabled={isRunning}
                      className="min-h-11 gap-1.5 text-xs"
                      onClick={() => onBatchApproval(actionableApprovals, true)}
                    >
                      <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('canvasAgent.approveAll')}
                    </UiButton>
                    <UiButton
                      variant="secondary"
                      disabled={isRunning}
                      className="min-h-11 gap-1.5 text-xs"
                      onClick={() => onBatchApproval(actionableApprovals, false)}
                    >
                      <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('canvasAgent.rejectAll')}
                    </UiButton>
                  </footer> : null}
                </section>
              ) : null}
            </div>
          ) : (
            <AgentEmptyState
              icon={<Bot className="h-7 w-7" />}
              title={t('canvasAgent.emptyTitle')}
              description={t('canvasAgent.emptyDescription')}
            />
          )}
        </div>
      )}

      {activeView !== 'tasks' && showNewItems ? (
        <UiButton
          variant="secondary"
          className="sticky bottom-2 left-1/2 z-10 mx-auto flex min-h-11 -translate-x-1/2 rounded-full text-xs shadow-[var(--shadow-pop)] sm:min-h-10"
          onClick={onJumpToLatest}
        >
          {t('canvasAgent.newItems')}
        </UiButton>
      ) : null}
    </div>
  );
}
