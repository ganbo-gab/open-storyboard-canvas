import type { ComponentProps, RefObject } from 'react';
import { Bot, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { canvasAgentBudgetLedger } from '../application/agentBudget';
import type { AgentPlanDraft } from '../application/agentPlan';
import { AgentFeedCard } from './AgentFeedCard';
import { GenerationTasksPanel } from './GenerationTasksPanel';
import type { AgentFeedItem } from './agentPanelStore';

type Props = {
  projectId: string;
  activeView: 'conversation' | 'history' | 'activity' | 'tasks';
  nodes: ComponentProps<typeof GenerationTasksPanel>['nodes'];
  displayedFeed: AgentFeedItem[];
  sessions: Array<{ id: string; title: string; updatedAt: number }>;
  isRunning: boolean;
  pendingCount: number;
  showNewItems: boolean;
  scrollRef: RefObject<HTMLDivElement>;
  onScroll: () => void;
  onStartConversation: () => void;
  onLoadSession: (sessionId: string) => void;
  onApproval: (item: Extract<AgentFeedItem, { kind: 'approval' }>, approve: boolean) => void;
  onLocate: (nodeIds: string[]) => void;
  onRestoreDraft: (message: string) => void;
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
  pendingCount,
  showNewItems,
  scrollRef,
  onScroll,
  onStartConversation,
  onLoadSession,
  onApproval,
  onLocate,
  onRestoreDraft,
  onPlanChange,
  onPlanConfirm,
  onPlanCancel,
  onRollback,
  onJumpToLatest,
}: Props) {
  const { t } = useTranslation();

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
              {displayedFeed.map((item) => (
                <AgentFeedCard
                  key={item.id}
                  item={item}
                  onApproval={onApproval}
                  onLocate={onLocate}
                  onRestoreDraft={onRestoreDraft}
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
