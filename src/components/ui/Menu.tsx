import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

const EDGE_INSET = 8;

export interface MenuAnchor {
  /** Client coordinates of the point the menu grows from. */
  x: number;
  y: number;
}

interface MenuSurfaceProps {
  anchor: MenuAnchor;
  onClose: () => void;
  width?: number;
  className?: string;
  /** Focus the first item (keyboard-opened menus) instead of keeping focus where it is. */
  autoFocusFirst?: boolean;
  label?: string;
  children: ReactNode;
}

/**
 * One menu surface for the whole app: 240 wide, 10px item radius, flips away from
 * viewport edges, closes on outside press / Esc, arrow-key navigable.
 */
export function MenuSurface({
  anchor,
  onClose,
  width = 240,
  className = '',
  autoFocusFirst = false,
  label,
  children,
}: MenuSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const { width: w, height: h } = element.getBoundingClientRect();
    const maxLeft = window.innerWidth - EDGE_INSET - w;
    const maxTop = window.innerHeight - EDGE_INSET - h;
    const left = anchor.x + w > window.innerWidth - EDGE_INSET ? anchor.x - w : anchor.x;
    const top = anchor.y + h > window.innerHeight - EDGE_INSET ? anchor.y - h : anchor.y;
    setPosition({
      left: Math.max(EDGE_INSET, Math.min(left, maxLeft)),
      top: Math.max(EDGE_INSET, Math.min(top, maxTop)),
    });
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    if (autoFocusFirst) {
      surfaceRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    }
  }, [autoFocusFirst]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (surfaceRef.current?.contains(event.target as Node)) return;
      onCloseRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    const handleBlur = () => onCloseRef.current();
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(
      surfaceRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  };

  return createPortal(
    <div
      ref={surfaceRef}
      role="menu"
      aria-label={label}
      data-canvas-overlay=""
      className={`ui-menu ${className}`}
      style={{
        width,
        left: position?.left ?? anchor.x,
        top: position?.top ?? anchor.y,
        visibility: position ? 'visible' : 'hidden',
      }}
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>,
    document.body
  );
}

interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  shortcut?: string;
  tone?: 'default' | 'danger';
  trailing?: ReactNode;
}

export function MenuItem({
  icon,
  label,
  hint,
  shortcut,
  tone = 'default',
  trailing,
  disabled,
  className = '',
  ...props
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      disabled={disabled}
      data-tone={tone}
      className={`ui-menu__item ${className}`}
      {...props}
    >
      {icon ? <span className="ui-menu__icon">{icon}</span> : null}
      <span className="ui-menu__label">
        <span className="truncate">{label}</span>
        {hint ? <span className="ui-menu__hint">{hint}</span> : null}
      </span>
      {trailing}
      {shortcut ? <kbd className="ui-menu__shortcut">{shortcut}</kbd> : null}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="ui-menu__group">{children}</div>;
}

export function MenuSeparator() {
  return <div role="separator" className="ui-menu__separator" />;
}
