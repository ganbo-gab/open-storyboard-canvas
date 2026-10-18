import { memo, useCallback, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { ImagePlus, Globe2, Hand, Keyboard, LayoutGrid, Images, ListPlus, MousePointer2, Plus, ScrollText, Video } from 'lucide-react';

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
  mode: 'select' | 'hand';
  onMode: (mode: 'select' | 'hand') => void;
  onAdd: () => void;
  onShortcuts: () => void;
}

/**
 * Fixed left-side canvas toolbar for assets, batch import, and primary node
 * creation at the current viewport center.
 */
export const CanvasSideToolbar = memo(({ onOpenAssets, mode, onMode, onAdd, onShortcuts }: CanvasSideToolbarProps) => {
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
    // Place the card around the viewport center, then select it for immediate editing.
    let position = { x: 240, y: 160 };
    try {
      const vp = reactFlow.getViewport();
      const container = document.querySelector('.react-flow') as HTMLElement | null;
      if (container) {
        const rect = container.getBoundingClientRect();
        const screenCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const flowPos = reactFlow.screenToFlowPosition(screenCenter);
        position = {
          x: flowPos.x - 240,
          y: flowPos.y - 130,
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
    }, 'ui').then((result) => {
      if (result.ok && result.output.references.nodeId) {
        void canvasCommandRegistry.execute({ type: 'selection.set', version: CANVAS_COMMAND_VERSION, input: { nodeIds: [result.output.references.nodeId] } }, 'ui');
      }
    });
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
      <div className="canvas-rail" data-canvas-no-marquee="true">
        <button
          type="button"
          className="canvas-rail__add"
          title={t('rework.canvas.add')}
          aria-label={t('rework.canvas.add')}
          onClick={onAdd}
        >
          <Plus className="h-4 w-4" />
        </button>
        <span className="canvas-rail__rule" />
        <button
          type="button"
          title={t('rework.canvas.select')}
          aria-label={t('rework.canvas.select')}
          aria-pressed={mode === 'select'}
          onClick={() => onMode('select')}
        >
          <MousePointer2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={t('rework.canvas.hand')}
          aria-label={t('rework.canvas.hand')}
          aria-pressed={mode === 'hand'}
          onClick={() => onMode('hand')}
        >
          <Hand className="h-4 w-4" />
        </button>
        <span className="canvas-rail__rule" />
        {TOOLBAR_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={`${item.type}-${item.configuration?.directorStudioMode ?? 'default'}`}
              type="button"
              title={t(item.titleKey)}
              aria-label={t(item.titleKey)}
              onClick={() => handleAdd(item.type, item.configuration)}
            >
              <Icon className="h-4 w-4" />
            </button>
          );
        })}
        <span className="canvas-rail__rule" />
        <button
          type="button"
          title={t('canvasToolbar.assetsTitle')}
          aria-label={t('canvasToolbar.assetsTitle')}
          onClick={(event) => onOpenAssets?.(event.currentTarget.getBoundingClientRect())}
        >
          <Images className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={t('canvasToolbar.bulkPromptImportTitle')}
          aria-label={t('canvasToolbar.bulkPromptImportTitle')}
          onClick={() => setIsPromptImportOpen(true)}
        >
          <ListPlus className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={t('canvasToolbar.logsTitle')}
          aria-label={t('canvasToolbar.logsTitle')}
          aria-pressed={isDiagnosticOpen}
          onClick={() => setIsDiagnosticOpen((value) => !value)}
        >
          <ScrollText className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={t('rework.canvas.shortcuts')}
          aria-label={t('rework.canvas.shortcuts')}
          onClick={onShortcuts}
        >
          <Keyboard className="h-4 w-4" />
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
