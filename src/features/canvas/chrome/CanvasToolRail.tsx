import { memo, useState, type ComponentType } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import {
  AudioLines,
  Clapperboard,
  FolderOpen,
  Hand,
  ImagePlus,
  Keyboard,
  ListPlus,
  MousePointer2,
  Plus,
  ScrollText,
  Type,
  Video,
} from 'lucide-react';

import { Tooltip } from '@/components/ui';
import {
  buildPromptImportNodeDrafts,
  getPromptImportNodeBounds,
  type PromptImportMappedRow,
} from '@/features/canvas/application/promptImport';
import type { CanvasNodeCreateConfiguration } from '@/features/canvas/domain/canvasCommands';
import { CANVAS_NODE_TYPES, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { shortcutLabel } from '@/features/canvas/engine/shortcuts';
import { useCanvasUiStore } from '@/features/canvas/state/canvasUiStore';
import { CanvasDiagnosticDrawer } from '@/features/canvas/ui/CanvasDiagnosticDrawer';
import { PromptImportDialog } from '@/features/canvas/ui/PromptImportDialog';
import { useCanvasStore } from '@/stores/canvasStore';

interface QuickAddItem {
  type: CanvasNodeType;
  labelKey: string;
  icon: ComponentType<{ className?: string }>;
  configuration?: CanvasNodeCreateConfiguration;
}

const QUICK_ADD: QuickAddItem[] = [
  { type: CANVAS_NODE_TYPES.textAnnotation, labelKey: 'rework.canvas.rail.text', icon: Type },
  { type: CANVAS_NODE_TYPES.imageEdit, labelKey: 'rework.canvas.rail.image', icon: ImagePlus },
  { type: CANVAS_NODE_TYPES.aiVideo, labelKey: 'rework.canvas.rail.video', icon: Video },
  { type: CANVAS_NODE_TYPES.aiAudio, labelKey: 'rework.canvas.rail.audio', icon: AudioLines },
  {
    type: CANVAS_NODE_TYPES.blueprint,
    labelKey: 'rework.canvas.rail.stage',
    icon: Clapperboard,
    configuration: { openDirectorStudio: true, directorStudioMode: 'flat' },
  },
];

interface CanvasToolRailProps {
  onOpenAddMenu: () => void;
  onQuickAdd: (type: CanvasNodeType, configuration?: CanvasNodeCreateConfiguration) => void;
  onOpenAssets: (anchor: DOMRect) => void;
}

/** Left rail: tools first, then the five most-used node types, then panels. Bottom stays free for composers. */
export const CanvasToolRail = memo(function CanvasToolRail({ onOpenAddMenu, onQuickAdd, onOpenAssets }: CanvasToolRailProps) {
  const { t } = useTranslation();
  const reactFlow = useReactFlow();
  const tool = useCanvasUiStore((state) => state.tool);
  const setTool = useCanvasUiStore((state) => state.setTool);
  const setSheet = useCanvasUiStore((state) => state.setSheet);
  const addNodesBatch = useCanvasStore((state) => state.addNodesBatch);
  const [importOpen, setImportOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const nodes = useCanvasStore((state) => (diagnosticsOpen ? state.nodes : EMPTY_NODES));

  const handleImport = (rows: PromptImportMappedRow[], options: { fitView: boolean }) => {
    const container = document.querySelector<HTMLElement>('.canvas-root');
    const rect = container?.getBoundingClientRect();
    const origin = rect
      ? reactFlow.screenToFlowPosition({ x: rect.left + Math.min(120, rect.width * 0.1), y: rect.top + Math.min(96, rect.height * 0.1) })
      : { x: 120, y: 80 };
    const drafts = buildPromptImportNodeDrafts(rows, origin, (index) => t('promptImport.defaultNodeName', { index }));
    addNodesBatch(drafts.map((draft) => ({
      type: CANVAS_NODE_TYPES.imageEdit,
      position: draft.position,
      dimensions: draft.dimensions,
      data: draft.data,
    })));
    const bounds = getPromptImportNodeBounds(drafts);
    if (options.fitView && bounds) void reactFlow.fitBounds(bounds, { padding: 0.12, duration: 300 });
  };

  return (
    <>
      <nav className="canvas-chrome canvas-rail" data-canvas-overlay="" aria-label={t('rework.canvas.rail.label')}>
        <Tooltip label={t('rework.canvas.add')} shortcut={shortcutLabel('node.add')}>
          <button type="button" className="canvas-tool canvas-tool--primary" aria-label={t('rework.canvas.add')} onClick={onOpenAddMenu}>
            <Plus />
          </button>
        </Tooltip>
        <span className="canvas-rail__rule" />
        <Tooltip label={t('rework.canvas.select')} shortcut={shortcutLabel('tool.select')}>
          <button type="button" className="canvas-tool" aria-label={t('rework.canvas.select')} aria-pressed={tool === 'select'} onClick={() => setTool('select')}>
            <MousePointer2 />
          </button>
        </Tooltip>
        <Tooltip label={t('rework.canvas.hand')} shortcut={shortcutLabel('tool.hand')}>
          <button type="button" className="canvas-tool" aria-label={t('rework.canvas.hand')} aria-pressed={tool === 'hand'} onClick={() => setTool('hand')}>
            <Hand />
          </button>
        </Tooltip>
        <span className="canvas-rail__rule" />
        {QUICK_ADD.map((item) => {
          const Icon = item.icon;
          return (
            <Tooltip key={item.type} label={t(item.labelKey)}>
              <button
                type="button"
                className="canvas-tool"
                aria-label={t(item.labelKey)}
                onClick={() => onQuickAdd(item.type, item.configuration)}
              >
                <Icon />
              </button>
            </Tooltip>
          );
        })}
        <span className="canvas-rail__rule" />
        <Tooltip label={t('rework.canvas.rail.assets')}>
          <button
            type="button"
            className="canvas-tool"
            aria-label={t('rework.canvas.rail.assets')}
            onClick={(event) => onOpenAssets(event.currentTarget.getBoundingClientRect())}
          >
            <FolderOpen />
          </button>
        </Tooltip>
        <Tooltip label={t('canvasToolbar.bulkPromptImportTitle')}>
          <button type="button" className="canvas-tool" aria-label={t('canvasToolbar.bulkPromptImportTitle')} onClick={() => setImportOpen(true)}>
            <ListPlus />
          </button>
        </Tooltip>
        <Tooltip label={t('canvasToolbar.logsTitle')}>
          <button
            type="button"
            className="canvas-tool"
            aria-label={t('canvasToolbar.logsTitle')}
            aria-pressed={diagnosticsOpen}
            onClick={() => setDiagnosticsOpen((open) => !open)}
          >
            <ScrollText />
          </button>
        </Tooltip>
        <span className="canvas-rail__rule" />
        <Tooltip label={t('rework.canvas.shortcuts')} shortcut={shortcutLabel('view.shortcuts')}>
          <button type="button" className="canvas-tool" aria-label={t('rework.canvas.shortcuts')} onClick={() => setSheet('shortcuts')}>
            <Keyboard />
          </button>
        </Tooltip>
      </nav>
      <CanvasDiagnosticDrawer isOpen={diagnosticsOpen} nodes={nodes} onClose={() => setDiagnosticsOpen(false)} />
      <PromptImportDialog isOpen={importOpen} onClose={() => setImportOpen(false)} onImport={handleImport} />
    </>
  );
});

const EMPTY_NODES: never[] = [];
