import { useState } from 'react';
import { Boxes, FileClock, Palette } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiTabs } from '@/components/ui';
import { useWorkbenchStore } from '@/features/workbench/store/workbenchStore';
import { requestHistoryNavigation } from '@/features/studio/studioNavigation';
import { applyMaterialToPrompt } from '../materials/materials';
import type { HistoryReuseDraft } from '../history/history';
import { MaterialLibraryPage } from './MaterialLibraryPage';
import { ToolboxPage } from './ToolboxPage';
import { GenerationHistoryPage } from './GenerationHistoryPage';
import { ProjectLibraryDialog } from './ProjectLibraryDialog';

type LibraryTab = 'materials' | 'toolbox' | 'history';

export function LibraryHubPage({ onWorkbench }: { onWorkbench(): void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<LibraryTab>('materials');
  const [reuse, setReuse] = useState<Extract<HistoryReuseDraft, { surface: 'canvas' }> | null>(null);
  const reuseDraft = async (draft: HistoryReuseDraft) => {
    if (draft.surface === 'canvas') { setReuse(draft); return; }
    await useWorkbenchStore.getState().initialize();
    useWorkbenchStore.getState().setDraft(draft.draft);
    onWorkbench();
  };
  return <div className="flex h-full min-h-0 flex-col">
    <div className="shrink-0 border-b border-[var(--line)] px-6 pb-3 pt-5 sm:px-10"><UiTabs value={tab} onChange={setTab} aria-label={t('rework.libraryHub.title')} options={[
      { value: 'materials', label: t('rework.materialLibrary.title'), icon: <Palette className="h-4 w-4" /> },
      { value: 'toolbox', label: t('rework.toolbox.title'), icon: <Boxes className="h-4 w-4" /> },
      { value: 'history', label: t('rework.generationHistory.title'), icon: <FileClock className="h-4 w-4" /> },
    ]} /></div>
    <div className="min-h-0 flex-1">
      {tab === 'materials' ? <MaterialLibraryPage onUse={entry => {
        const store = useWorkbenchStore.getState();
        store.setDraft({ prompt: applyMaterialToPrompt(store.draft.prompt, entry), ...(entry.kind === 'effect' || entry.kind === 'cameraMotion' ? { kind: 'video' as const } : {}) });
        onWorkbench();
      }} /> : tab === 'toolbox' ? <ToolboxPage /> : <GenerationHistoryPage onJump={requestHistoryNavigation} onReuse={reuseDraft} />}
    </div>
    {reuse && <ProjectLibraryDialog action={{ kind: 'history', draft: reuse }} onClose={() => setReuse(null)} />}
  </div>;
}
