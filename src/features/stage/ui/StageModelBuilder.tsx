import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { UiButton, UiConfirm, UiField, UiSelect } from '@/components/ui';
import { useChannelModelGenerationCatalog } from '@/features/channels/application/modelGenerationCatalog';
import { modeParamDefaults } from '@/features/channels/application/modelModes';
import { DeclaredParameters } from '@/features/channels/ui/DeclaredParameters';
import { openSettingsDialog } from '@/features/settings/settingsEvents';
import { createWorkspaceDocument } from '@/features/workbench/application/workspaceDocument';
import type { BlueprintItem } from '@/features/canvas/domain/canvasNodes';
import { generateModelFromImage, recoverModelFromImage, ImageTo3dJobError, type ImageTo3dPhase, type ImageTo3dResult } from '../application/imageTo3d';
import { getImportedModel } from '../application/importedModelLibrary';
import { stageCommands } from '../application/stageCommands';
import type { StageSourceImage } from './StageImagePicker';
import { StageScenePreview } from './StageScenePreview';

const recoverySchema = z.object({ jobId: z.string().optional() });

export function StageModelBuilder({ nodeId, images, onApplied, onBusyChange }: {
  nodeId: string;
  images: StageSourceImage[];
  onApplied(ids: string[]): void;
  onBusyChange(busy: boolean): void;
}) {
  const { t } = useTranslation();
  const catalog = useChannelModelGenerationCatalog();
  const [modelId, setModelId] = useState('');
  const [modeId, setModeId] = useState('');
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [slots, setSlots] = useState<Record<string, string[]>>({});
  const [jobId, setJobId] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<ImageTo3dPhase | null>(null);
  const [result, setResult] = useState<ImageTo3dResult | null>(null);
  const [resultName, setResultName] = useState('');
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState<'generate' | 'new' | null>(null);
  const run = useRef<AbortController | null>(null);
  const recovery = useMemo(() => createWorkspaceDocument(`osc.stage.model-job:${nodeId}`, () => ({ jobId: '' }), (input) => ({ jobId: recoverySchema.parse(input).jobId ?? '' })), [nodeId]);
  useEffect(() => {
    let active = true;
    void recovery.initialize?.().then(() => {
      if (!active) return;
      setJobId(recovery.load().jobId);
      const status = recovery.status();
      if (status.mode === 'memory') setError(t('rework.stage.sceneBuilder.recoveryStorageFailed'));
      else setReady(true);
    });
    return () => { active = false; run.current?.abort(); run.current = null; };
  }, [recovery, t]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  const model = catalog.find((entry) => entry.id === modelId);
  const mode = model?.modes.find((entry) => entry.mode.id === modeId) ?? model?.modes[0];
  const effectiveParams = { ...(mode ? modeParamDefaults(mode) : {}), ...params };
  const imageSlots = mode?.slots.filter((slot) => slot.kind === 'image' && slot.max > 0) ?? [];
  const imageRefs = imageSlots.flatMap((slot) => (slots[slot.key] ?? []).filter((id) => images.some((image) => image.id === id)).map((assetId) => ({ assetId, slot: slot.key })));
  const slotCountsValid = imageSlots.every((slot) => {
    const count = imageRefs.filter((ref) => ref.slot === slot.key).length;
    return count >= (slot.min ?? 0) && count <= slot.max;
  });
  const needsOtherMedia = Boolean(mode?.slots.some((slot) => slot.kind !== 'image' && (slot.min ?? 0) > 0));
  const canGenerate = Boolean(ready && model?.usable && mode && imageRefs.length && slotCountsValid && !needsOtherMedia && !jobId);
  const previewItems = useMemo<BlueprintItem[]>(() => result ? [{ id: 'model-preview', label: resultName, importedModelId: result.importedModelId, category: 'object', color: '#94a3b8', x: 0, y: 0, pos3d: { x: 0, y: 0, z: 0 } }] : [], [result, resultName]);
  const rememberJob = (id: string) => {
    setJobId(id);
    recovery.save({ jobId: id });
    void recovery.flush?.().catch(() => setError(t('rework.stage.sceneBuilder.recoveryStorageFailed')));
  };
  const execute = async (recover: boolean) => {
    if (run.current || (!recover && !canGenerate) || (recover && !jobId)) return;
    const controller = new AbortController(); run.current = controller;
    setBusy(true); setError(''); setNotice(''); setResult(null); setApplied(false);
    const options = {
      signal: controller.signal,
      onProgress: (progress: { phase: ImageTo3dPhase; jobId?: string }) => {
        if (run.current !== controller) return;
        setPhase(progress.phase);
        if (progress.jobId) rememberJob(progress.jobId);
      },
    };
    try {
      const generated = recover ? await recoverModelFromImage(jobId, options) : await generateModelFromImage({
        channelModelRef: model!.channelModelRef, modeId: mode!.mode.id, imageRefs,
        params: z.record(z.string(), z.json()).parse(effectiveParams),
      }, options);
      controller.signal.throwIfAborted();
      const asset = await getImportedModel(generated.importedModelId);
      controller.signal.throwIfAborted();
      if (!asset) throw new Error(t('rework.stage.sceneBuilder.modelMissing'));
      if (run.current === controller) { setResult(generated); setResultName(asset.name); rememberJob(generated.jobId); }
    } catch (cause) {
      if (run.current !== controller) return;
      if (cause instanceof ImageTo3dJobError && cause.jobId) rememberJob(cause.jobId);
      if (controller.signal.aborted) setNotice(t('rework.stage.sceneBuilder.cancelPaidNotice'));
      else setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (run.current === controller) { run.current = null; setBusy(false); } }
  };
  const adopt = () => {
    if (!result || applied) return;
    try {
      const item = { ...previewItems[0], id: crypto.randomUUID() };
      onApplied(stageCommands.execute(nodeId, { type: 'object.add', item }).createdIds);
      setApplied(true); setNotice(t('rework.stage.sceneBuilder.applied'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="space-y-3">
    <p className="text-xs leading-5 text-text-muted">{t('rework.stage.sceneBuilder.modelNotice')}</p>
    <UiField label={t('rework.stage.sceneBuilder.modelChannel')}><UiSelect value={modelId} disabled={busy} onChange={(event) => { setModelId(event.target.value); setModeId(''); setParams({}); setSlots({}); }}>
      <option value="">{t('rework.stage.sceneBuilder.chooseModel')}</option>
      {catalog.map((entry) => <option key={entry.id} value={entry.id} disabled={!entry.usable}>{entry.providerLabel} · {entry.modelLabel}{entry.notReadyReason ? ` — ${entry.notReadyReason}` : ''}</option>)}
    </UiSelect></UiField>
    {!catalog.length && <UiButton size="sm" onClick={() => openSettingsDialog({ category: 'providersAdd' })}>{t('rework.stage.sceneBuilder.configureChannel')}</UiButton>}
    {model && mode && <>
      {model.modes.length > 1 && <UiField label={t('channelModes.mode')}><UiSelect value={mode.mode.id} disabled={busy} onChange={(event) => { setModeId(event.target.value); setParams({}); setSlots({}); }}>{model.modes.map((entry) => <option key={entry.mode.id} value={entry.mode.id}>{entry.mode.label}</option>)}</UiSelect></UiField>}
      {imageSlots.map((slot) => <fieldset key={slot.key} className="space-y-2 rounded-lg border border-[var(--line)] p-2">
        <legend className="px-1 text-xs">{slot.label} · {slot.min ?? 0}–{slot.max}</legend>
        {images.map((image) => {
          const assigned = slots[slot.key] ?? [];
          const checked = assigned.includes(image.id);
          return <label key={image.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={checked} disabled={busy || (!checked && assigned.length >= slot.max)} onChange={(event) => setSlots((current) => ({ ...current, [slot.key]: event.target.checked ? [...assigned, image.id] : assigned.filter((id) => id !== image.id) }))} /><span className="truncate">{image.name}</span></label>;
        })}
      </fieldset>)}
      <DeclaredParameters params={mode.params} values={effectiveParams} onChange={setParams} />
      {needsOtherMedia && <p className="text-xs text-warning">{t('rework.stage.sceneBuilder.otherMediaRequired')}</p>}
    </>}
    {busy && phase && <p role="status" className="text-xs text-text-muted">{t(`rework.stage.sceneBuilder.modelPhases.${phase}`)}</p>}
    {jobId && <div className="space-y-1 text-xs text-text-muted"><p>{t('rework.stage.sceneBuilder.originalJob')}</p><code className="block select-all break-all">{jobId}</code><p>{t('rework.stage.sceneBuilder.recoverNotice')}</p></div>}
    <div className="flex flex-wrap gap-2">
      <UiButton variant="primary" loading={busy} disabled={!canGenerate} onClick={() => setConfirming('generate')}>{t('rework.stage.sceneBuilder.modelGenerate')}</UiButton>
      {jobId && !busy && <><UiButton onClick={() => void execute(true)}>{t('rework.stage.sceneBuilder.recover')}</UiButton><UiButton variant="ghost" onClick={() => setConfirming('new')}>{t('rework.stage.sceneBuilder.newTask')}</UiButton></>}
      {busy && <UiButton onClick={() => run.current?.abort()}>{t('rework.stage.sceneBuilder.stopWaiting')}</UiButton>}
    </div>
    {result && <><StageScenePreview items={previewItems} /><UiButton variant="primary" disabled={applied} onClick={adopt}>{t('rework.stage.sceneBuilder.adopt')}</UiButton></>}
    {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
    {notice && <p role="status" className="text-xs text-text-muted">{notice}</p>}
    <UiConfirm isOpen={confirming !== null} tone="primary" title={t(confirming === 'new' ? 'rework.stage.sceneBuilder.newTask' : 'rework.stage.sceneBuilder.confirmGenerate')} description={t(confirming === 'new' ? 'rework.stage.sceneBuilder.newTaskNotice' : 'rework.stage.sceneBuilder.paidNotice', { model: model?.modelLabel ?? '' })} confirmLabel={t(confirming === 'new' ? 'rework.stage.sceneBuilder.newTask' : 'rework.stage.sceneBuilder.modelGenerate')} onConfirm={() => {
      if (confirming === 'new') { recovery.save({ jobId: '' }); void recovery.flush?.().catch(() => setError(t('rework.stage.sceneBuilder.recoveryStorageFailed'))); setJobId(''); setResult(null); setNotice(''); }
      else void execute(false);
    }} onClose={() => setConfirming(null)} containerClassName="z-[10010]" />
  </div>;
}
