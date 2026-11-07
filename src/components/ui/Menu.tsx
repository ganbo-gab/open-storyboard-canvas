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
import { announceFloatingSurface, FLOATING_SURFACE_OPEN, MODAL_SURFACE_OPEN, isFloatingSurfaceEvent } from './floatingSurfaces';

const EDGE_INSET = 8;

export interface MenuAnchor {
  /** Client coordinates of the point the menu grows from. */
  x: number;
  y: number;
  /** `above`: the menu's bottom sits at `y`; falls back to `flipY` (below the trigger) when there is no room. */
  placement?: 'below' | 'above';
  flipY?: number;
  /** The live trigger keeps placement and repeated-click dismissal tied to the same control. */
  trigger?: Element;
  triggerRect?: { left: number; top: number; bottom: number };
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

/** Place a floating surface at `anchor`, flipping away from viewport edges. */
function useAnchoredPosition(anchor: MenuAnchor, onClose: () => void) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const place = () => {
    if (anchor.trigger && !anchor.trigger.isConnected) { closeRef.current(); return; }
    const rect = anchor.trigger?.getBoundingClientRect();
    const dx = rect && anchor.triggerRect ? rect.left - anchor.triggerRect.left : 0;
    const dy = rect && anchor.triggerRect ? rect.top - anchor.triggerRect.top : 0;
    const x = anchor.x + dx, y = anchor.y + dy;
    const flipY = anchor.flipY === undefined ? undefined : anchor.flipY + (rect && anchor.triggerRect ? rect.bottom - anchor.triggerRect.bottom : 0);
    // Layout size is stable while the entry animation scales the painted surface.
    const w = element.offsetWidth;
    const h = element.offsetHeight;
    const maxLeft = window.innerWidth - EDGE_INSET - w;
    const maxTop = window.innerHeight - EDGE_INSET - h;
    const left = Math.min(x, maxLeft);
    const top = anchor.placement === 'above'
      ? (y - h >= EDGE_INSET ? y - h : flipY ?? y)
      : (y + h > window.innerHeight - EDGE_INSET ? y - h : y);
    const next = { left: Math.max(EDGE_INSET, Math.min(left, maxLeft)), top: Math.max(EDGE_INSET, Math.min(top, maxTop)) };
    setPosition((previous) => previous?.left === next.left && previous.top === next.top ? previous : next);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    if (anchor.trigger) observer.observe(anchor.trigger);
    // Transforms (canvas pan/zoom/node drag) do not trigger ResizeObserver or scroll events.
    // Only the open surface tracks its trigger; canvas nodes need no new subscriptions.
    let frame = 0;
    const follow = () => { place(); frame = requestAnimationFrame(follow); };
    if (anchor.trigger) frame = requestAnimationFrame(follow);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor.x, anchor.y, anchor.placement, anchor.flipY, anchor.trigger, anchor.triggerRect]);
  return { surfaceRef, position };
}

/** Close on outside press, Escape (captured, so the canvas never sees it) and window blur. */
function useDismiss(surfaceRef: { current: HTMLElement | null }, onClose: () => void, trigger?: Element) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface) announceFloatingSurface(surface, trigger ?? document.activeElement);
    const handlePointerDown = (event: PointerEvent) => {
      if (surfaceRef.current?.contains(event.target as Node)) return;
      // Let the trigger's click handler toggle the open state once. Closing on pointerdown
      // first would make that same click reopen it, especially in native WebKit.
      if (trigger?.contains(event.target as Node)) return;
      const owner = trigger?.closest('[data-node-overlay-owner]')?.getAttribute('data-node-overlay-owner');
      if (owner && event.target instanceof Element && event.target.closest('.react-flow__node')?.getAttribute('data-id') === owner) return;
      if (event.target instanceof Element && event.target.closest('.ui-menu')) return;
      onCloseRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (Array.from(document.querySelectorAll('.ui-menu')).at(-1) !== surfaceRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    const handleBlur = () => onCloseRef.current();
    const opened = (event: Event) => {
      if (!isFloatingSurfaceEvent(event) || event.detail.surface === surface) return;
      if (event.detail.trigger && surface?.contains(event.detail.trigger)) return;
      onCloseRef.current();
    };
    document.addEventListener(FLOATING_SURFACE_OPEN, opened);
    document.addEventListener(MODAL_SURFACE_OPEN, handleBlur);
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener(FLOATING_SURFACE_OPEN, opened);
      document.removeEventListener(MODAL_SURFACE_OPEN, handleBlur);
    };
  }, [surfaceRef, trigger]);
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
  const { surfaceRef, position } = useAnchoredPosition(anchor, onClose);
  useDismiss(surfaceRef, onClose, anchor.trigger);

  useEffect(() => {
    if (autoFocusFirst) {
      surfaceRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    }
  }, [autoFocusFirst, surfaceRef]);

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

/** Anchored panel for richer content than a menu (parameter grids, forms). Same placement and dismissal. */
export function PopoverSurface({
  anchor,
  onClose,
  width = 300,
  className = '',
  label,
  children,
}: Omit<MenuSurfaceProps, 'autoFocusFirst'>) {
  const { surfaceRef, position } = useAnchoredPosition(anchor, onClose);
  useDismiss(surfaceRef, onClose, anchor.trigger);
  return createPortal(
    <div
      ref={surfaceRef}
      role="dialog"
      aria-label={label}
      data-canvas-overlay=""
      className={`ui-menu ui-popover nowheel ${className}`}
      style={{
        width,
        left: position?.left ?? anchor.x,
        top: position?.top ?? anchor.y,
        visibility: position ? 'visible' : 'hidden',
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>,
    document.body
  );
}

/** Anchor a menu to a trigger: it opens upward from the trigger's top-left (composer chips sit low). */
export function anchorAbove(element: Element): MenuAnchor {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top - 6, placement: 'above', flipY: rect.bottom + 6, trigger: element, triggerRect: rect };
}

/** Preserve a custom placement while following its actual trigger. */
export function anchorToElement(element: Element, anchor: MenuAnchor): MenuAnchor {
  return { ...anchor, trigger: element, triggerRect: element.getBoundingClientRect() };
}

export function anchorBelow(element: Element): MenuAnchor {
  const rect = element.getBoundingClientRect();
  return anchorToElement(element, { x: rect.left, y: rect.bottom + 6 });
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
