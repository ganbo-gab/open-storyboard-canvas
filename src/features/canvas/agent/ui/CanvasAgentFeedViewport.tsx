import type { ComponentProps, RefObject } from 'react';
import { Bot, CheckCheck, ChevronRight, Plus, Wrench, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  showNewItems: boolean;
  scrollRef: RefObject<HTMLDivElement>;
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
  onJumpToLatest: () => void;
};

export function CanvasAgentFeedViewport({
  projectId,
  activeView,
  nodes,
  displayedFeed,
  sessions,
  isRunning,
  showCompletedTools,
  pendingCount,
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
  onJumpToLatest,
}: Props) {
  const { t } = useTranslation();
  const pendingApprovals = displayedFeed.filter(
    (item): item is Extract<AgentFeedItem, { kind: 'approval' }> => (
      item.kind === 'approval' && item.status === 'pending' && item.expiresAt > Date.now()
    ),
  );
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
              <button
                type="button"
                disabled={isRunning || pendingCount > 0}
                className="flex min-h-11 w-full items-center gap-2 rounded-[5px] border border-border-dark px-3 text-xs text-text-dark transition-[background-color,transform] duration-150 hover:bg-text-dark/[0.05] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                onClick={onStartConversation}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('canvasAgent.newConversation')}
              </button>
              {sessions.length ? sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="w-full rounded-[5px] border border-border-dark/60 px-3 py-2.5 text-left transition-[background-color,border-color,transform] duration-150 hover:border-border-dark hover:bg-text-dark/[0.04] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  onClick={() => onLoadSession(session.id)}
                >
                  <div className="truncate text-xs text-text-dark">{session.title}</div>
                  <div className="mt-1 text-[10px] text-text-muted">
                    {new Date(session.updatedAt).toLocaleString()}
                  </div>
                </button>
              )) : (
                <div className="px-3 py-8 text-center text-xs text-text-muted">
                  {t('canvasAgent.noHistory')}
                </div>
              )}
            </div>
          ) : displayedFeed.length ? (
            <div className="space-y-3">
              {visibleRegularFeed.map((item) => item.kind === 'tool-group' ? (
                <details key={item.id} className="agent-feed-enter rounded-[6px] border border-sky-500/20 bg-sky-500/[0.045] text-xs text-text-muted">
                  <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-3 py-1.5 marker:content-none">
                    <Wrench className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-300" aria-hidden="true" />
                    <span>{t('canvasAgent.completedToolCount', { count: item.tools.length })}</span>
                    <ChevronRight className="ml-auto h-3.5 w-3.5" aria-hidden="true" />
                  </summary>
                  <div className="space-y-1 border-t border-sky-500/15 p-1.5">
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
                />
              ))}
              {pendingApprovals.length ? (
                <section className="agent-feed-enter overflow-hidden rounded-[8px] border border-amber-500/35 bg-amber-500/[0.045]" aria-label={t('canvasAgent.approvalQueueTitle')}>
                  <header className="flex items-center justify-between border-b border-amber-500/20 px-3 py-2.5">
                    <div>
                      <div className="text-xs font-semibold text-text-dark">{t('canvasAgent.approvalQueueTitle')}</div>
                      <div className="mt-0.5 text-[10px] text-text-muted">{t('canvasAgent.approvalQueueCount', { count: pendingApprovals.length })}</div>
                    </div>
                  </header>
                  <div className="ui-scrollbar max-h-[min(46vh,420px)] space-y-2 overflow-y-auto p-2.5">
                    {pendingApprovals.map((item) => (
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
                        budgetDecision={canvasAgentBudgetLedger.evaluate(projectId, item.impact)}
                        onBudgetLimitChange={(limit) => { canvasAgentBudgetLedger.setLimit(projectId, limit); }}
                        onRollback={onRollback}
                      />
                    ))}
                  </div>
                  <footer className="sticky bottom-0 grid grid-cols-2 gap-2 border-t border-amber-500/20 bg-[var(--ui-surface-panel)] p-2.5 shadow-[0_-8px_20px_rgba(0,0,0,0.06)]">
                    <button
                      type="button"
                      disabled={isRunning}
                      className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[6px] bg-accent px-3 text-xs font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-accent/85 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                      onClick={() => onBatchApproval(pendingApprovals, true)}
                    >
                      <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('canvasAgent.approveAll')}
                    </button>
                    <button
                      type="button"
                      disabled={isRunning}
                      className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[6px] border border-border-dark px-3 text-xs text-text-dark transition-[background-color,transform] duration-150 hover:bg-text-dark/[0.05] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                      onClick={() => onBatchApproval(pendingApprovals, false)}
                    >
                      <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('canvasAgent.rejectAll')}
                    </button>
                  </footer>
                </section>
              ) : null}
            </div>
          ) : (
            <div className="flex min-h-56 flex-col items-center justify-center px-8 text-center">
              <Bot className="mb-3 h-7 w-7 text-accent" aria-hidden="true" />
              <div className="text-sm font-medium text-text-dark">{t('canvasAgent.emptyTitle')}</div>
              <div className="mt-2 text-xs leading-5 text-text-muted">{t('canvasAgent.emptyDescription')}</div>
            </div>
          )}
        </div>
      )}

      {activeView !== 'tasks' && showNewItems ? (
        <button
          type="button"
          className="sticky bottom-2 left-1/2 z-10 mx-auto flex min-h-11 -translate-x-1/2 items-center rounded-full border border-accent/[0.35] bg-bg-dark px-3 text-xs text-accent shadow-lg transition-[background-color,transform] duration-150 hover:bg-accent/[0.10] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-10"
          onClick={onJumpToLatest}
        >
          {t('canvasAgent.newItems')}
        </button>
      ) : null}
    </div>
  );
}
