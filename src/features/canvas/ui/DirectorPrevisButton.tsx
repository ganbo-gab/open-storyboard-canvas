import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export interface DirectorPrevisButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
  icon: ReactNode;
  description?: string;
  shortcut?: string;
  active?: boolean;
  showLabel?: boolean;
  compact?: boolean;
  disabledReason?: string;
  wrapperClassName?: string;
}

/** Director tool with visible feedback and a WebView-safe tooltip target. */
export const DirectorPrevisButton = forwardRef<HTMLButtonElement, DirectorPrevisButtonProps>(function DirectorPrevisButton({
  label,
  icon,
  description,
  shortcut,
  active,
  showLabel = true,
  compact = false,
  disabled = false,
  disabledReason,
  wrapperClassName = '',
  className = '',
  title,
  type = 'button',
  'aria-label': ariaLabel,
  'aria-pressed': ariaPressed,
  tabIndex,
  ...props
}, ref) {
  const tooltip = [
    `${label}${shortcut ? ` (${shortcut})` : ''}`,
    disabled && disabledReason ? disabledReason : (description ?? title),
  ].filter(Boolean).join(' · ');

  return (
    <span
      className={`inline-flex min-w-0 max-w-full rounded-md align-middle ${disabled ? 'cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#68cfcb] focus-visible:ring-offset-2 focus-visible:ring-offset-[#102427]' : ''} ${wrapperClassName}`}
      data-director-tooltip={disabled ? tooltip : undefined}
      role={disabled ? 'button' : undefined}
      aria-label={disabled ? (ariaLabel ?? label) : undefined}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? (tabIndex ?? 0) : undefined}
    >
      <button
        {...props}
        ref={ref}
        type={type}
        disabled={disabled}
        tabIndex={disabled ? -1 : tabIndex}
        aria-hidden={disabled || undefined}
        aria-label={ariaLabel ?? label}
        aria-pressed={ariaPressed ?? active}
        data-director-tooltip={disabled ? undefined : tooltip}
        data-active={active || undefined}
        className={`relative inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border font-medium outline-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-[#68cfcb] focus-visible:ring-offset-2 focus-visible:ring-offset-[#102427] ${compact ? 'min-h-8 px-2 py-1 text-[11px]' : 'min-h-10 px-2.5 py-2 text-xs'} ${active ? 'border-[#68cfcb]/60 bg-[#28605e] text-white shadow-[inset_0_0_0_1px_rgba(104,207,203,0.18)]' : 'border-white/15 bg-white/[0.04] text-white/75'} ${disabled ? 'pointer-events-none opacity-40' : 'cursor-pointer hover:border-[#68cfcb]/70 hover:bg-[#285451] hover:text-white hover:shadow-[0_0_0_1px_rgba(104,207,203,0.18)] active:translate-y-px active:bg-[#36736e]'} ${className}`}
      >
        <span className="inline-flex shrink-0 items-center justify-center" aria-hidden="true">{icon}</span>
        {showLabel ? <span className="min-w-0 whitespace-normal leading-tight">{label}</span> : null}
        {active ? <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-r bg-[#95ebe0]" /> : null}
      </button>
    </span>
  );
});
