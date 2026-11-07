import { useMemo, useState } from 'react';
import { Check, FolderInput } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiField, UiModal, UiSelect } from '@/components/ui';
import { useProjectStore } from '@/stores/projectStore';
import type { Character } from '@/features/characters/domain/types';
import type { ToolboxTemplate } from '../toolbox/toolbox';
import type { HistoryReuseDraft } from '../history/history';
import { applyCharacterToProject, applyToolboxTemplateToProject, reuseCanvasHistoryInProject } from '../application/projectLibraryActions';

export type LibraryCanvasAction =
  | { kind: 'character'; character: Character }
  | { kind: 'template'; template: ToolboxTemplate }
  | { kind: 'history'; draft: Extract<HistoryReuseDraft, { surface: 'canvas' }> };

/** Explicit destination, no project switch and no generation until the user separately asks for it. */
export function ProjectLibraryDialog({ action, onClose }: { action: LibraryCanvasAction; onClose(): void }) {
  const { t } = useTranslation();
  const projects = useProjectStore(state => state.projects);
  const activeId = useProjectStore(state => state.currentProjectId);
  const sorted = useMemo(() => [...projects].sort((a, b) => b.updatedAt - a.updatedAt), [projects]);
  const [selection, setSelection] = useState(activeId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ projectId: string; name: string; count: number } | null>(null);
  const target = sorted.some(project => project.id === selection) ? selection : sorted[0]?.id ?? '';
  const apply = async () => {
    if (busy || !target || result) return;
    setBusy(true); setError('');
    try {
      const ids = action.kind === 'character' ? await applyCharacterToProject(action.character, target)
        : action.kind === 'template' ? await applyToolboxTemplateToProject(action.template, target)
          : await reuseCanvasHistoryInProject(action.draft, target);
      setResult({ projectId: target, name: sorted.find(project => project.id === target)?.name ?? target, count: ids.length });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <UiModal isOpen title={t(`rework.libraryApply.titles.${action.kind}`)} onClose={() => { if (!busy) onClose(); }} widthClassName="w-[min(460px,calc(100vw-1.5rem))]"
    footer={<><UiButton variant="ghost" disabled={busy} onClick={onClose}>{t(result ? 'common.close' : 'common.cancel')}</UiButton>{result
      ? <UiButton variant="primary" onClick={() => { useProjectStore.getState().openProject(result.projectId); onClose(); }}>{t('rework.mediaDrop.openProject')}</UiButton>
      : <UiButton variant="primary" icon={<FolderInput />} loading={busy} disabled={!target} onClick={() => void apply()}>{t('rework.libraryApply.apply')}</UiButton>}</>}>
    {result ? <p role="status" className="flex items-center gap-2 text-sm text-success"><Check className="h-4 w-4 shrink-0" />{t('rework.mediaDrop.imported', { name: result.name, count: result.count })}</p>
      : <div className="space-y-4"><p className="text-sm leading-6 text-text-muted">{t('rework.libraryApply.description')}</p><UiField label={t('rework.mediaDrop.target')}><UiSelect value={target} disabled={busy || !sorted.length} onChange={event => setSelection(event.target.value)}>{!sorted.length && <option value="">{t('rework.mediaDrop.noProjects')}</option>}{sorted.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</UiSelect></UiField></div>}
    {error && <p role="alert" className="mt-3 break-words text-xs leading-5 text-danger">{error}</p>}
  </UiModal>;
}
