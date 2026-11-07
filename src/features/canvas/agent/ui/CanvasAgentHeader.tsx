import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Bot, Clock3, Link2, ListChecks, MessageSquare, MessageSquarePlus, MoreHorizontal, Wrench, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton } from '@/components/ui';
import type { AgentModelIssue } from '@/features/agents/ui/useAgentTurnSelection';
import type { CanvasAgentView } from './agentPanelStore';

interface Props {
  selectedEntry?: { providerLabel: string; modelLabel: string } | null;
  /** Why the built-in runtime has no runnable model; named instead of a generic "no model". */
  modelIssue?: AgentModelIssue | null;
  requestedModelLabel?: string;
  runtimeLabel?: string;
  historyEnabled?: boolean;
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
  closeRef: RefObject<HTMLButtonElement | null>;
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
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <UiIconButton
      ref={buttonRef}
      size="lg"
      active={active}
      className="relative"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
      {badge > 0 ? (
        <span className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-warning/15 px-0.5 text-[9px] font-semibold leading-3.5 text-warning">
          {Math.min(99, badge)}
        </span>
      ) : null}
    </UiIconButton>
  );
}

export function CanvasAgentHeader({
  selectedEntry,
  modelIssue = null,
  requestedModelLabel = '',
  runtimeLabel,
  historyEnabled = true,
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
    : runtimeLabel
      ? `${runtimeLabel} · ${t(isReady ? 'canvasAgent.statusReady' : 'canvasAgent.runtime.status.unavailable')}`
      : isReady
        ? selectedEntry ? `${selectedEntry.providerLabel} / ${selectedEntry.modelLabel}` : t('canvasAgent.statusReady')
        : modelIssue
          ? t(`rework.agent.selection.issue.${modelIssue}`, { model: requestedModelLabel })
          : t('canvasAgent.noModel');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus();
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  return (
    <header className="shrink-0 border-b border-[var(--line)] bg-elevated">
      <div className="flex min-h-[62px] items-center gap-2 px-3.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-accent/11 text-accent">
          <Bot className="h-[18px] w-[18px]" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-text-dark">{t('canvasAgent.title')}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-muted">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isRunning ? 'bg-warning' : isReady ? 'bg-success' : 'bg-text-muted/45'}`} />
            <span className="truncate">{connectionStatus}</span>
          </div>
        </div>
        <HeaderAction label={t('canvasAgent.newConversation')} onClick={onNewConversation}>
          <MessageSquarePlus className="h-[17px] w-[17px]" aria-hidden="true" />
        </HeaderAction>
        <div ref={menuRef} className="relative">
          <HeaderAction label={t('canvasAgent.moreActions')} active={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
            <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden="true" />
          </HeaderAction>
          {menuOpen && (
            <div
              role="menu"
              aria-label={t('canvasAgent.moreActions')}
              className="ui-menu absolute right-0 top-[calc(100%+4px)] z-50 w-52 p-1"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setMenuOpen(false);
                }
              }}
            >
              <button type="button" role="menuitemcheckbox" aria-checked={showCompletedTools} onClick={() => { onToggleCompletedTools(); setMenuOpen(false); }} className="ui-menu__item min-h-10 w-full gap-2 rounded-md px-2.5 text-xs">
                <Wrench className="h-4 w-4 text-text-muted" aria-hidden="true" />
                {showCompletedTools ? t('canvasAgent.hideCompletedTools') : t('canvasAgent.showCompletedTools')}
              </button>
              <button type="button" role="menuitem" onClick={() => { onOpenExternalConnection(); setMenuOpen(false); }} className="ui-menu__item min-h-10 w-full gap-2 rounded-md px-2.5 text-xs">
                <Link2 className="h-4 w-4 text-text-muted" aria-hidden="true" />
                {t('canvasAgent.externalConnection')}
              </button>
            </div>
          )}
        </div>
        <HeaderAction buttonRef={closeRef} label={t('common.close')} onClick={onClose}>
          <X className="h-[17px] w-[17px]" aria-hidden="true" />
        </HeaderAction>
      </div>
      <nav className="flex gap-1 px-3.5 pb-2" aria-label={t('canvasAgent.navigation')}>
        {([
          ['conversation', t('canvasAgent.conversation'), MessageSquare],
          ['history', t('canvasAgent.history'), Clock3],
          ['tasks', t('canvasAgent.tasks'), ListChecks],
        ] as const).map(([view, label, Icon]) => (
          <UiButton
            variant="ghost"
            key={view}
            type="button"
            aria-current={activeView === view ? 'page' : undefined}
            disabled={view === 'history' && !historyEnabled}
            title={view === 'history' && !historyEnabled ? t('canvasAgent.runtime.historyBuiltinOnly') : undefined}
            onClick={() => onViewChange(view)}
            className={`min-h-9 min-w-0 flex-1 gap-1.5 rounded-md px-2 text-xs ${activeView === view ? 'bg-accent/12 text-accent hover:bg-accent/15 hover:text-accent' : ''}`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{label}</span>
            {view === 'tasks' && taskCount > 0 && <span className="rounded-full bg-warning/15 px-1 text-[10px] font-semibold leading-4 text-warning">{Math.min(taskCount, 99)}</span>}
          </UiButton>
        ))}
      </nav>
    </header>
  );
}
