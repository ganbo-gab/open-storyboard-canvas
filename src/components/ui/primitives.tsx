import { PanelResizeHandle } from './PanelResizeHandle';
import { announceFloatingSurface, FLOATING_SURFACE_OPEN, isFloatingSurfaceEvent, MODAL_SURFACE_OPEN } from './floatingSurfaces';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AriaAttributes,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type CSSProperties,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type OptionHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UI_CONTENT_OVERLAY_INSET_CLASS, UI_DIALOG_TRANSITION_MS } from './motion';
import { useDialogTransition } from './useDialogTransition';
import { useModalFocus } from './useModalFocus';

/*
 * The app's control kit. Look and states live in index.css (`.ui-btn`, `.ui-input`, …) keyed by
 * data attributes, so every surface — settings, canvas nodes, stage, agents — shares one design.
 */

export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger' | 'destructive';
export type ControlSize = 'sm' | 'md' | 'lg';

interface UiButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ControlSize;
  icon?: ReactNode;
  loading?: boolean;
}

export const UiButton = forwardRef<HTMLButtonElement, UiButtonProps>(
  ({ className = '', variant = 'secondary', size = 'md', icon, loading = false, children, disabled, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={`ui-btn ${className}`}
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <span className="ui-spinner" aria-hidden /> : icon}
      {children}
    </button>
  ),
);
UiButton.displayName = 'UiButton';

interface UiIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  size?: ControlSize;
  variant?: 'ghost' | 'secondary';
}

/** Square icon button. Always pass `aria-label`; it doubles as the tooltip text. */
export const UiIconButton = forwardRef<HTMLButtonElement, UiIconButtonProps>(
  ({ className = '', active = false, size = 'md', variant = 'ghost', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={`ui-icon-btn ${className}`}
      data-size={size}
      data-variant={variant}
      data-active={active || undefined}
      aria-pressed={active || undefined}
      {...props}
    />
  ),
);
UiIconButton.displayName = 'UiIconButton';

interface UiChipButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

/** Toggleable pill: filters, parameter chips, quick choices. */
export const UiChipButton = forwardRef<HTMLButtonElement, UiChipButtonProps>(
  ({ className = '', active = false, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={`ui-chip ${className}`}
      data-active={active || undefined}
      {...props}
    />
  ),
);
UiChipButton.displayName = 'UiChipButton';

export const UiPanel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className = '', ...props }, ref) => <div ref={ref} className={`ui-panel ${className}`} {...props} />,
);
UiPanel.displayName = 'UiPanel';

export const UiTextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = '', ...props }, ref) => <textarea ref={ref} className={`ui-input ui-textarea ${className}`} {...props} />,
);
UiTextArea.displayName = 'UiTextArea';

export const UiInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...props }, ref) => <input ref={ref} className={`ui-input ${className}`} {...props} />,
);
UiInput.displayName = 'UiInput';

interface UiCheckboxProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const UiCheckbox = forwardRef<HTMLButtonElement, UiCheckboxProps>(
  ({ className = '', checked, onCheckedChange, onClick, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={`ui-checkbox ${className}`}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange?.(!checked);
      }}
      {...props}
    >
      <Check strokeWidth={3} />
    </button>
  ),
);
UiCheckbox.displayName = 'UiCheckbox';

interface UiSwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export const UiSwitch = forwardRef<HTMLButtonElement, UiSwitchProps>(
  ({ className = '', checked, onCheckedChange, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      className={`ui-switch ${className}`}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    >
      <span className="ui-switch__thumb" />
    </button>
  ),
);
UiSwitch.displayName = 'UiSwitch';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** Per-option attributes for the rendered button (aria-label, title, data-*); selection semantics stay owned here. */
  buttonProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role' | 'aria-checked' | 'disabled' | 'onClick' | 'children'>
    & { [attribute: `data-${string}`]: string | undefined };
}

/**
 * Tracks the active child's box inside `container` and exposes it as `--seg-x`/`--seg-w`, so a
 * single indicator element can slide between options with a CSS transition (no per-item paint).
 */
