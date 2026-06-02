import { memo, useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { ImagePlus, Globe2, LayoutGrid, Images } from 'lucide-react';

import { CANVAS_NODE_TYPES, type CanvasNodeData, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

interface SideToolbarItem {
  type: CanvasNodeType;
  labelKey: string;
  titleKey: string;
  icon: React.ComponentType<{ className?: string }>;
  data?: Partial<CanvasNodeData>;
}

const TOOLBAR_ITEMS: SideToolbarItem[] = [
  {
    type: CANVAS_NODE_TYPES.imageEdit,
    labelKey: 'node.menu.aiImageGeneration',
    titleKey: 'canvasToolbar.addAiImage',
    icon: ImagePlus,
  },
  {
    type: CANVAS_NODE_TYPES.panorama,
    labelKey: 'node.menu.panorama',
    titleKey: 'canvasToolbar.addPanorama',
    icon: Globe2,
  },
  {
    type: CANVAS_NODE_TYPES.blueprint,
    labelKey: 'node.menu.blueprint',
    titleKey: 'canvasToolbar.createDirectorStudio',
    icon: LayoutGrid,
    data: { openDirectorStudioOnCreate: true },
  },
];

interface CanvasSideToolbarProps {
  onOpenAssets?: (buttonRect: DOMRect) => void;
}

/**
 * Fixed left-side canvas toolbar. Always-visible buttons to drop one of the
 * three primary workspace node types (AI image / panorama / Director Studio)
 * onto the canvas at the current viewport center.
 */
export const CanvasSideToolbar = memo(({ onOpenAssets }: CanvasSideToolbarProps) => {
  const { t } = useTranslation();
  const reactFlow = useReactFlow();
  const addNode = useCanvasStore((s) => s.addNode);

  const handleAdd = useCallback((type: CanvasNodeType, data?: Partial<CanvasNodeData>) => {
    // Drop near the current viewport center, with a small random nudge so
    // repeated clicks don't stack.
    let position = { x: 240, y: 160 };
    try {
      const vp = reactFlow.getViewport();
      const container = document.querySelector('.react-flow') as HTMLElement | null;
      if (container) {
        const rect = container.getBoundingClientRect();
        const screenCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const flowPos = reactFlow.screenToFlowPosition(screenCenter);
        position = {
          x: flowPos.x + (Math.random() - 0.5) * 120,
          y: flowPos.y + (Math.random() - 0.5) * 120,
        };
      } else {
        position = { x: -vp.x / vp.zoom + 120, y: -vp.y / vp.zoom + 120 };
      }
    } catch {
      /* fallback position already set */
    }
    addNode(type, position, data);
  }, [addNode, reactFlow]);

  return (
    <div className="absolute left-3 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-2 rounded-xl border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-bg)] p-2 shadow-[var(--canvas-rail-shadow)] backdrop-blur">
      <button
        type="button"
        title={t('canvasToolbar.assetsTitle')}
        onClick={(event) => onOpenAssets?.(event.currentTarget.getBoundingClientRect())}
        className="flex w-16 flex-col items-center gap-0.5 rounded-lg border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-button-bg)] px-2 py-2 text-[10px] text-[var(--canvas-rail-button-text)] transition-colors hover:border-accent/60 hover:bg-accent/15 hover:text-accent"
      >
        <Images className="h-4 w-4" />
        <span className="leading-tight">{t('canvasToolbar.assets')}</span>
      </button>
      {TOOLBAR_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.type}
            type="button"
            title={t(item.titleKey)}
            onClick={() => handleAdd(item.type, item.data)}
            className="flex w-16 flex-col items-center gap-0.5 rounded-lg border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-button-bg)] px-2 py-2 text-[10px] text-[var(--canvas-rail-button-text)] transition-colors hover:border-accent/60 hover:bg-accent/15 hover:text-accent"
          >
            <Icon className="h-4 w-4" />
            <span className="leading-tight">{t(item.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
});

CanvasSideToolbar.displayName = 'CanvasSideToolbar';
