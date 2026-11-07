import { useCallback, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton, UiSegmented } from '@/components/ui';
import { StageImagePicker, type StageSourceImage } from './StageImagePicker';
import { StageReliefBuilder } from './StageReliefBuilder';
import { StageDraftBuilder } from './StageDraftBuilder';
import { StageModelBuilder } from './StageModelBuilder';

type Tier = 'draft' | 'relief' | 'model';

/** Persistent, non-modal tool: hiding the panel never interrupts a job or blocks stage editing. */
export function StageSceneBuilder({ open, nodeId, projectId, onClose, onOpen, onApplied }: {
  open: boolean;
  nodeId: string;
  projectId?: string;
  onClose(): void;
  onOpen(): void;
  onApplied(ids: string[]): void;
}) {
  const { t } = useTranslation();
  const [tier, setTier] = useState<Tier>('relief');
  const [images, setImages] = useState<StageSourceImage[]>([]);
  const [busy, setBusy] = useState({ draft: false, relief: false, model: false });
  const draftBusy = useCallback((value: boolean) => setBusy((current) => current.draft === value ? current : { ...current, draft: value }), []);
  const reliefBusy = useCallback((value: boolean) => setBusy((current) => current.relief === value ? current : { ...current, relief: value }), []);
  const modelBusy = useCallback((value: boolean) => setBusy((current) => current.model === value ? current : { ...current, model: value }), []);
  const running = busy.draft || busy.relief || busy.model;
  return <>
    {!open && running && <div className="stage-glass absolute left-[68px] top-3 z-30 flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-text-muted" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('rework.stage.sceneBuilder.background')}<UiButton size="sm" variant="ghost" onClick={onOpen}>{t('rework.stage.sceneBuilder.viewTask')}</UiButton></div>}
    <aside hidden={!open} className="stage-glass stage-pop absolute bottom-3 left-[68px] top-3 z-[35] w-[344px] max-w-[calc(100%-80px)] flex-col overflow-hidden rounded-2xl text-text-dark" style={{ display: open ? 'flex' : 'none' }} aria-label={t('rework.stage.sceneBuilder.title')}>
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 pl-4 pr-2"><h3 className="text-[13px] font-semibold">{t('rework.stage.sceneBuilder.title')}</h3><UiIconButton size="sm" aria-label={t('common.close')} onClick={onClose}><X /></UiIconButton></header>
      <div className="ui-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        <UiSegmented size="sm" value={tier} aria-label={t('rework.stage.sceneBuilder.method')} options={[
          { value: 'draft', label: t('rework.stage.sceneBuilder.tiers.draft') },
          { value: 'relief', label: t('rework.stage.sceneBuilder.tiers.relief') },
          { value: 'model', label: t('rework.stage.sceneBuilder.tiers.model') },
        ]} onChange={(next) => { if (next === 'draft' || next === 'relief' || next === 'model') setTier(next); }} />
        <StageImagePicker open={open} value={images} onChange={setImages} />
        <div hidden={tier !== 'draft'}><StageDraftBuilder nodeId={nodeId} images={images} onApplied={onApplied} onBusyChange={draftBusy} /></div>
        <div hidden={tier !== 'relief'}><StageReliefBuilder nodeId={nodeId} projectId={projectId} images={images} onApplied={onApplied} onBusyChange={reliefBusy} /></div>
        <div hidden={tier !== 'model'}><StageModelBuilder nodeId={nodeId} images={images} onApplied={onApplied} onBusyChange={modelBusy} /></div>
      </div>
    </aside>
  </>;
}