function useActiveIndicator(container: { current: HTMLElement | null }, selector: string, key: unknown) {
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const measure = () => {
      const active = root.querySelector<HTMLElement>(selector);
      setBox(active ? { x: active.offsetLeft, w: active.offsetWidth } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [container, selector, key]);
  return box
    ? ({ '--seg-x': `${box.x}px`, '--seg-w': `${box.w}px` } as CSSProperties)
    : undefined;
}

/** Mutually exclusive choice among 2–5 short options (mode, ratio, view). */
export function UiSegmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  className = '',
  'aria-label': ariaLabel,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  size?: ControlSize;
  className?: string;
  'aria-label'?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const indicator = useActiveIndicator(group, '[aria-checked="true"]', `${value}|${options.length}`);
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={ariaLabel}
      className={`ui-segmented ${className}`}
      data-size={size}
      data-indicator={indicator ? '' : undefined}
      style={indicator}
    >
      <span className="ui-segmented__indicator" aria-hidden />
      {options.map((option) => (
        <button
          key={option.value}
          {...option.buttonProps}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={option.disabled}
          className={`ui-segmented__item ${option.buttonProps?.className ?? ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Section switcher for a panel (underline tabs). Content is rendered by the caller. */
export function UiTabs<T extends string>({
  value,
  options,
  onChange,
  className = '',
  'aria-label': ariaLabel,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  'aria-label'?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const indicator = useActiveIndicator(list, '[aria-selected="true"]', `${value}|${options.length}`);
  const move = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const enabled = options.filter((option) => !option.disabled);
    const index = enabled.findIndex((option) => option.value === value);
    const next = enabled[(index + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
    if (!next) return;
    event.preventDefault();
    onChange(next.value);
    list.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };
  return (
    <div ref={list} role="tablist" aria-label={ariaLabel} className={`ui-tabs ${className}`} style={indicator} onKeyDown={move}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          data-value={option.value}
          aria-selected={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          disabled={option.disabled}
          className="ui-tabs__item"
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
      {indicator && <span className="ui-tabs__indicator" aria-hidden />}
    </div>
  );
}

interface UiSliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'min' | 'max' | 'step'> {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  /** Shows the current value after the track; pass a formatter for units. */
  format?: (value: number) => ReactNode;
}

/** Range input with a filled track; the fill follows the value through `--fill`. */
export function UiSlider({ value, min = 0, max = 100, step = 1, onChange, format, className = '', style, ...props }: UiSliderProps) {
  const fill = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;
  return (
    <div className={`ui-slider ${className}`}>
      <input
        type="range"
        className="ui-range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ...style, '--fill': `${fill}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
        {...props}
      />
      {format && <span className="ui-slider__value">{format(value)}</span>}
    </div>
  );
}

export function UiBadge({
  tone = 'neutral',
  className = '',
  children,
}: {
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  className?: string;
  children: ReactNode;
}) {
  return <span className={`ui-badge ${className}`} data-tone={tone}>{children}</span>;
}

interface FieldControlProps extends Pick<AriaAttributes, 'aria-describedby' | 'aria-invalid'> {
  id?: string;
}

/** Label + control + hint/error, the one layout for every form row. */
export function UiField({
  label,
  hint,
  error,
  htmlFor,
  trailing,
  className = '',
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  trailing?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const generatedId = useId();
  const control = isValidElement<FieldControlProps>(children)
    && (children.type === UiInput || children.type === UiTextArea || children.type === UiSelect
      || children.type === 'input' || children.type === 'textarea' || children.type === 'select')
    ? children : null;
  const controlId = htmlFor ?? control?.props.id ?? generatedId;
  const detailId = hint || error ? `${generatedId}-description` : undefined;
  const content = control ? cloneElement(control, {
    id: controlId,
    'aria-describedby': [control.props['aria-describedby'], detailId].filter(Boolean).join(' ') || undefined,
    'aria-invalid': error ? true : control.props['aria-invalid'],
  }) : children;
  return (
    <div className={`ui-field-row ${className}`}>
      <div className="ui-field-row__head">
        <label htmlFor={control ? controlId : htmlFor} className="ui-field-row__label">{label}</label>
        {trailing}
      </div>
      {content}
      {error ? <p id={detailId} className="ui-field-row__error">{error}</p> : hint ? <p id={detailId} className="ui-field-row__hint">{hint}</p> : null}
    </div>
  );
}

interface UiSelectOption {
  value: string;
  label: ReactNode;
  disabled: boolean;
}

const SELECT_MENU_MAX_HEIGHT = 280;

/** Drop-in for `<select>`: same `<option>` children and onChange event, rendered as a popover listbox. */
export function UiSelect({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const { value, defaultValue, onChange, onBlur, onFocus, disabled, name, 'aria-label': ariaLabel, ...restProps } = props;
  // The visible trigger is the focusable control, so identity/description metadata belongs on it;
  // form-only attributes (required, form, …) stay on the hidden native select.
  const triggerProps: Record<string, unknown> = {};
  const selectProps: Record<string, unknown> = {};
  for (const [key, attribute] of Object.entries(restProps)) {
    const target = key === 'id' || key === 'title' || key.startsWith('data-') || key.startsWith('aria-') ? triggerProps : selectProps;
    target[key] = attribute;
  }
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState({ left: 0, top: 0, width: 0, above: false });
  const options = useMemo<UiSelectOption[]>(
    () => Children.toArray(children).flatMap((child) => {
      if (!isValidElement<OptionHTMLAttributes<HTMLOptionElement>>(child) || child.type !== 'option') return [];
      return [{
        value: String(child.props.value ?? child.props.children ?? ''),
        label: child.props.children,
        disabled: Boolean(child.props.disabled),
      }];
    }),
    [children],
  );
  const initialValue = value != null
    ? String(value)
    : defaultValue != null
      ? String(defaultValue)
      : options.find((option) => !option.disabled)?.value ?? '';
  const [uncontrolledValue, setUncontrolledValue] = useState(initialValue);
  const isControlled = value != null;
  const selectedValue = isControlled ? String(value) : uncontrolledValue;
  const selectedOption = options.find((option) => option.value === selectedValue)
    ?? options.find((option) => !option.disabled)
    ?? null;

  useEffect(() => {
    if (!isOpen) return;
    if (listRef.current) announceFloatingSurface(listRef.current, triggerRef.current);
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const height = listRef.current?.offsetHeight || Math.min(options.length * 34 + 12, SELECT_MENU_MAX_HEIGHT);
      const above = rect.bottom + 6 + height > window.innerHeight && rect.top > height;
      const next = { left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)), top: Math.max(8, above ? rect.top - height - 6 : Math.min(rect.bottom + 6, window.innerHeight - height - 8)), width: rect.width, above };
      setMenuStyle(previous => previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.above === next.above ? previous : next);
    };
    place();
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      const owner = triggerRef.current?.closest('[data-node-overlay-owner]')?.getAttribute('data-node-overlay-owner');
      if (owner && event.target instanceof Element && event.target.closest('.react-flow__node')?.getAttribute('data-id') === owner) return;
      if (!triggerRef.current?.contains(target) && !listRef.current?.contains(target)) setIsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (Array.from(document.querySelectorAll('.ui-menu')).at(-1) !== listRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    const opened = (event: Event) => {
      if (!isFloatingSurfaceEvent(event) || event.detail.surface === listRef.current || (event.detail.trigger && listRef.current?.contains(event.detail.trigger))) return;
      setIsOpen(false);
    };
    const blur = () => setIsOpen(false);
    let frame = 0;
    const follow = () => { if (!triggerRef.current?.isConnected) { setIsOpen(false); return; } place(); frame = requestAnimationFrame(follow); };
    frame = requestAnimationFrame(follow);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', escape, true);
    document.addEventListener(FLOATING_SURFACE_OPEN, opened);
    document.addEventListener(MODAL_SURFACE_OPEN, blur);
    window.addEventListener('blur', blur);
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener(FLOATING_SURFACE_OPEN, opened);
      document.removeEventListener(MODAL_SURFACE_OPEN, blur);
      window.removeEventListener('blur', blur);
      cancelAnimationFrame(frame);
    };
  }, [isOpen, options.length]);

  const commit = (next: string) => {
    if (!isControlled) setUncontrolledValue(next);
    onChange?.({ target: { value: next, name }, currentTarget: { value: next, name } } as ChangeEvent<HTMLSelectElement>);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled || options.length === 0) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setIsOpen((open) => !open);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const enabled = options.filter((option) => !option.disabled);
    if (enabled.length === 0) return;
    const index = enabled.findIndex((option) => option.value === selectedValue);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = index === -1 ? (step > 0 ? 0 : enabled.length - 1) : (index + step + enabled.length) % enabled.length;
    commit(enabled[next].value);
  };

  return (
    <div className="relative min-w-0">
      <select
        tabIndex={-1}
        aria-hidden="true"
        value={selectedValue}
        name={name}
        disabled={disabled}
        className="pointer-events-none absolute inset-0 opacity-0"
        onChange={() => undefined}
        {...selectProps}
      >
        {children}
      </select>
      <button
        {...triggerProps}
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        disabled={disabled}
        className={`ui-input ui-select ${className}`}
        onClick={() => !disabled && options.length > 0 && setIsOpen((open) => !open)}
        onKeyDown={handleKeyDown}
        onBlur={(event) => onBlur?.(event as never)}
        onFocus={(event) => onFocus?.(event as never)}
      >
        <span className="min-w-0 flex-1 truncate text-left">{selectedOption?.label ?? ''}</span>
        <ChevronDown className="ui-select__chevron" data-open={isOpen || undefined} />
      </button>
      {isOpen && createPortal(
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className={`ui-menu nowheel${triggerRef.current?.closest('.dark') ? ' dark' : ''}`}
          data-placement={menuStyle.above ? 'top' : 'bottom'}
          style={{ left: menuStyle.left, top: menuStyle.top, minWidth: menuStyle.width, maxHeight: SELECT_MENU_MAX_HEIGHT }}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          {options.map((option) => {
            const selected = option.value === selectedValue;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={option.disabled}
                className="ui-menu__item"
                onClick={() => {
                  commit(option.value);
                  setIsOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <span className="ui-menu__label truncate">{option.label}</span>
                {selected ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" /> : null}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

interface UiModalProps {
  isOpen: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  widthClassName?: string;
  containerClassName?: string;
  resizable?: boolean;
}

export function UiModal({
  isOpen,
  title,
  description,
  onClose,
  children,
  footer,
  widthClassName = 'w-[480px]',
  containerClassName = '',
  resizable = true,
}: UiModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const savedSize = useSettingsStore((state) => state.workspacePreferences?.panelSizes[`modal:${title}`]);
  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);
  const { dialogRef, onKeyDown } = useModalFocus({ isOpen: isOpen && shouldRender, onClose });
  useEffect(() => { if (isOpen) document.dispatchEvent(new Event(MODAL_SURFACE_OPEN)); }, [isOpen]);

  if (!shouldRender || typeof document === 'undefined') return null;

  return createPortal(
    <div
      data-ui-modal="true"
      className={`ui-modal-layer nokey nodrag nopan fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} flex items-center justify-center p-6 ${containerClassName}`}
      // React portals retain their component ancestry. Dialog controls must not select,
      // drag or keyboard-move the canvas node that opened this independent surface.
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onFocus={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onWheelCapture={(event) => event.stopPropagation()}
      onTouchMoveCapture={(event) => event.stopPropagation()}
    >
      <div className="ui-scrim" data-visible={isVisible || undefined} onClick={onClose} />
      <UiPanel
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={resizable && savedSize ? { width: savedSize.width, height: savedSize.height, maxWidth: 'calc(100vw - 48px)' } : undefined}
        onKeyDown={onKeyDown}
        data-visible={isVisible || undefined}
        className={`ui-dialog relative flex max-h-[calc(100dvh-4rem)] max-w-full flex-col overflow-hidden ${widthClassName}`}
      >
        <header className="flex shrink-0 items-start gap-3 px-5 pb-3 pt-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[15px] font-semibold text-text">{title}</h2>
            {description ? <p className="mt-1 text-[13px] leading-5 text-text-muted">{description}</p> : null}
          </div>
          <UiIconButton size="sm" className="-mr-1.5 -mt-0.5" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
            <X />
          </UiIconButton>
        </header>
        <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
        {footer ? <footer className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer> : null}
        {resizable && <PanelResizeHandle panelRef={dialogRef} storageKey={`modal:${title}`} />}
      </UiPanel>
    </div>,
    document.body,
  );
}
