import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FLOATING_SURFACE_OPEN, MODAL_SURFACE_OPEN } from './floatingSurfaces';

/** `bottom-end`: below, right edges aligned (triggers at the window's right edge). */
type Side = 'right' | 'top' | 'bottom' | 'bottom-end' | 'left';

interface TooltipProps {
  label: ReactNode;
  shortcut?: string;
  side?: Side;
  /** ms before showing; spec: 600 for chrome buttons. */
  delay?: number;
  className?: string;
  children: ReactNode;
}

const GAP = 8;

/** Name + shortcut on hover/focus, positioned beside the trigger, never clipped. */
export function Tooltip({ label, shortcut, side = 'right', delay = 600, className = '', children }: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const stopTrackingRef = useRef<(() => void) | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const stopTracking = useCallback(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    const stop = stopTrackingRef.current;
    stopTrackingRef.current = null;
    stop?.();
  }, []);
  useEffect(() => stopTracking, [stopTracking]);
  const hide = useCallback(() => {
    stopTracking();
    setAnchor(null);
  }, [stopTracking]);

  const show = () => {
    window.clearTimeout(timerRef.current);
    if (!stopTrackingRef.current) {
      // Install while the delay is pending, before a focus handler's following click
      // can open a menu. Idle tooltips register no global listeners.
      document.addEventListener(FLOATING_SURFACE_OPEN, hide);
      document.addEventListener(MODAL_SURFACE_OPEN, hide);
      window.addEventListener('pointerdown', hide, true);
      window.addEventListener('resize', hide);
      window.addEventListener('wheel', hide, { capture: true, passive: true });
      window.addEventListener('scroll', hide, true);
      stopTrackingRef.current = () => {
        document.removeEventListener(FLOATING_SURFACE_OPEN, hide);
        document.removeEventListener(MODAL_SURFACE_OPEN, hide);
        window.removeEventListener('pointerdown', hide, true);
        window.removeEventListener('resize', hide);
        window.removeEventListener('wheel', hide, true);
        window.removeEventListener('scroll', hide, true);
      };
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      if (triggerRef.current?.isConnected) setAnchor(triggerRef.current.getBoundingClientRect());
      else stopTracking();
    }, delay);
  };

  let style: React.CSSProperties | undefined;
  if (anchor) {
    if (side === 'right') style = { left: anchor.right + GAP, top: anchor.top + anchor.height / 2, transform: 'translateY(-50%)' };
    if (side === 'left') style = { right: window.innerWidth - anchor.left + GAP, top: anchor.top + anchor.height / 2, transform: 'translateY(-50%)' };
    if (side === 'top') style = { left: anchor.left + anchor.width / 2, bottom: window.innerHeight - anchor.top + GAP, transform: 'translateX(-50%)' };
    if (side === 'bottom') style = { left: anchor.left + anchor.width / 2, top: anchor.bottom + GAP, transform: 'translateX(-50%)' };
    if (side === 'bottom-end') style = { right: window.innerWidth - anchor.right, top: anchor.bottom + GAP };
  }

  return (
    <span
      ref={triggerRef}
      className={`inline-flex ${className}`}
      onPointerEnter={show}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {anchor && style
        ? createPortal(
          <span role="tooltip" className="ui-tooltip" style={style}>
            {label}
            {shortcut ? <kbd className="ui-kbd">{shortcut}</kbd> : null}
          </span>,
          document.body
        )
        : null}
    </span>
  );
}
