import { memo, useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { Globe2, Box, Map } from 'lucide-react';

import { CANVAS_NODE_TYPES, type CanvasNodeData } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

/**
 * Vertical quick-action rail pinned to the canvas left edge.
 * Three shortcut entries:
 *   - 全景图: new empty panoramaNode (user picks mode / prompt in-place)
 *   - 导演台: create a flat 3D-floor blueprintNode and immediately open its
 *     fullscreen Director Studio workspace
 *   - 全景导演台: create a panorama blueprintNode and immediately open the same
 *     fullscreen workspace in spherical-scene mode
 */
export const CanvasLeftRail = memo(() => {
  const { t } = useTranslation();
  const addNode = useCanvasStore((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();

  const createAt = useCallback(
    (
      type: typeof CANVAS_NODE_TYPES.panorama | typeof CANVAS_NODE_TYPES.blueprint,
      extraData?: Partial<CanvasNodeData>,
    ) => {
      const viewportCenter = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      const jitter = (Math.random() - 0.5) * 120;
      addNode(type, { x: viewportCenter.x + jitter, y: viewportCenter.y + jitter }, extraData);
    },
    [addNode, screenToFlowPosition]
  );

  return (
    <div className="absolute left-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-2 rounded-xl border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-bg)] p-2 shadow-[var(--canvas-rail-shadow)] backdrop-blur-sm">
      <button
        type="button"
        onClick={() => createAt(CANVAS_NODE_TYPES.panorama)}
        className="group flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-button-bg)] text-[var(--canvas-rail-button-text)] transition-colors hover:border-accent/60 hover:bg-accent/10 hover:text-accent"
        title={t('canvasToolbar.addPanorama')}
      >
        <Globe2 className="h-4 w-4" />
        <span className="text-[10px]">{t('node.menu.panorama')}</span>
      </button>
      <button
        type="button"
        onClick={() => createAt(CANVAS_NODE_TYPES.blueprint, { openDirectorStudioOnCreate: true })}
        className="group flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-button-bg)] text-[var(--canvas-rail-button-text)] transition-colors hover:border-accent/60 hover:bg-accent/10 hover:text-accent"
        title={t('canvasToolbar.createDirectorStudio')}
      >
        <Box className="h-4 w-4" />
        <span className="text-[10px]">{t('node.menu.blueprint')}</span>
      </button>
      <button
        type="button"
        onClick={() =>
          createAt(CANVAS_NODE_TYPES.blueprint, { mode: 'panorama', openDirectorStudioOnCreate: true })
        }
        className="group flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-lg border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-button-bg)] text-[var(--canvas-rail-button-text)] transition-colors hover:border-accent/60 hover:bg-accent/10 hover:text-accent"
        title={t('canvasToolbar.createPanoramaDirectorStudio')}
      >
        <Map className="h-4 w-4" />
        <span className="text-[10px]">{t('canvasToolbar.panoramaDirectorStudio')}</span>
      </button>
    </div>
  );
});

CanvasLeftRail.displayName = 'CanvasLeftRail';
