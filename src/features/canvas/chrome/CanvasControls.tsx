import { memo, useState } from 'react';
import { useStore } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import {
  Grid2x2,
  LayoutGrid,
  Map as MapIcon,
  Maximize2,
  Minus,
  Plus,
  Redo2,
  Spline,
  Undo2,
} from 'lucide-react';

import { MenuItem, MenuSeparator, MenuSurface, Tooltip, anchorAbove } from '@/components/ui';
import { useCanvasActions } from '@/features/canvas/engine/canvasActions';
import { shortcutLabel } from '@/features/canvas/engine/shortcuts';
import { useCanvasUiStore } from '@/features/canvas/state/canvasUiStore';
import { useCanvasStore } from '@/stores/canvasStore';

const ZOOM_PRESETS = [0.5, 1, 2] as const;

/** Bottom-left: history, zoom, view toggles. Zoom % re-renders only when the rounded value changes. */
export const CanvasControls = memo(function CanvasControls() {
  const { t } = useTranslation();
  const actions = useCanvasActions();
  const zoomPercent = useStore((state) => Math.round(state.transform[2] * 100));
  const { minZoom, maxZoom } = useStore((state) => ({ minZoom: state.minZoom, maxZoom: state.maxZoom }), (a, b) => a.minZoom === b.minZoom && a.maxZoom === b.maxZoom);
  const canUndo = useCanvasStore((state) => state.history.past.length > 0);
  const canRedo = useCanvasStore((state) => state.history.future.length > 0);
  const hasNodes = useCanvasStore((state) => state.nodes.length > 0);
  const minimapOpen = useCanvasUiStore((state) => state.minimapOpen);
  const edgesHidden = useCanvasUiStore((state) => state.edgesHidden);
  const snapToGrid = useCanvasUiStore((state) => state.snapToGrid);
  const toggleMinimap = useCanvasUiStore((state) => state.toggleMinimap);
  const toggleEdgesHidden = useCanvasUiStore((state) => state.toggleEdgesHidden);
  const toggleSnapToGrid = useCanvasUiStore((state) => state.toggleSnapToGrid);
  const [zoomMenu, setZoomMenu] = useState<{ x: number; y: number } | null>(null);
  const [zoomDraft, setZoomDraft] = useState('');

  const commitZoomDraft = () => {
    const value = Number.parseFloat(zoomDraft);
    if (Number.isFinite(value) && value > 0) {
      actions.zoomTo(Math.min(maxZoom, Math.max(minZoom, value / 100)));
    }
    setZoomMenu(null);
  };

  return (
    <div className="canvas-chrome canvas-controls" data-canvas-overlay="" role="toolbar" aria-label={t('rework.canvas.controls')}>
      <Tooltip label={t('rework.canvas.undo')} shortcut={shortcutLabel('edit.undo')} side="top">
        <button type="button" className="canvas-tool" aria-label={t('rework.canvas.undo')} disabled={!canUndo} onClick={actions.undo}>
          <Undo2 />
        </button>
      </Tooltip>
      <Tooltip label={t('rework.canvas.redo')} shortcut={shortcutLabel('edit.redo')} side="top">
        <button type="button" className="canvas-tool" aria-label={t('rework.canvas.redo')} disabled={!canRedo} onClick={actions.redo}>
          <Redo2 />
        </button>
      </Tooltip>
      <span className="canvas-controls__rule" />
      <Tooltip label={t('rework.canvas.zoomOut')} shortcut={shortcutLabel('view.zoomOut')} side="top">
        <button type="button" className="canvas-tool" aria-label={t('rework.canvas.zoomOut')} onClick={actions.zoomOut}>
          <Minus />
        </button>
      </Tooltip>
      <button
        type="button"
        className="canvas-controls__zoom"
        aria-haspopup="menu"
        aria-expanded={Boolean(zoomMenu)}
        aria-label={t('rework.canvas.zoomLevel')}
        onClick={(event) => {
          setZoomDraft(String(zoomPercent));
          setZoomMenu(zoomMenu ? null : anchorAbove(event.currentTarget));
        }}
      >
        {zoomPercent}%
      </button>
      <Tooltip label={t('rework.canvas.zoomIn')} shortcut={shortcutLabel('view.zoomIn')} side="top">
        <button type="button" className="canvas-tool" aria-label={t('rework.canvas.zoomIn')} onClick={actions.zoomIn}>
          <Plus />
        </button>
      </Tooltip>
      <Tooltip label={t('rework.canvas.fit')} shortcut={shortcutLabel('view.fit')} side="top">
        <button type="button" className="canvas-tool" aria-label={t('rework.canvas.fit')} disabled={!hasNodes} onClick={actions.fitView}>
          <Maximize2 />
        </button>
      </Tooltip>
      <span className="canvas-controls__rule" />
      <Tooltip label={t('rework.canvas.minimap')} side="top">
        <button type="button" className="canvas-tool" aria-label={t('rework.canvas.minimap')} aria-pressed={minimapOpen} onClick={toggleMinimap}>
          <MapIcon />
        </button>
      </Tooltip>
      <Tooltip label={t('rework.canvas.snap')} side="top">
        <button type="button" className="canvas-tool" aria-label={t('rework.canvas.snap')} aria-pressed={snapToGrid} onClick={toggleSnapToGrid}>
          <Grid2x2 />
        </button>
      </Tooltip>
      <Tooltip label={edgesHidden ? t('rework.canvas.showEdges') : t('rework.canvas.hideEdges')} side="top">
        <button type="button" className="canvas-tool" aria-label={t('rework.canvas.hideEdges')} aria-pressed={edgesHidden} onClick={toggleEdgesHidden}>
          <Spline />
        </button>
      </Tooltip>
      <Tooltip label={t('rework.canvas.organize')} side="top">
        <button type="button" className="canvas-tool" aria-label={t('rework.canvas.organize')} disabled={!hasNodes} onClick={actions.organizeCanvas}>
          <LayoutGrid />
        </button>
      </Tooltip>

      {zoomMenu ? (
        <MenuSurface anchor={zoomMenu} onClose={() => setZoomMenu(null)} width={220} label={t('rework.canvas.zoomLevel')}>
          <label className="canvas-zoom-input">
            <input
              autoFocus
              inputMode="numeric"
              value={zoomDraft}
              aria-label={t('rework.canvas.zoomLevel')}
              onChange={(event) => setZoomDraft(event.target.value.replace(/[^\d.]/g, ''))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitZoomDraft();
              }}
            />
            <span className="text-text-subtle">%</span>
          </label>
          <MenuItem label={t('rework.canvas.zoomIn')} shortcut={shortcutLabel('view.zoomIn')} onClick={() => { setZoomMenu(null); actions.zoomIn(); }} />
          <MenuItem label={t('rework.canvas.zoomOut')} shortcut={shortcutLabel('view.zoomOut')} onClick={() => { setZoomMenu(null); actions.zoomOut(); }} />
          <MenuItem label={t('rework.canvas.fit')} shortcut={shortcutLabel('view.fit')} onClick={() => { setZoomMenu(null); actions.fitView(); }} />
          <MenuSeparator />
          {ZOOM_PRESETS.map((preset) => (
            <MenuItem
              key={preset}
              label={`${preset * 100}%`}
              shortcut={preset === 1 ? shortcutLabel('view.actualSize') : undefined}
              onClick={() => { setZoomMenu(null); actions.zoomTo(preset); }}
            />
          ))}
        </MenuSurface>
      ) : null}
    </div>
  );
});
