import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiConfirm, UiField, UiSelect, UiTextArea } from '@/components/ui';
import { useChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import type { BlueprintItem } from '@/features/canvas/domain/canvasNodes';
import { pos3dToLegacy } from '@/features/canvas/ui/blueprintCoordinates';
import { openSettingsDialog } from '@/features/settings/settingsEvents';
import { stageCommands, type StageSceneDraft } from '../application/stageCommands';
import type { StageSourceImage } from './StageImagePicker';
import { StageScenePreview } from './StageScenePreview';

type DraftPart = 'objects' | 'people' | 'camera';
const PARTS: DraftPart[] = ['objects', 'people', 'camera'];

export function StageDraftBuilder({ nodeId, images, onApplied, onBusyChange }: {
  nodeId: string;
  images: StageSourceImage[];
  onApplied(ids: string[]): void;
  onBusyChange(busy: boolean): void;
}) {
  const { t } = useTranslation();
  const catalog = useChatModelCatalog();
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [draft, setDraft] = useState<StageSceneDraft | null>(null);
  const [include, setInclude] = useState<DraftPart[]>(PARTS);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const run = useRef<AbortController | null>(null);
  useEffect(() => () => { run.current?.abort(); run.current = null; }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  const model = catalog.find((entry) => entry.id === modelId);
  const canGenerate = Boolean(model?.usable && (!images.length || model.supportsMultimodal) && images.length <= 3 && (prompt.trim() || images.length));
  const previewItems = useMemo<BlueprintItem[]>(() => (draft?.objects ?? []).filter((entry) => include.includes(entry.category === 'person' ? 'people' : 'objects')).map((entry, index) => ({
    id: `draft-preview-${index}`, label: entry.label, category: entry.category, presetId: entry.presetId, color: '#94a3b8',
    pos3d: entry.position, rotation3d: entry.rotation, scale3d: entry.scale, action: entry.action, ...pos3dToLegacy(entry.position),
  })), [draft, include]);
  const generate = async () => {
    if (run.current || !canGenerate) return;
    const controller = new AbortController(); run.current = controller;
    setBusy(true); setError(''); setNotice(''); setDraft(null);
    try {
      const result = await stageCommands.draftScene({ modelId, prompt, images: images.map((image) => image.id) }, controller.signal);
      controller.signal.throwIfAborted();
      if (run.current === controller) setDraft(result);
    } catch (cause) {
      if (run.current === controller) {
        if (controller.signal.aborted) setNotice(t('rework.stage.sceneBuilder.cancelPaidNotice'));
        else setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally { if (run.current === controller) { run.current = null; setBusy(false); } }
  };
  const adopt = () => {
    if (!draft || !include.length) return;
    try {
      const result = stageCommands.applyDraft(nodeId, draft, include);
      onApplied(result.createdIds);
      setDraft(null); setNotice(t('rework.stage.sceneBuilder.applied'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="space-y-3">
    <p className="text-xs leading-5 text-text-muted">{t('rework.stage.sceneBuilder.draftNotice')}</p>
    <UiField label={t('rework.stage.sceneBuilder.visionModel')}><UiSelect value={modelId} onChange={(event) => setModelId(event.target.value)}>
      <option value="">{t('rework.stage.sceneBuilder.chooseModel')}</option>
      {catalog.map((entry) => <option key={entry.id} value={entry.id} disabled={!entry.usable || (images.length > 0 && !entry.supportsMultimodal)}>{entry.providerLabel} · {entry.modelLabel}{!entry.usable ? ` — ${entry.notReadyReason ?? t('rework.stage.sceneBuilder.unavailable')}` : ''}</option>)}
    </UiSelect></UiField>
    {!catalog.length && <UiButton size="sm" onClick={() => openSettingsDialog({ category: 'providersAdd' })}>{t('rework.stage.sceneBuilder.configureChannel')}</UiButton>}
    <UiTextArea rows={3} maxLength={10000} aria-label={t('rework.stage.sceneBuilder.description')} placeholder={t('rework.stage.sceneBuilder.descriptionHint')} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
    {images.length > 3 && <p className="text-xs text-warning">{t('rework.stage.sceneBuilder.maxThreeImages')}</p>}
    <div className="flex flex-wrap gap-2">
      <UiButton variant="primary" loading={busy} disabled={!canGenerate} onClick={() => setConfirming(true)}>{t('rework.stage.sceneBuilder.draftGenerate')}</UiButton>
      {busy && <UiButton onClick={() => run.current?.abort()}>{t('rework.stage.sceneBuilder.stopWaiting')}</UiButton>}
    </div>
    {busy && <p role="status" className="text-xs text-text-muted">{t('rework.stage.sceneBuilder.drafting')}</p>}
    {draft && <section className="space-y-3 border-t border-[var(--line)] pt-3">
      <p className="text-xs leading-5">{draft.description}</p>
      <div className="flex flex-wrap gap-3">{PARTS.map((part) => <label key={part} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={include.includes(part)} onChange={(event) => setInclude(event.target.checked ? [...include, part] : include.filter((entry) => entry !== part))} />{t(`rework.stage.sceneBuilder.parts.${part}`)}</label>)}</div>
      {previewItems.length > 0 && <StageScenePreview items={previewItems} />}
      <ul className="space-y-1 text-xs text-text-muted">{draft.objects.map((entry, index) => <li key={index}>{entry.label} · {entry.presetId}</li>)}</ul>
      {draft.camera && <p className="text-xs text-text-muted">{t('rework.stage.sceneBuilder.cameraSummary', { height: draft.camera.position.y.toFixed(2), fov: draft.camera.fov.toFixed(1) })}</p>}
      {draft.estimation && <div className="space-y-1 rounded-lg border border-warning/20 p-2 text-xs leading-5 text-warning">
        {draft.estimation.scaleReference && <p>{draft.estimation.scaleReference}</p>}
        {draft.estimation.uncertainty.map((note, index) => <p key={index}>{note}</p>)}
      </div>}
      <UiButton variant="primary" disabled={!include.length} onClick={adopt}>{t('rework.stage.sceneBuilder.adopt')}</UiButton>
    </section>}
    {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
    {notice && <p role="status" className="text-xs text-text-muted">{notice}</p>}
    <UiConfirm isOpen={confirming} tone="primary" title={t('rework.stage.sceneBuilder.confirmGenerate')} description={t('rework.stage.sceneBuilder.paidNotice', { model: model?.modelLabel ?? '' })} confirmLabel={t('rework.stage.sceneBuilder.draftGenerate')} onConfirm={() => void generate()} onClose={() => setConfirming(false)} containerClassName="z-[10010]" />
  </div>;
}
