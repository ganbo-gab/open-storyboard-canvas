import {
  Children,
  forwardRef,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';
import {
  UI_CONTENT_OVERLAY_INSET_CLASS,
  UI_DIALOG_TRANSITION_MS,
  UI_POPOVER_TRANSITION_MS,
} from './motion';
import { useDialogTransition } from './useDialogTransition';

type ButtonVariant = 'primary' | 'muted' | 'ghost';

type ButtonSize = 'sm' | 'md';

interface UiButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

interface UiIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

interface UiChipButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

interface UiCheckboxProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

interface UiSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {}

interface UiSelectOption {
  value: string;
  label: ReactNode;
  disabled: boolean;
}

interface UiModalProps {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  widthClassName?: string;
  containerClassName?: string;
}

function stopWheelPropagation(event: ReactWheelEvent<HTMLElement>) {
  event.stopPropagation();
}

function resolveButtonVariant(variant: ButtonVariant): string {
  if (variant === 'primary') {
    return 'bg-accent text-white hover:bg-accent/85';
  }

  if (variant === 'ghost') {
    return 'bg-transparent text-text-dark hover:bg-[rgba(15,23,42,0.08)] dark:hover:bg-bg-dark/70';
  }

  return 'bg-[rgba(15,23,42,0.08)] text-text-dark hover:bg-[rgba(15,23,42,0.14)] dark:bg-bg-dark/80 dark:hover:bg-bg-dark';
}

function resolveButtonSize(size: ButtonSize): string {
  return size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-3.5 text-sm';
}

export function UiButton({
  className = '',
  variant = 'muted',
  size = 'md',
  ...props
}: UiButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${resolveButtonVariant(variant)} ${resolveButtonSize(size)} ${className}`}
      {...props}
    />
  );
}

export function UiIconButton({ className = '', active = false, ...props }: UiIconButtonProps) {
  return (
    <button
      className={`inline-flex h-10 w-10 items-center justify-center border ui-field transition-colors ${active ? 'border-accent/45 bg-accent/18 text-text-dark' : 'text-text-muted hover:bg-[rgba(15,23,42,0.08)] dark:hover:bg-bg-dark'} ${className}`}
      {...props}
    />
  );
}

export const UiChipButton = forwardRef<HTMLButtonElement, UiChipButtonProps>(
  ({ className = '', active = false, ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex h-10 items-center gap-2 border ui-field px-3 text-sm transition-colors ${active ? 'border-accent/45 bg-accent/15 text-text-dark' : 'text-text-dark hover:bg-[rgba(15,23,42,0.08)] dark:hover:bg-bg-dark'} ${className}`}
      {...props}
    />
  )
);

UiChipButton.displayName = 'UiChipButton';

export function UiPanel({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`border ui-panel ${className}`}
      {...props}
    />
  );
}

