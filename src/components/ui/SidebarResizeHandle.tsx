import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';

/** Keep pointer moves local to the box; persist once on release, not on every frame. */
export function useSidebarWidth(key: string, defaultWidth: number, min = 180, max = 480, contentMin = 420) {
  const ref = useRef<HTMLElement>(null);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const attach = useCallback((element: HTMLElement | null) => { ref.current = element; setPanel(element); }, []);
  const saved = useSettingsStore(state => state.workspacePreferences.sidebarWidths?.[key]);
  const clamp = (width: number) => Math.max(min, Math.min(max, (ref.current?.parentElement?.clientWidth || window.innerWidth) - contentMin, width));
  useLayoutEffect(() => {
    if (!panel) return;
    const apply = () => { panel.style.width = `${clamp(saved ?? defaultWidth)}px`; };
    apply();
    const observer = new ResizeObserver(apply);
    if (panel.parentElement) observer.observe(panel.parentElement);
    return () => observer.disconnect();
  }, [panel, saved, defaultWidth, min, max, contentMin]);
  return { ref: attach, panelRef: ref, storageKey: key, defaultWidth, min, max, contentMin };
}

export function SidebarResizeHandle({ panelRef, storageKey, defaultWidth, min = 180, max = 480, contentMin = 420, label, className = '' }: {
  panelRef: RefObject<HTMLElement | null>; storageKey: string; defaultWidth: number;
  min?: number; max?: number; contentMin?: number; label: string; className?: string;
}) {
  const enabled = useSettingsStore(state => state.workspacePreferences.resizePanels);
  const saved = useSettingsStore(state => state.workspacePreferences.sidebarWidths?.[storageKey]);
  const start = useRef<{ x: number; width: number } | null>(null);
  const width = () => panelRef.current?.getBoundingClientRect().width ?? defaultWidth;
  const apply = (next: number) => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.width = `${Math.max(min, Math.min(max, (panel.parentElement?.clientWidth || window.innerWidth) - contentMin, next))}px`;
  };
  const save = (next = width()) => {
    const settings = useSettingsStore.getState();
    settings.setWorkspacePreferences({ sidebarWidths: { ...settings.workspacePreferences.sidebarWidths, [storageKey]: next } });
  };
  const finish = () => {
    if (!start.current) return;
    start.current = null;
    panelRef.current?.removeAttribute('data-resizing');
    save();
  };
  if (!enabled) return null;
  return <div role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(saved ?? defaultWidth)}
    className={`ui-sidebar-resize ${className}`} title={`${label} · 拖动调宽，双击恢复；方向键微调`}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      start.current = { x: event.clientX, width: width() };
      panelRef.current?.setAttribute('data-resizing', '');
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => { if (start.current) apply(start.current.width + event.clientX - start.current.x); }}
    onPointerUp={event => { finish(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onLostPointerCapture={finish} onPointerCancel={finish}
    onDoubleClick={() => { apply(defaultWidth); save(defaultWidth); }}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      apply(event.key === 'Home' ? defaultWidth : width() + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10));
      save();
    }} />;
}
