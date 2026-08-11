import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Pin, PinOff, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  brief: string;
  pinnedNodes: Array<{ id: string; label: string }>;
  selectedNode: { id: string; label: string } | null;
  budgetLimit: number | null;
  budgetSpent: number;
  budgetReserved: number;
  onBriefChange: (brief: string) => void;
  onTogglePinnedNode: (nodeId: string) => void;
  onClear: () => void;
  onBudgetLimitChange: (limit: number | null) => void;
  onBudgetReset: () => void;
}

export function CanvasAgentContextPanel({
  brief,
  pinnedNodes,
  selectedNode,
  budgetLimit,
  budgetSpent,
  budgetReserved,
  onBriefChange,
  onTogglePinnedNode,
  onClear,
  onBudgetLimitChange,
  onBudgetReset,
}: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState(budgetLimit === null ? '' : String(budgetLimit));
  const selectedPinned = selectedNode
    ? pinnedNodes.some((node) => node.id === selectedNode.id)
    : false;

  useEffect(() => {
    setBudgetDraft(budgetLimit === null ? '' : String(budgetLimit));
  }, [budgetLimit]);

  return (
    <section className="shrink-0 border-b border-border-dark/70" aria-label={t('canvasAgent.projectContext')}>
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-xs text-text-muted transition-colors duration-150 hover:bg-text-dark/[0.03] hover:text-text-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {brief.trim() ? t('canvasAgent.projectBriefReady') : t('canvasAgent.projectBriefEmpty')}
        </span>
        {pinnedNodes.length ? (
          <span className="shrink-0 rounded border border-border-dark/70 px-1.5 py-0.5 text-[10px]">
            {t('canvasAgent.pinnedCount', { count: pinnedNodes.length })}
          </span>
        ) : null}
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      </button>

      {expanded ? (
        <div className="agent-disclosure-enter space-y-2 border-t border-border-dark/50 p-3">
          <label className="block text-[11px] font-medium text-text-dark" htmlFor="canvas-agent-project-brief">
            {t('canvasAgent.projectBrief')}
          </label>
          <textarea
            id="canvas-agent-project-brief"
            className="min-h-24 w-full resize-y rounded-[5px] border border-border-dark bg-bg-dark px-2.5 py-2 text-xs leading-5 text-text-dark outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/[0.12]"
            maxLength={8_000}
            value={brief}
            placeholder={t('canvasAgent.projectBriefPlaceholder')}
            onChange={(event) => onBriefChange(event.target.value)}
          />

          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
            <label className="block min-w-0 text-[11px] font-medium text-text-dark">
              <span>{t('canvasAgent.projectBudget')}</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.1"
                className="mt-1 h-11 w-full rounded-[5px] border border-border-dark bg-bg-dark px-2.5 text-xs text-text-dark outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/[0.12] sm:h-10"
                value={budgetDraft}
                placeholder={t('canvasAgent.projectBudgetUnlimited')}
                onChange={(event) => setBudgetDraft(event.target.value)}
                onBlur={() => {
                  const trimmed = budgetDraft.trim();
                  if (!trimmed) onBudgetLimitChange(null);
                  else {
                    const value = Number(trimmed);
                    if (Number.isFinite(value) && value >= 0) onBudgetLimitChange(value);
                    else setBudgetDraft(budgetLimit === null ? '' : String(budgetLimit));
                  }
                }}
              />
            </label>
            <button
              type="button"
              disabled={budgetSpent === 0 && budgetReserved === 0}
              className="inline-flex h-11 items-center justify-center rounded-[5px] border border-border-dark px-2.5 text-[11px] text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark active:scale-[0.98] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:h-10"
              onClick={onBudgetReset}
            >
              {t('canvasAgent.resetBudgetUsage')}
            </button>
          </div>
          <div className="text-[10px] leading-4 text-text-muted">
            {budgetLimit === null
              ? t('canvasAgent.budgetUsageUnlimited', { spent: budgetSpent, reserved: budgetReserved })
              : t('canvasAgent.budgetUsage', { spent: budgetSpent, reserved: budgetReserved, limit: budgetLimit })}
          </div>

          {pinnedNodes.length ? (
            <div className="flex flex-wrap gap-1.5" aria-label={t('canvasAgent.pinnedReferences')}>
              {pinnedNodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className="inline-flex min-h-11 max-w-full items-center gap-1 rounded-[4px] border border-border-dark px-2 text-[11px] text-text-dark transition-[background-color,transform] duration-150 hover:bg-text-dark/[0.05] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-9"
                  title={t('canvasAgent.unpinReference', { name: node.label })}
                  onClick={() => onTogglePinnedNode(node.id)}
                >
                  <PinOff className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{node.label}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={!selectedNode}
              className="inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-[5px] border border-border-dark px-2.5 text-xs text-text-dark transition-[background-color,transform] duration-150 hover:bg-text-dark/[0.05] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-10"
              title={selectedNode
                ? selectedPinned
                  ? t('canvasAgent.unpinReference', { name: selectedNode.label })
                  : t('canvasAgent.pinReference', { name: selectedNode.label })
                : t('canvasAgent.selectNodeToPin')}
              onClick={() => selectedNode && onTogglePinnedNode(selectedNode.id)}
            >
              {selectedPinned
                ? <PinOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                : <Pin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              <span className="truncate">
                {selectedPinned ? t('canvasAgent.unpinSelected') : t('canvasAgent.pinSelected')}
              </span>
            </button>
            <button
              type="button"
              disabled={!brief && pinnedNodes.length === 0}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[5px] text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-red-500/[0.08] hover:text-red-600 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 dark:hover:text-red-300 sm:h-10 sm:w-10"
              aria-label={t('canvasAgent.clearProjectContext')}
              title={t('canvasAgent.clearProjectContext')}
              onClick={onClear}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
