import type { ReactNode, RefObject } from 'react';
import { Bot, Clock3, Link2, ListChecks, MessageSquarePlus, Wrench, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CanvasAgentView } from './agentPanelStore';

interface Props {
  selectedEntry?: { providerLabel: string; modelLabel: string } | null;
  activeView: CanvasAgentView;
  taskCount: number;
  isRunning: boolean;
  isReady?: boolean;
  activityText?: string | null;
  showCompletedTools: boolean;
  onToggleCompletedTools: () => void;
  onNewConversation: () => void;
  onViewChange: (view: CanvasAgentView) => void;
  onOpenExternalConnection: () => void;
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement>;
}

function HeaderAction({
  label,
  active = false,
  badge = 0,
  onClick,
  children,
  buttonRef,
}: {
  label: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
  children: ReactNode;
  buttonRef?: RefObject<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[7px] transition-[background-color,color,transform] duration-150 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${active
        ? 'bg-accent/12 text-accent'
        : 'text-text-muted hover:bg-text-dark/[0.055] hover:text-text-dark'}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
      {badge > 0 ? (
        <span className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-amber-400 px-0.5 text-[9px] font-semibold leading-3.5 text-black">
          {Math.min(99, badge)}
        </span>
      ) : null}
    </button>
  );
}

export function CanvasAgentHeader({
  selectedEntry,
  activeView,
  taskCount,
  isRunning,
  isReady = Boolean(selectedEntry),
  activityText,
  showCompletedTools,
  onToggleCompletedTools,
  onNewConversation,
  onViewChange,
  onOpenExternalConnection,
  onClose,
  closeRef,
}: Props) {
  const { t } = useTranslation();
  const connectionStatus = isRunning
    ? activityText || t('canvasAgent.statusThinking')
    : isReady
      ? selectedEntry ? `${selectedEntry.providerLabel} / ${selectedEntry.modelLabel}` : t('canvasAgent.statusReady')
      : t('canvasAgent.noModel');

  return (
    <header className="flex min-h-[68px] shrink-0 items-center gap-2 border-b border-border-dark/75 px-3.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-accent/[0.11] text-accent">
        <Bot className="h-[18px] w-[18px]" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold text-text-dark">{t('canvasAgent.title')}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isRunning ? 'bg-amber-400' : isReady ? 'bg-emerald-500' : 'bg-text-muted/45'}`} />
          <span className="truncate">{connectionStatus}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <HeaderAction
          label={showCompletedTools ? t('canvasAgent.hideCompletedTools') : t('canvasAgent.showCompletedTools')}
          active={showCompletedTools}
          onClick={onToggleCompletedTools}
        >
          <Wrench className="h-[17px] w-[17px]" aria-hidden="true" />
        </HeaderAction>
        <HeaderAction label={t('canvasAgent.newConversation')} onClick={onNewConversation}>
          <MessageSquarePlus className="h-[17px] w-[17px]" aria-hidden="true" />
        </HeaderAction>
        <HeaderAction
          label={t('canvasAgent.history')}
          active={activeView === 'history'}
          onClick={() => onViewChange(activeView === 'history' ? 'conversation' : 'history')}
        >
          <Clock3 className="h-[17px] w-[17px]" aria-hidden="true" />
        </HeaderAction>
        <HeaderAction label={t('canvasAgent.externalConnection')} onClick={onOpenExternalConnection}>
          <Link2 className="h-[17px] w-[17px]" aria-hidden="true" />
        </HeaderAction>
        {taskCount > 0 ? (
          <HeaderAction
            label={t('canvasAgent.tasks')}
            active={activeView === 'tasks'}
            badge={taskCount}
            onClick={() => onViewChange(activeView === 'tasks' ? 'conversation' : 'tasks')}
          >
            <ListChecks className="h-[17px] w-[17px]" aria-hidden="true" />
          </HeaderAction>
        ) : null}
        <HeaderAction buttonRef={closeRef} label={t('common.close')} onClick={onClose}>
          <X className="h-[17px] w-[17px]" aria-hidden="true" />
        </HeaderAction>
      </div>
    </header>
  );
}
