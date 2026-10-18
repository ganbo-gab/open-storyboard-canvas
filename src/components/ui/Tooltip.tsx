import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Side = 'right' | 'top' | 'bottom' | 'left';

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
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const show = () => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (triggerRef.current) setAnchor(triggerRef.current.getBoundingClientRect());
    }, delay);
  };
  const hide = () => {
    window.clearTimeout(timerRef.current);
    setAnchor(null);
  };

  let style: React.CSSProperties | undefined;
  if (anchor) {
    if (side === 'right') style = { left: anchor.right + GAP, top: anchor.top + anchor.height / 2, transform: 'translateY(-50%)' };
    if (side === 'left') style = { right: window.innerWidth - anchor.left + GAP, top: anchor.top + anchor.height / 2, transform: 'translateY(-50%)' };
    if (side === 'top') style = { left: anchor.left + anchor.width / 2, bottom: window.innerHeight - anchor.top + GAP, transform: 'translateX(-50%)' };
    if (side === 'bottom') style = { left: anchor.left + anchor.width / 2, top: anchor.bottom + GAP, transform: 'translateX(-50%)' };
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
