import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Bot, Clock3, Link2, ListChecks, MessageSquare, MessageSquarePlus, MoreHorizontal, Wrench, X } from 'lucide-react';
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
    <header className="shrink-0 border-b border-border-dark/75 bg-[var(--ui-surface-panel)]">
      <div className="flex min-h-[62px] items-center gap-2 px-3.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-accent/[0.11] text-accent">
          <Bot className="h-[18px] w-[18px]" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-text-dark">{t('canvasAgent.title')}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-muted">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isRunning ? 'bg-amber-400' : isReady ? 'bg-emerald-500' : 'bg-text-muted/45'}`} />
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
              className="absolute right-0 top-[calc(100%+4px)] z-50 w-52 rounded-lg border border-border-dark bg-[var(--ui-surface-panel)] p-1 shadow-[var(--ui-shadow-panel)]"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setMenuOpen(false);
                }
              }}
            >
              <button type="button" role="menuitemcheckbox" aria-checked={showCompletedTools} onClick={() => { onToggleCompletedTools(); setMenuOpen(false); }} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs text-text-dark hover:bg-text-dark/[0.055]">
                <Wrench className="h-4 w-4 text-text-muted" aria-hidden="true" />
                {showCompletedTools ? t('canvasAgent.hideCompletedTools') : t('canvasAgent.showCompletedTools')}
              </button>
              <button type="button" role="menuitem" onClick={() => { onOpenExternalConnection(); setMenuOpen(false); }} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs text-text-dark hover:bg-text-dark/[0.055]">
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
          <button
            key={view}
            type="button"
            aria-current={activeView === view ? 'page' : undefined}
            onClick={() => onViewChange(view)}
            className={`flex min-h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${activeView === view ? 'bg-accent/12 text-accent' : 'text-text-muted hover:bg-text-dark/[0.055] hover:text-text-dark'}`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{label}</span>
            {view === 'tasks' && taskCount > 0 && <span className="rounded-full bg-amber-400 px-1 text-[10px] font-semibold leading-4 text-black">{Math.min(taskCount, 99)}</span>}
          </button>
        ))}
      </nav>
    </header>
  );
}
