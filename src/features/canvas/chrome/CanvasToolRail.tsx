import { useSettingsStore } from '@/stores/settingsStore';
import { arrangeToolbarItems } from '@/features/settings/workspacePreferences';
import { ToolbarPreferencesDialog } from '@/features/settings/ToolbarPreferencesDialog';
import { lazy, memo, Suspense, useState, type ComponentType } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import {
  AudioLines,
  Boxes,
  Clapperboard,
  FolderOpen,
  FileClock,
  Hand,
  ImagePlus,
  Keyboard,
  Loader2,
  ListPlus,
  MousePointer2,
  MoreHorizontal,
  Sparkles,
  SlidersHorizontal,
  Palette,
  Plus,
  ScrollText,
  Type,
  Users,
  Video,
} from 'lucide-react';

import { MenuItem, MenuSurface, Tooltip, UiModal, anchorToElement, type MenuAnchor } from '@/components/ui';
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
import type { CanvasLibraryTab } from '@/features/canvas/ui/CanvasLibraryDialog';

// Library editors are only needed after a deliberate rail click, not while loading a large canvas.
const CanvasLibraryDialog = lazy(() => import('@/features/canvas/ui/CanvasLibraryDialog').then(module => ({ default: module.CanvasLibraryDialog })));

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
  const config = useSettingsStore((state) => state.workspacePreferences.canvasRail);
  const [menu, setMenu] = useState<{ kind: 'create' | 'more'; anchor: MenuAnchor } | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [libraryTab, setLibraryTab] = useState<CanvasLibraryTab | null>(null);
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

  const entries = [
    { id: 'create', label: '创作节点', icon: Sparkles, run: (rect: DOMRect) => setMenu({ kind: 'create', anchor: { x: rect.right + 8, y: rect.top } }) },
    { id: 'stage', label: t('rework.canvas.rail.stage'), icon: Clapperboard, run: () => onQuickAdd(CANVAS_NODE_TYPES.blueprint, { openDirectorStudio: true, directorStudioMode: 'flat' }) },
    { id: 'assets', label: t('rework.canvas.rail.assets'), icon: FolderOpen, run: (rect: DOMRect) => onOpenAssets(rect) },
    { id: 'history', label: t('rework.generationHistory.title'), icon: FileClock, run: () => setLibraryTab('history') },
    { id: 'toolbox', label: t('rework.toolbox.title'), icon: Boxes, run: () => setLibraryTab('toolbox') },
    { id: 'materials', label: t('rework.materialLibrary.title'), icon: Palette, run: () => setLibraryTab('materials') },
    { id: 'characters', label: t('characters.title'), icon: Users, run: () => setLibraryTab('characters') },
    { id: 'import', label: t('canvasToolbar.bulkPromptImportTitle'), icon: ListPlus, run: () => setImportOpen(true) },
    { id: 'diagnostics', label: t('canvasToolbar.logsTitle'), icon: ScrollText, run: () => setDiagnosticsOpen(true) },
    { id: 'shortcuts', label: t('rework.canvas.shortcuts'), icon: Keyboard, run: () => setSheet('shortcuts') },
  ];
  const arranged = arrangeToolbarItems(entries, config);
  return (
    <>
      <nav className="canvas-chrome canvas-rail" data-canvas-overlay="" aria-label={t('rework.canvas.rail.label')}>
        <Tooltip label={t('rework.canvas.add')} shortcut={shortcutLabel('node.add')}>
          <button type="button" className="canvas-tool canvas-tool--primary" aria-label={t('rework.canvas.add')} onClick={(event) => { const ui = useCanvasUiStore.getState(); if (ui.addMenu?.anchor?.trigger === event.currentTarget) { ui.closeMenus(); return; } setMenu(null); onOpenAddMenu(); const opened = useCanvasUiStore.getState().addMenu; if (opened) ui.openAddMenu({ ...opened, anchor: anchorToElement(event.currentTarget, { x: opened.clientX, y: opened.clientY }) }); }}><Plus /></button>
        </Tooltip>
        <span className="canvas-rail__rule" />
        <Tooltip label={t('rework.canvas.select')} shortcut={shortcutLabel('tool.select')}>
          <button type="button" className="canvas-tool" aria-label={t('rework.canvas.select')} aria-pressed={tool === 'select'} onClick={() => { setMenu(null); setTool('select'); }}><MousePointer2 /></button>
        </Tooltip>
        <Tooltip label={t('rework.canvas.hand')} shortcut={shortcutLabel('tool.hand')}>
          <button type="button" className="canvas-tool" aria-label={t('rework.canvas.hand')} aria-pressed={tool === 'hand'} onClick={() => { setMenu(null); setTool('hand'); }}><Hand /></button>
        </Tooltip>
        <span className="canvas-rail__rule" />
        {arranged.visible.map((item) => <Tooltip key={item.id} label={item.label}>
          <button type="button" className="canvas-tool" aria-label={item.label} aria-haspopup={item.id === 'create' ? 'menu' : undefined}
            onClick={(event) => {
              if (item.id === 'create') {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu(menu?.kind === 'create' ? null : { kind: 'create', anchor: anchorToElement(event.currentTarget, { x: rect.right + 8, y: rect.top }) });
              } else { setMenu(null); item.run(event.currentTarget.getBoundingClientRect()); }
            }}><item.icon /></button>
        </Tooltip>)}
        <span className="canvas-rail__rule" />
        <Tooltip label="更多工具与侧栏设置"><button type="button" className="canvas-tool" aria-label="更多工具与侧栏设置" aria-expanded={menu?.kind === 'more'}
          onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu(menu?.kind === 'more' ? null : { kind: 'more', anchor: anchorToElement(event.currentTarget, { x: rect.right + 8, y: rect.top }) }); }}><MoreHorizontal /></button></Tooltip>
      </nav>
      {menu && <MenuSurface anchor={menu.anchor} onClose={() => setMenu(null)} label={menu.kind === 'create' ? '创作节点' : '更多画布工具'}>
        {menu.kind === 'create' ? QUICK_ADD.filter((item) => item.type !== CANVAS_NODE_TYPES.blueprint).map((item) => <MenuItem key={item.type} icon={<item.icon />} label={t(item.labelKey)} onClick={() => { setMenu(null); onQuickAdd(item.type, item.configuration); }} />)
          : <>{arranged.more.map((item) => <MenuItem key={item.id} icon={<item.icon />} label={item.label} onClick={(event) => { setMenu(null); item.run(event.currentTarget.getBoundingClientRect()); }} />)}
            <div className="ui-menu__separator" /><MenuItem icon={<SlidersHorizontal />} label="自定义侧栏…" onClick={() => { setMenu(null); setCustomizing(true); }} /></>}
      </MenuSurface>}
      {customizing && <ToolbarPreferencesDialog target="canvasRail" items={entries.map(({ id, label }) => ({ id, label }))} onClose={() => setCustomizing(false)} />}
      <CanvasDiagnosticDrawer isOpen={diagnosticsOpen} nodes={nodes} onClose={() => setDiagnosticsOpen(false)} />
      <PromptImportDialog isOpen={importOpen} onClose={() => setImportOpen(false)} onImport={handleImport} />
      {libraryTab && <Suspense fallback={<UiModal isOpen title={t('rework.libraryHub.title')} onClose={() => setLibraryTab(null)}><p role="status" className="flex items-center gap-2 text-xs text-text-muted"><Loader2 className="h-4 w-4 animate-spin" />{t('common.loading')}</p></UiModal>}>
        <CanvasLibraryDialog initialTab={libraryTab} onClose={() => setLibraryTab(null)} />
      </Suspense>}
    </>
  );
});

const EMPTY_NODES: never[] = [];
