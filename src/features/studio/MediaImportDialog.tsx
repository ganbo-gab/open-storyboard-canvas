import { useMemo, useState } from 'react';
import { Check, FolderInput } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiField, UiModal, UiSelect } from '@/components/ui';
import { useProjectStore } from '@/stores/projectStore';
import type { StudioMediaDrag } from './mediaDrag';
import { importStudioMedia } from './importStudioMedia';

/** Dropping media on 项目 picks a destination (most recent first) without opening or switching projects. */
export function MediaImportDialog({ payload, onClose }: { payload: StudioMediaDrag; onClose(): void }) {
  const { t } = useTranslation();
  const projects = useProjectStore((state) => state.projects);
  const sorted = useMemo(() => [...projects].sort((a, b) => b.updatedAt - a.updatedAt), [projects]);
  const [selection, setSelection] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [imported, setImported] = useState<{ id: string; name: string; count: number } | null>(null);
  const target = sorted.some((project) => project.id === selection) ? selection : sorted[0]?.id ?? '';
  const count = payload.kind === 'asset' ? payload.assetIds.length : 1;
  const submit = async () => {
    if (busy || !target || imported) return;
    setBusy(true); setError('');
    try {
      const nodeIds = await importStudioMedia(payload, target);
      setImported({ id: target, name: sorted.find((project) => project.id === target)?.name ?? target, count: nodeIds.length });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return (
    <UiModal
      isOpen
      title={t('rework.mediaDrop.title', { count })}
      onClose={() => { if (!busy) onClose(); }}
      widthClassName="w-[min(440px,calc(100vw-1.5rem))]"
      footer={<>
        <UiButton variant="ghost" disabled={busy} onClick={onClose}>{t(imported ? 'common.close' : 'common.cancel')}</UiButton>
        {imported
          ? <UiButton variant="primary" onClick={() => { useProjectStore.getState().openProject(imported.id); onClose(); }}>{t('rework.mediaDrop.openProject')}</UiButton>
          : <UiButton variant="primary" loading={busy} disabled={!target} icon={<FolderInput />} onClick={() => void submit()}>{t('rework.mediaDrop.import')}</UiButton>}
      </>}
    >
      {imported
        ? <p role="status" className="flex items-center gap-2 text-sm text-success"><Check className="h-4 w-4 shrink-0" />{t('rework.mediaDrop.imported', { name: imported.name, count: imported.count })}</p>
        : (
          <div className="space-y-4" aria-busy={busy}>
            <p className="text-sm leading-6 text-text-muted">{t('rework.mediaDrop.description')}</p>
            <UiField label={t('rework.mediaDrop.target')}>
              <UiSelect aria-label={t('rework.mediaDrop.target')} value={target} disabled={busy || !sorted.length} onChange={(event) => { setSelection(event.target.value); setError(''); }}>
                {!sorted.length && <option value="">{t('rework.mediaDrop.noProjects')}</option>}
                {sorted.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </UiSelect>
            </UiField>
          </div>
        )}
      {error && <p role="alert" className="mt-3 break-words text-xs leading-5 text-danger">{error}</p>}
    </UiModal>
  );
}
