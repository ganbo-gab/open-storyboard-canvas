import { memo, useCallback, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { ImagePlus, Globe2, LayoutGrid, Images, ListPlus, ScrollText, Video } from 'lucide-react';

import { CANVAS_NODE_TYPES, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import {
  CANVAS_COMMAND_VERSION,
  type CanvasNodeCreateConfiguration,
} from '@/features/canvas/domain/canvasCommands';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import {
  buildPromptImportNodeDrafts,
  getPromptImportNodeBounds,
  type PromptImportMappedRow,
} from '@/features/canvas/application/promptImport';
import { PromptImportDialog } from '@/features/canvas/ui/PromptImportDialog';
import { CanvasDiagnosticDrawer } from '@/features/canvas/ui/CanvasDiagnosticDrawer';
import { useCanvasStore } from '@/stores/canvasStore';

interface SideToolbarItem {
  type: CanvasNodeType;
  labelKey: string;
  titleKey: string;
  icon: React.ComponentType<{ className?: string }>;
  configuration?: CanvasNodeCreateConfiguration;
}

function TextIcon({ className }: { className?: string }) {
  return <span className={className}>T</span>;
}

const TOOLBAR_ITEMS: SideToolbarItem[] = [
  {
    type: CANVAS_NODE_TYPES.aiText,
    labelKey: 'node.menu.aiTextGeneration',
    titleKey: 'canvasToolbar.addAiText',
    icon: TextIcon,
  },
  {
    type: CANVAS_NODE_TYPES.imageEdit,
    labelKey: 'node.menu.aiImageGeneration',
    titleKey: 'canvasToolbar.addAiImage',
    icon: ImagePlus,
  },
  {
    type: CANVAS_NODE_TYPES.aiVideo,
    labelKey: 'node.menu.aiVideoGeneration',
    titleKey: 'canvasToolbar.addAiVideo',
    icon: Video,
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
    configuration: { openDirectorStudio: true, directorStudioMode: 'flat' },
  },
];

interface CanvasSideToolbarProps {
  onOpenAssets?: (buttonRect: DOMRect) => void;
}

/**
 * Fixed left-side canvas toolbar for assets, batch import, and primary node
 * creation at the current viewport center.
 */
export const CanvasSideToolbar = memo(({ onOpenAssets }: CanvasSideToolbarProps) => {
  const { t } = useTranslation();
  const reactFlow = useReactFlow();
  const addNodesBatch = useCanvasStore((s) => s.addNodesBatch);
  const [isPromptImportOpen, setIsPromptImportOpen] = useState(false);
  const [isDiagnosticOpen, setIsDiagnosticOpen] = useState(false);
  const nodes = useCanvasStore((s) => s.nodes);

  const handleAdd = useCallback((
    type: CanvasNodeType,
    configuration?: CanvasNodeCreateConfiguration,
  ) => {
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
    void canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeType: type,
        position,
        configuration,
      },
    }, 'ui');
  }, [reactFlow]);

  const handleImport = useCallback((
    rows: PromptImportMappedRow[],
    options: { fitView: boolean },
  ) => {
    let origin = { x: 120, y: 80 };
    const container = document.querySelector('.react-flow') as HTMLElement | null;
    if (container) {
      const rect = container.getBoundingClientRect();
      origin = reactFlow.screenToFlowPosition({
        x: rect.left + Math.min(120, rect.width * 0.1),
        y: rect.top + Math.min(96, rect.height * 0.1),
      });
    } else {
      const viewport = reactFlow.getViewport();
      origin = {
        x: (-viewport.x + 96) / Math.max(0.01, viewport.zoom),
        y: (-viewport.y + 72) / Math.max(0.01, viewport.zoom),
      };
    }

    const drafts = buildPromptImportNodeDrafts(
      rows,
      origin,
      (index) => t('promptImport.defaultNodeName', { index }),
    );
    addNodesBatch(drafts.map((draft) => ({
      type: CANVAS_NODE_TYPES.imageEdit,
      position: draft.position,
      dimensions: draft.dimensions,
      data: draft.data,
    })));

    const importedBounds = getPromptImportNodeBounds(drafts);
    if (options.fitView && importedBounds) {
      void reactFlow.fitBounds(importedBounds, {
        padding: 0.12,
        duration: 300,
      });
    }
  }, [addNodesBatch, reactFlow, t]);

  return (
    <>
      <div className="canvas-side-toolbar absolute left-3 top-1/2 z-20 flex max-h-[calc(100%-24px)] -translate-y-1/2 flex-col gap-2 overflow-y-auto rounded-xl border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-bg)] p-2 shadow-[var(--canvas-rail-shadow)] backdrop-blur">
        <button
          type="button"
          title={t('canvasToolbar.assetsTitle')}
          aria-label={t('canvasToolbar.assetsTitle')}
          onClick={(event) => onOpenAssets?.(event.currentTarget.getBoundingClientRect())}
          className="canvas-side-toolbar__button flex w-16 shrink-0 flex-col items-center gap-0.5 rounded-lg border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-button-bg)] px-2 py-2 text-[10px] text-[var(--canvas-rail-button-text)] transition-colors hover:border-accent/60 hover:bg-accent/15 hover:text-accent"
        >
          <Images className="h-4 w-4" />
          <span className="canvas-side-toolbar__label leading-tight">{t('canvasToolbar.assets')}</span>
        </button>
        {TOOLBAR_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={`${item.type}-${item.configuration?.directorStudioMode ?? 'default'}`}
              type="button"
              title={t(item.titleKey)}
              aria-label={t(item.titleKey)}
              onClick={() => handleAdd(item.type, item.configuration)}
              className="canvas-side-toolbar__button flex w-16 shrink-0 flex-col items-center gap-0.5 rounded-lg border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-button-bg)] px-2 py-2 text-[10px] text-[var(--canvas-rail-button-text)] transition-colors hover:border-accent/60 hover:bg-accent/15 hover:text-accent"
            >
              <Icon className="h-4 w-4" />
              <span className="canvas-side-toolbar__label leading-tight">{t(item.labelKey)}</span>
            </button>
          );
        })}
        <button
          type="button"
          title={t('canvasToolbar.logsTitle')}
          aria-label={t('canvasToolbar.logsTitle')}
          aria-expanded={isDiagnosticOpen}
          onClick={() => setIsDiagnosticOpen((value) => !value)}
          className={`canvas-side-toolbar__button flex w-16 shrink-0 flex-col items-center gap-0.5 rounded-lg border px-2 py-2 text-[10px] transition-colors ${isDiagnosticOpen ? 'border-accent/60 bg-accent/15 text-accent' : 'border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-button-bg)] text-[var(--canvas-rail-button-text)] hover:border-accent/60 hover:bg-accent/15 hover:text-accent'}`}
        >
          <ScrollText className="h-4 w-4" />
          <span className="canvas-side-toolbar__label leading-tight">{t('canvasToolbar.logs')}</span>
        </button>
        <button
          type="button"
          title={t('canvasToolbar.bulkPromptImportTitle')}
          aria-label={t('canvasToolbar.bulkPromptImportTitle')}
          onClick={() => setIsPromptImportOpen(true)}
          className="canvas-side-toolbar__button flex w-16 shrink-0 flex-col items-center gap-0.5 rounded-lg border border-[var(--canvas-rail-button-border)] bg-[var(--canvas-rail-button-bg)] px-2 py-2 text-[10px] text-[var(--canvas-rail-button-text)] transition-colors hover:border-accent/60 hover:bg-accent/15 hover:text-accent"
        >
          <ListPlus className="h-4 w-4" />
          <span className="canvas-side-toolbar__label leading-tight">{t('canvasToolbar.bulkPromptImport')}</span>
        </button>
      </div>
      <CanvasDiagnosticDrawer isOpen={isDiagnosticOpen} nodes={nodes} onClose={() => setIsDiagnosticOpen(false)} />
      <PromptImportDialog
        isOpen={isPromptImportOpen}
        onClose={() => setIsPromptImportOpen(false)}
        onImport={handleImport}
      />
    </>
  );
});

CanvasSideToolbar.displayName = 'CanvasSideToolbar';
