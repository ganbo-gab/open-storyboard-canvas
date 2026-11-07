import type { ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiIconButton } from '@/components/ui';
import { useModalFocus } from '@/components/ui/useModalFocus';

/** One modal shell for every stage dialog: glass card, title row, scrolling body, optional footer. */
export function StageDialog({ title, subtitle, width = 620, actions, footer, onClose, children }: {
  title: string;
  subtitle?: string;
  width?: number;
  actions?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const focus = useModalFocus({ isOpen: true, onClose });
  return (
    <div
      className="absolute inset-0 z-70 flex items-center justify-center bg-black/50 p-6 backdrop-blur-[2px]"
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={focus.dialogRef}
        onKeyDown={focus.onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="stage-glass stage-pop flex max-h-[84vh] w-full flex-col overflow-hidden rounded-2xl"
        style={{ maxWidth: width }}
      >
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[var(--line)] px-5 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-text-dark">{title}</h2>
            {subtitle ? <p className="mt-0.5 truncate text-[11px] text-text-subtle">{subtitle}</p> : null}
          </div>
          {actions}
          <UiIconButton size="sm" aria-label={t('common.close')} onClick={onClose}><X className="h-4 w-4" /></UiIconButton>
        </header>
        {children}
        {footer ? <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--line)] px-5 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** Selectable image card used by the background and reference pickers. */
export function StageImageTile({ url, label, active, disabled, onClick }: { url: string; label: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`group overflow-hidden rounded-xl bg-[var(--tile-bg)] text-left transition-[box-shadow,transform] hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'shadow-[0_0_0_1.5px_rgb(var(--accent-rgb))]' : 'shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--line-strong),0_10px_24px_rgb(0_0_0/0.35)]'}`}
    >
      <div className="relative aspect-video overflow-hidden bg-black/30">
        <img src={url} alt={label} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]" draggable={false} />
        {active ? <span className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full bg-accent text-[var(--accent-fg)]"><Check className="h-3 w-3" /></span> : null}
      </div>
      <div className="truncate px-2.5 py-2 text-xs text-text-muted group-hover:text-text-dark">{label}</div>
    </button>
  );
}
