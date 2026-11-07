import { lazy, Suspense, useState } from 'react';
import { Boxes, FileClock, Loader2, NotebookPen, Palette, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiModal, UiTabs } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { canvasCommandRegistry } from '../application/canvasCommandService';
import { canvasNavigationFacade } from '../application/canvasNavigationFacade';
import { CANVAS_COMMAND_VERSION } from '../domain/canvasCommands';
import { CANVAS_NODE_TYPES } from '../domain/canvasNodes';
import { getNodeDefinition } from '../domain/nodeRegistry';
import { applyCharacterToProject, applyToolboxTemplateToProject, reuseCanvasHistoryInProject } from '@/features/library/application/projectLibraryActions';
import { applyMaterialToPrompt, type MaterialEntry } from '@/features/library/materials/materials';
import { useWorkbenchStore } from '@/features/workbench/store/workbenchStore';
import { requestHistoryNavigation, requestStudioPageNavigation } from '@/features/studio/studioNavigation';

// Load only the selected library: Markdown, vault tools and other editors are not canvas boot dependencies.
const Characters = lazy(() => import('@/features/characters/ui/CharacterLibraryPage').then(module => ({ default: module.CharacterLibraryPage })));
const Materials = lazy(() => import('@/features/library/ui/MaterialLibraryPage').then(module => ({ default: module.MaterialLibraryPage })));
const Toolbox = lazy(() => import('@/features/library/ui/ToolboxPage').then(module => ({ default: module.ToolboxPage })));
const History = lazy(() => import('@/features/library/ui/GenerationHistoryPage').then(module => ({ default: module.GenerationHistoryPage })));
const Knowledge = lazy(() => import('@/features/knowledge/ui/KnowledgeLibraryPage').then(module => ({ default: module.KnowledgeLibraryPage })));

export type CanvasLibraryTab = 'materials' | 'characters' | 'toolbox' | 'history' | 'knowledge';

export function CanvasLibraryDialog({ initialTab, onClose }: { initialTab: CanvasLibraryTab; onClose(): void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<CanvasLibraryTab>(initialTab);
  const project = () => {
    const id = useProjectStore.getState().currentProjectId;
    if (!id) throw new Error(t('rework.generationHistory.sourceMissing'));
    return id;
  };
  const focus = async (ids: string[]) => { await canvasNavigationFacade.focusNodeIds(ids, { select: true, padding: 0.3 }); };
  const applyMaterial = async (entry: MaterialEntry) => {
    const store = useCanvasStore.getState();
    const selected = store.nodes.find(node => node.id === store.selectedNodeId);
    const target = selected && getNodeDefinition(selected.type).capabilities.promptInput ? selected : null;
    const prompt = applyMaterialToPrompt(target && typeof target.data.prompt === 'string' ? target.data.prompt : '', entry);
    const viewport = store.currentViewport;
    const position = { x: ((store.canvasViewportSize.width || 1200) / 2 - viewport.x) / viewport.zoom - 180, y: ((store.canvasViewportSize.height || 800) / 2 - viewport.y) / viewport.zoom - 120 };
    const result = target ? await canvasCommandRegistry.execute({ type: 'node.setPrompt', version: CANVAS_COMMAND_VERSION, input: { nodeId: target.id, prompt } }, 'ui')
      : await canvasCommandRegistry.execute({ type: 'node.create', version: CANVAS_COMMAND_VERSION, input: {
          nodeType: entry.kind === 'effect' || entry.kind === 'cameraMotion' ? CANVAS_NODE_TYPES.aiVideo : CANVAS_NODE_TYPES.imageEdit,
          position, configuration: { prompt },
        } }, 'ui');
    if (!result.ok) throw new Error(result.error.message);
    const next = useCanvasStore.getState();
    useProjectStore.getState().saveCurrentProject(next.nodes, next.edges, next.currentViewport, next.history);
    if (!target && result.output.references.nodeIds) await focus(result.output.references.nodeIds);
  };
  return <UiModal isOpen title={t('rework.libraryHub.title')} onClose={onClose} widthClassName="w-[min(1080px,calc(100vw-1.5rem))]">
    <UiTabs value={tab} onChange={setTab} aria-label={t('rework.libraryHub.title')} className="max-w-full overflow-x-auto" options={[
      { value: 'materials', label: t('rework.materialLibrary.title'), icon: <Palette className="h-4 w-4" /> },
      { value: 'characters', label: t('characters.title'), icon: <Users className="h-4 w-4" /> },
      { value: 'toolbox', label: t('rework.toolbox.title'), icon: <Boxes className="h-4 w-4" /> },
      { value: 'history', label: t('rework.generationHistory.title'), icon: <FileClock className="h-4 w-4" /> },
      { value: 'knowledge', label: t('rework.knowledge.title'), icon: <NotebookPen className="h-4 w-4" /> },
    ]} />
    <div className="mt-4 h-[min(68vh,740px)] min-h-48"><Suspense fallback={<div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-text-muted"><Loader2 className="h-4 w-4 animate-spin" />{t('common.loading')}</div>}>
      {tab === 'characters' ? <Characters compact onApply={async character => { await focus(await applyCharacterToProject(character, project())); }} />
        : tab === 'materials' ? <Materials compact onUse={applyMaterial} />
          : tab === 'toolbox' ? <Toolbox compact onUse={async template => { await focus(await applyToolboxTemplateToProject(template, project())); }} />
            : tab === 'knowledge' ? <Knowledge />
              : <History compact onJump={source => { requestHistoryNavigation(source); onClose(); }} onReuse={async draft => {
                if (draft.surface === 'canvas') await focus(await reuseCanvasHistoryInProject(draft, project()));
                else { await useWorkbenchStore.getState().initialize(); useWorkbenchStore.getState().setDraft(draft.draft); requestStudioPageNavigation('workbench'); onClose(); }
              }} />}
    </Suspense></div>
  </UiModal>;
}
