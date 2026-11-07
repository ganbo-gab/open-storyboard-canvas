import { Fragment, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';
import { UiIconButton } from '@/components/ui';

export interface StageRailTool {
  key: string;
  label: string;
  description?: string;
  /** Shortcut shown on the button corner and in the tooltip. */
  keys?: string;
  icon: LucideIcon;
  active?: boolean;
  /** The tool's flyout panel is open. */
  open?: boolean;
  /** The tool opens a flyout instead of switching a mode. */
  menu?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onClick: () => void;
}

/**
 * Vertical tool rail on the viewport's left edge. Tools keep their place across
 * Director and Previs so muscle memory carries over; the open flyout is drawn
 * beside the button that opened it.
 */
export function StageToolRail({ groups, footer, openKey, panel, label }: {
  groups: StageRailTool[][];
  footer?: StageRailTool[];
  openKey: string | null;
  panel: ReactNode;
  label: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [panelTop, setPanelTop] = useState(0);

  // Beside the opening button when it fits; otherwise slide up until the whole card shows.
  const placePanel = useCallback(() => {
    const button = openKey ? buttonRefs.current.get(openKey) : null;
    const scroller = scrollRef.current;
    const container = containerRef.current;
    if (!button || !scroller || !container) return;
    const anchor = Math.max(0, button.offsetTop - scroller.scrollTop - 6);
    const card = panelRef.current?.firstElementChild;
    const body = card?.querySelector<HTMLElement>('[data-flyout-body]');
    const natural = card instanceof HTMLElement && body ? card.offsetHeight - body.clientHeight + body.scrollHeight : 0;
    setPanelTop(Math.max(0, Math.min(anchor, container.clientHeight - natural)));
  }, [openKey]);

  useLayoutEffect(() => {
    if (!openKey) return undefined;
    placePanel();
    const container = containerRef.current;
    const content = panelRef.current?.querySelector('[data-flyout-content]');
    const observer = new ResizeObserver(placePanel);
    if (container) observer.observe(container);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [openKey, placePanel]);

  // Short viewports scroll the rail; fade the clipped edge so hidden tools are discoverable.
  const [overflow, setOverflow] = useState({ above: false, below: false });
  const measureOverflow = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const above = scroller.scrollTop > 1;
    const below = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
    setOverflow((current) => current.above === above && current.below === below ? current : { above, below });
  }, []);
  useLayoutEffect(() => {
    measureOverflow();
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [measureOverflow]);

  const renderTool = (tool: StageRailTool) => {
    const tooltip = tool.disabled && tool.disabledReason
      ? `${tool.label} · ${tool.disabledReason}`
      : tool.description ? `${tool.label} · ${tool.description}` : tool.label;
    return (
      <button
        key={tool.key}
        ref={(node) => {
          if (node) buttonRefs.current.set(tool.key, node);
          else buttonRefs.current.delete(tool.key);
        }}
        type="button"
        className="stage-tool"
        aria-label={tool.label}
        aria-pressed={tool.menu ? undefined : Boolean(tool.active)}
        aria-expanded={tool.menu ? Boolean(tool.open) : undefined}
        aria-disabled={tool.disabled || undefined}
        data-active={tool.active || undefined}
        data-open={tool.open || undefined}
        data-menu={tool.menu || undefined}
        data-director-tooltip={tooltip}
        data-director-tooltip-keys={tool.keys}
        data-director-tooltip-side="right"
        onClick={() => {
          if (!tool.disabled) tool.onClick();
        }}
      >
        <tool.icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
        {tool.keys && tool.keys.length <= 2 ? <span className="stage-tool-key">{tool.keys}</span> : null}
      </button>
    );
  };

  return (
    <div ref={containerRef} className="pointer-events-none absolute bottom-3 left-3 top-3 z-30 flex items-start">
      <nav
        ref={scrollRef}
        aria-label={label}
        className="stage-glass stage-rail pointer-events-auto max-h-full overflow-y-auto [scrollbar-width:none]"
        data-more-above={overflow.above ? '' : undefined}
        data-more-below={overflow.below ? '' : undefined}
        onScroll={() => { placePanel(); measureOverflow(); }}
      >
        {groups.map((group, index) => (
          <Fragment key={group.map((tool) => tool.key).join('|')}>
            {index > 0 ? <div className="stage-rail-sep" role="separator" /> : null}
            {group.map(renderTool)}
          </Fragment>
        ))}
        {footer?.length ? (
          <>
            <div className="stage-rail-sep" role="separator" />
            {footer.map(renderTool)}
          </>
        ) : null}
      </nav>
      {openKey && panel ? (
        <div ref={panelRef} className="pointer-events-auto relative ml-2 flex min-h-0 flex-col" style={{ marginTop: panelTop, maxHeight: `calc(100% - ${panelTop}px)` }}>
          {panel}
        </div>
      ) : null}
    </div>
  );
}

/** Rail flyout: glass card with a title row and a scrolling body. */
export function StageFlyout({ title, closeLabel, onClose, width = 288, children }: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  width?: number;
  children: ReactNode;
}) {
  return (
    <section className="stage-glass stage-pop flex min-h-0 flex-col overflow-hidden rounded-2xl" style={{ width }} aria-label={title}>
      <header className="flex h-11 shrink-0 items-center justify-between pl-4 pr-2">
        <h3 className="text-[13px] font-semibold text-text-dark">{title}</h3>
        <UiIconButton size="sm" aria-label={closeLabel} onClick={onClose}><X className="h-3.5 w-3.5" /></UiIconButton>
      </header>
      <div data-flyout-body className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-4"><div data-flyout-content>{children}</div></div>
    </section>
  );
}
