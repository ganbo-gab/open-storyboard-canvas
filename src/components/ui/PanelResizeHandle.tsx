import { useRef, type RefObject } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';

/** Changes only the panel box while dragging; saves dimensions once at the end. */
export function PanelResizeHandle({ panelRef, storageKey, edge = 'right', onSize }: {
  panelRef: RefObject<HTMLElement | null>;
  storageKey: string;
  edge?: 'left' | 'right';
  onSize?: (width: number, height: number) => void;
}) {
  const enabled = useSettingsStore((state) => state.workspacePreferences?.resizePanels ?? true);
  const start = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const commit = () => {
    const panel = panelRef.current;
    if (!panel) return;
    const { width, height } = panel.getBoundingClientRect();
    const settings = useSettingsStore.getState();
    settings.setWorkspacePreferences({ panelSizes: { ...settings.workspacePreferences.panelSizes, [storageKey]: { width, height } } });
  };
  const apply = (width: number, height: number) => {
    const panel = panelRef.current;
    if (!panel) return;
    const nextWidth = Math.max(300, Math.min(window.innerWidth - 40, width));
    const nextHeight = Math.max(240, Math.min(window.innerHeight - 72, height));
    if (onSize) onSize(nextWidth, nextHeight);
    else { panel.style.width = `${nextWidth}px`; panel.style.height = `${nextHeight}px`; }
  };
  if (!enabled) return null;
  return <button type="button" aria-label="拖动调整面板大小" title="拖动调整大小；方向键精调"
    className={`ui-panel-resize ui-panel-resize--${edge}`}
    onPointerDown={(event) => {
      event.preventDefault(); event.stopPropagation();
      const bounds = panelRef.current?.getBoundingClientRect();
      if (!bounds) return;
      start.current = { x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (!start.current) return;
      const direction = edge === 'left' ? -1 : 1;
      apply(start.current.width + direction * (event.clientX - start.current.x), start.current.height + event.clientY - start.current.y);
    }}
    onPointerUp={(event) => { if (!start.current) return; start.current = null; event.currentTarget.releasePointerCapture(event.pointerId); commit(); }}
    onLostPointerCapture={() => { if (start.current) { start.current = null; commit(); } }}
    onKeyDown={(event) => {
      const bounds = panelRef.current?.getBoundingClientRect();
      if (!bounds || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 40 : 10;
      apply(bounds.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), bounds.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0));
      commit();
    }}><span aria-hidden="true">◢</span></button>;
}
