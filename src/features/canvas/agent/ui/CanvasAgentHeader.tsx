import type { RefObject } from 'react';
import { Activity, Bot, History, ListChecks, MessageSquare, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type CanvasAgentView = 'conversation' | 'history' | 'activity' | 'tasks';

interface Props {
  selectedEntry?: { providerLabel: string; modelLabel: string } | null;
  activeView: CanvasAgentView;
  pendingCount: number;
  isRunning: boolean;
  onViewChange: (view: CanvasAgentView) => void;
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement>;
}

const views: Array<[CanvasAgentView, typeof MessageSquare]> = [
  ['conversation', MessageSquare],
  ['history', History],
  ['activity', Activity],
  ['tasks', ListChecks],
];

export function CanvasAgentHeader({
  selectedEntry,
  activeView,
  pendingCount,
  isRunning,
  onViewChange,
  onClose,
  closeRef,
}: Props) {
  const { t } = useTranslation();

  return (
    <>
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border-dark px-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] bg-accent/[0.12] text-accent">
          <Bot className="h-[18px] w-[18px]" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text-dark">{t('canvasAgent.title')}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-text-muted">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                isRunning ? 'bg-amber-400' : selectedEntry ? 'bg-emerald-500' : 'bg-text-muted/50'
              }`}
              aria-hidden="true"
            />
            <span className="truncate">
              {selectedEntry
                ? `${selectedEntry.providerLabel} / ${selectedEntry.modelLabel}`
                : t('canvasAgent.noModel')}
            </span>
          </div>
        </div>
        {pendingCount > 0 ? (
          <span
            className="inline-flex min-w-5 items-center justify-center rounded-full bg-amber-500/[0.15] px-1.5 text-[10px] font-semibold leading-5 text-amber-700 dark:text-amber-200"
            aria-label={t('canvasAgent.pendingApprovals', { count: pendingCount })}
          >
            {pendingCount}
          </span>
        ) : null}
        <button
          ref={closeRef}
          type="button"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[5px] text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <nav className="grid shrink-0 grid-cols-4 border-b border-border-dark p-1" aria-label={t('canvasAgent.views')}>
        {views.map(([view, Icon]) => (
          <button
            key={view}
            type="button"
            className={`relative inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[4px] text-xs transition-[background-color,color,transform] duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 ${
              activeView === view
                ? 'bg-text-dark/[0.06] text-text-dark'
                : 'text-text-muted hover:bg-text-dark/[0.04] hover:text-text-dark'
            }`}
            onClick={() => onViewChange(view)}
            aria-current={activeView === view ? 'page' : undefined}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {t(`canvasAgent.${view}`)}
            {view === 'activity' && pendingCount > 0 ? (
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
            ) : null}
          </button>
        ))}
      </nav>

      <div className="flex shrink-0 items-start gap-2 border-b border-border-dark/70 px-3 py-2 text-[11px] leading-5 text-text-muted">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        <span>{t('canvasAgent.scopeNotice')}</span>
      </div>
    </>
  );
}