export function UiTextArea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full resize-none border ui-field px-3 py-2.5 text-sm text-text-dark outline-none transition-colors placeholder:text-text-muted/70 focus:border-accent ${className}`}
      {...props}
    />
  );
}

export const UiTextAreaField = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = '', ...props }, ref) => (
    <textarea
      ref={ref}
      className={`w-full resize-none border ui-field px-3 py-2.5 text-sm text-text-dark outline-none transition-colors placeholder:text-text-muted/70 focus:border-accent ${className}`}
      {...props}
    />
  )
);

UiTextAreaField.displayName = 'UiTextAreaField';

export const UiInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...props }, ref) => (
    <input
      ref={ref}
      className={`w-full border ui-field px-3 py-2 text-sm text-text-dark outline-none transition-colors placeholder:text-text-muted/70 focus:border-accent ${className}`}
      {...props}
    />
  )
);

UiInput.displayName = 'UiInput';

export const UiCheckbox = forwardRef<HTMLButtonElement, UiCheckboxProps>(
  ({ className = '', checked, onCheckedChange, onClick, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={`inline-flex h-5 w-5 items-center justify-center rounded border transition-colors ${
        checked
          ? 'border-accent/60 bg-accent/20 text-accent'
          : 'border-[rgba(255,255,255,0.2)] bg-bg-dark/60 text-transparent hover:border-[rgba(255,255,255,0.32)]'
      } ${className}`}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onCheckedChange?.(!checked);
        }
      }}
      {...props}
    >
      <Check className="h-3.5 w-3.5" />
    </button>
  )
);

UiCheckbox.displayName = 'UiCheckbox';

export function UiSelect({ className = '', children, ...props }: UiSelectProps) {
  const {
    value,
    defaultValue,
    onChange,
    onBlur,
    onFocus,
    disabled,
    name,
    'aria-label': ariaLabel,
    ...selectProps
  } = props;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const hiddenSelectRef = useRef<HTMLSelectElement | null>(null);
  const listboxIdRef = useRef(`ui-select-${Math.random().toString(36).slice(2, 10)}`);
  const [isOpen, setIsOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{ left: number; top: number; width: number }>({
    left: 0,
    top: 0,
    width: 0,
  });
  const { shouldRender: shouldRenderMenu, isVisible: isMenuVisible } = useDialogTransition(
    isOpen,
    UI_POPOVER_TRANSITION_MS
  );
  const parsedOptions = useMemo<UiSelectOption[]>(() => {
    return Children.toArray(children).flatMap((child) => {
      if (!isValidElement(child) || child.type !== 'option') {
        return [];
      }

      const optionValue = child.props.value ?? child.props.children;
      return [
        {
          value: String(optionValue ?? ''),
          label: child.props.children,
          disabled: Boolean(child.props.disabled),
        },
      ];
    });
  }, [children]);
  const initialValue = useMemo(() => {
    if (value != null) {
      return String(value);
    }

    if (defaultValue != null) {
      return String(defaultValue);
    }

    return parsedOptions.find((option) => !option.disabled)?.value ?? '';
  }, [defaultValue, parsedOptions, value]);
  const [uncontrolledValue, setUncontrolledValue] = useState(initialValue);
  const isControlled = value != null;
  const selectedValue = isControlled ? String(value) : uncontrolledValue;
  const selectedOption =
    parsedOptions.find((option) => option.value === selectedValue) ??
    parsedOptions.find((option) => !option.disabled) ??
    null;

  useEffect(() => {
    if (!isControlled) {
      setUncontrolledValue(initialValue);
    }
  }, [initialValue, isControlled]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) {
        return;
      }

      const rect = trigger.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const estimatedMenuHeight = Math.min(Math.max(parsedOptions.length * 38 + 12, 60), 240);
      const openAbove = rect.bottom + 8 + estimatedMenuHeight > viewportHeight && rect.top > estimatedMenuHeight;
      setMenuStyle({
        left: rect.left,
        top: openAbove ? Math.max(8, rect.top - estimatedMenuHeight - 8) : rect.bottom + 8,
        width: rect.width,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, parsedOptions.length]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target ?? null)) {
        return;
      }

      const menuElement = document.getElementById(listboxIdRef.current);
      if (menuElement?.contains(target ?? null)) {
        return;
      }

      setIsOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const commitValue = (nextValue: string) => {
    if (!isControlled) {
      setUncontrolledValue(nextValue);
    }

    if (hiddenSelectRef.current) {
      hiddenSelectRef.current.value = nextValue;
    }

    onChange?.({
      target: { value: nextValue, name },
      currentTarget: { value: nextValue, name },
    } as ChangeEvent<HTMLSelectElement>);
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled || parsedOptions.length === 0) {
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setIsOpen((current) => !current);
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const enabledOptions = parsedOptions.filter((option) => !option.disabled);
      if (enabledOptions.length === 0) {
        return;
      }

      const currentIndex = enabledOptions.findIndex((option) => option.value === selectedValue);
      const fallbackIndex = event.key === 'ArrowDown' ? 0 : enabledOptions.length - 1;
      const nextIndex =
        currentIndex === -1
          ? fallbackIndex
          : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + enabledOptions.length) %
            enabledOptions.length;
      commitValue(enabledOptions[nextIndex].value);
      setIsOpen(false);
    }
  };

  return (
    <div className="relative">
      <select
        ref={hiddenSelectRef}
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
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxIdRef.current}
        disabled={disabled}
        className={`group inline-flex h-8 w-full items-center justify-between rounded-[6px] border border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-field)] px-3 text-left text-xs font-medium text-text-dark outline-none transition-[border-color,background-color,box-shadow,color] hover:border-[color:var(--ui-border-strong)] focus-visible:border-accent focus-visible:shadow-[0_0_0_2px_rgba(var(--accent-rgb),0.12)] disabled:cursor-not-allowed disabled:opacity-55 ${className}`}
        onClick={() => {
          if (!disabled && parsedOptions.length > 0) {
            setIsOpen((current) => !current);
          }
        }}
        onKeyDown={handleTriggerKeyDown}
        onBlur={(event) => onBlur?.(event as never)}
        onFocus={(event) => onFocus?.(event as never)}
      >
        <span className="min-w-0 truncate pr-3">{selectedOption?.label ?? ''}</span>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted transition-colors group-hover:text-text-dark group-focus-visible:text-accent">
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
            style={{ transitionDuration: `${UI_POPOVER_TRANSITION_MS}ms` }}
          />
        </span>
      </button>
      {shouldRenderMenu && typeof document !== 'undefined'
        ? createPortal(
            <div
              id={listboxIdRef.current}
              role="listbox"
              aria-label={ariaLabel}
              className={`nowheel fixed z-[140] overflow-hidden rounded-[6px] border border-[color:var(--ui-border-soft)] bg-[var(--ui-surface-panel)] p-1 shadow-[var(--ui-shadow-panel)] transition-[opacity,transform] ease-out ${
                isMenuVisible ? 'opacity-100 translate-y-0' : 'pointer-events-none opacity-0 -translate-y-1'
              }`}
              onWheelCapture={stopWheelPropagation}
              style={{
                left: menuStyle.left,
                top: menuStyle.top,
                width: menuStyle.width,
                maxHeight: 240,
                transitionDuration: `${UI_POPOVER_TRANSITION_MS}ms`,
              }}
            >
              <div className="ui-scrollbar nowheel max-h-[228px] overflow-y-auto" onWheelCapture={stopWheelPropagation}>
                {parsedOptions.map((option) => {
                  const isSelected = option.value === selectedValue;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      disabled={option.disabled}
                      className={`flex w-full items-center justify-between rounded-[4px] px-3 py-2 text-sm transition-colors ${
                        option.disabled
                          ? 'cursor-not-allowed opacity-40'
                          : isSelected
                            ? 'bg-accent text-white'
                            : 'text-text-dark hover:bg-[rgba(255,255,255,0.08)] dark:hover:bg-white/[0.06]'
                      }`}
                      onClick={() => {
                        if (option.disabled) {
                          return;
                        }
                        commitValue(option.value);
                        setIsOpen(false);
                        triggerRef.current?.focus();
                      }}
                    >
                      <span className="truncate">{option.label}</span>
                      {isSelected ? <Check className="ml-3 h-3.5 w-3.5 shrink-0 text-white" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

export function UiModal({
  isOpen,
  title,
  onClose,
  children,
  footer,
  widthClassName = 'w-[460px]',
  containerClassName = '',
}: UiModalProps) {
  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);

  if (!shouldRender) {
    return null;
  }

  return (
    <div
      className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-50 flex items-center justify-center ${containerClassName}`}
      onWheelCapture={(event) => event.stopPropagation()}
      onTouchMoveCapture={(event) => event.stopPropagation()}
    >
      <div
        className={`absolute inset-0 bg-black/55 transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <UiPanel
        className={`relative transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'} ${widthClassName}`}
      >
        <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.1)] px-4 py-3">
          <h2 className="text-sm font-medium text-text-dark">{title}</h2>
          <UiIconButton className="h-8 w-8" onClick={onClose}>
            <X className="h-4 w-4" />
          </UiIconButton>
        </div>

        <div className="px-4 py-4">{children}</div>

        {footer && (
          <div className="flex justify-end gap-2 border-t border-[rgba(255,255,255,0.1)] px-4 py-3">
            {footer}
          </div>
        )}
      </UiPanel>
    </div>
  );
}
