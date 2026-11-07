import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Copy, FlaskConical, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { UiButton, UiField, UiIconButton, UiInput, UiModal, UiSelect, UiTextArea } from '@/components/ui';
import type { GenerationJobResult, GenerationJobStatus } from '@/commands/ai';
import { AssetPickerDialog, type MediaAssetRecord } from '@/features/assets/ui/AssetPickerDialog';
import { useAssetDisplaySource } from '@/features/assets/ui/useAssetDisplaySource';
import { getAssetPortableSource } from '@/features/assets/application/assetMediaStorage';
import { previewChannel, submitChannelSmoke } from '@/features/channels/application/channelService';
import { channelNativeCountParam, listModelModes, resolveModelModeOrFirst } from '@/features/channels/application/modelModes';
import type { ChannelProfileV2, OperationKind } from '@/features/channels/domain/profile';
import { isPublicReferenceUrl } from '@/features/channels/domain/referenceErrors';
import { validateChannelReferenceUrls } from '@/features/channels/domain/template';
import { getChannelJob, subscribeChannelJob, recoverChannelJob } from '@/features/channels/runtime/channelExecution';
import type { JobInput, JobRef } from '@/features/channels/runtime/types';
import { DeclaredParameters } from '@/features/channels/ui/DeclaredParameters';
import { secretRefFromToken, useCredentialState } from '@/features/secrets/secretStore';

interface Props { profile: ChannelProfileV2; credential: string; onClose(): void }
interface Reference { name: string; ref: JobRef }
interface Choice { id: string; label: string; operation: OperationKind; modeId?: string }
const parametersSchema = z.record(z.string(), z.json());
const mediaMetadataSchema = z.object({ mime: z.string().optional() });
const mediaKindSchema = z.enum(['image', 'video', 'audio']);
const OPERATION_LABEL_KEY: Record<OperationKind, string> = {
  chat: 'chat', 'image.generate': 'imageGenerate', 'image.edit': 'imageEdit', 'video.generate': 'videoGenerate',
  'audio.generate': 'audioGenerate', 'model.generate': 'modelGenerate', 'models.list': 'modelsList',
};

/** A separate, explicitly approved submit. Opening, previewing and closing never submit a job. */
export function ChannelSmokeDialog({ profile, credential, onClose }: Props) {
  const { t } = useTranslation();
  const [modelId, setModelId] = useState('');
  const [choiceId, setChoiceId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [references, setReferences] = useState<Reference[]>([]);
  const [picker, setPicker] = useState(false);
  const [url, setUrl] = useState('');
  const [urlKind, setUrlKind] = useState<JobRef['kind']>('image');
  const [pending, setPending] = useState<JobInput | null>(null);
  const [adding, setAdding] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [record, setRecord] = useState<GenerationJobStatus | null>(null);
  const [jobId, setJobId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const submittedRef = useRef(false);
  const recoveringRef = useRef(false);
  const [recovering, setRecovering] = useState(false);
  const credentialRef = secretRefFromToken(credential);
  const credentialState = useCredentialState(credentialRef);
  const credentialReady = profile.auth.type === 'none' || (credentialRef ? credentialState === 'present' : Boolean(credential.trim()));
  const credentialAlertId = useId();
  const operationLabel = (operation: OperationKind) => t(`rework.channels.operationKinds.${OPERATION_LABEL_KEY[operation]}`);
  const models = useMemo(() => profile.models.filter(entry => (entry.modes?.map(mode => mode.operation) ?? entry.operations).some(operation => operation !== 'models.list')), [profile]);
  const model = models.find(entry => entry.id === modelId) ?? models[0];
  const choices = useMemo<Choice[]>(() => model?.modes
    ? listModelModes(model).filter(mode => mode.operation !== 'models.list').map(mode => ({ id: mode.mode.id, label: mode.mode.label, operation: mode.operation, modeId: mode.mode.id }))
    : (model?.operations ?? []).filter(operation => operation !== 'models.list').map(operation => ({ id: operation, label: operation, operation })), [model]);
  const choice = choices.find(entry => entry.id === choiceId) ?? choices[0];
  const resolved = useMemo(() => model ? resolveModelModeOrFirst(model, choice?.modeId) : null, [model, choice?.modeId]);
  // The durable smoke executor only consumes complete responses; a stream toggle here could never be submitted.
  // A stream default the template still forces surfaces through the service's pre-approval rejection in the preview.
  const declaredParams = useMemo(() => (resolved?.params ?? []).filter(param => !(choice?.operation === 'chat' && param.key === 'stream')), [resolved, choice?.operation]);
  const kinds: JobRef['kind'][] = (['image', 'video', 'audio'] as const).filter(kind => resolved?.slots.some(slot => slot.kind === kind && slot.max > 0));
  const input = useMemo(() => {
    try {
      if (!model || !choice) throw new Error(t('rework.channels.missingModel'));
      if (references.some(entry => !entry.ref.mime.trim())) throw new Error(t('rework.channels.smoke.mimeRequired'));
      const values = parametersSchema.parse(params);
      const countParam = channelNativeCountParam(profile, model.id, choice.modeId);
      const count = countParam ? values[countParam.key] ?? countParam.default : 1;
      const job: JobInput = { jobId: '', channelId: profile.id, modelId: model.id, operation: choice.operation,
        ...(choice.modeId ? { modeId: choice.modeId } : {}), prompt, params: values, refs: references.map(entry => entry.ref), count: typeof count === 'number' ? count : 1 };
      const preview = previewChannel(profile, job);
      validateChannelReferenceUrls(profile, job);
      return { job, preview, error: '' };
    } catch (cause) { return { job: null, preview: null, error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [profile, model, choice, prompt, params, references, t]);

  useEffect(() => {
    if (!jobId) return;
    const unsubscribe = subscribeChannelJob(jobId, setRecord);
    setRecord(getChannelJob(jobId));
    return unsubscribe;
  }, [jobId]);

  const resetModelInput = () => { setParams({}); setReferences([]); setError(''); setPending(null); };
  const addAssets = async (assets: MediaAssetRecord[]) => {
    setAdding(true); setError('');
    try {
      const entries = await Promise.all(assets.map(async asset => {
        const portable = await getAssetPortableSource(asset.source);
        const metadata = mediaMetadataSchema.parse(asset.metadata);
        const mime = /^data:([^;,]+)/.exec(portable)?.[1] ?? metadata.mime ?? 'application/octet-stream';
        return { name: asset.name, ref: { assetId: asset.id, kind: asset.kind, path: asset.source, mime } };
      }));
      setReferences(current => [...current, ...entries]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setAdding(false); }
  };
  const submit = async () => {
    if (!pending || submittedRef.current || !credentialReady) return;
    submittedRef.current = true; setAttempted(true); setSubmitting(true); setError('');
    try { setJobId(await submitChannelSmoke(profile, pending, credential)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSubmitting(false); }
  };
  // Query/materialize the original task only. The dialog's explicitly provided credential takes the
  // runtime's transient replacement path; it is never written into job state or shown.
  const canRecover = Boolean(record?.resumable && (record.status === 'recoverable_wait' || record.status === 'unknown'));
  const recover = async () => {
    if (!jobId || !canRecover || !credentialReady || recoveringRef.current) return;
    recoveringRef.current = true; setRecovering(true); setError('');
    try { setRecord(await recoverChannelJob(jobId, undefined, profile.auth.type === 'none' ? undefined : credential)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { recoveringRef.current = false; setRecovering(false); }
  };
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNotice(t('rework.channels.copied')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return <>
    <UiModal isOpen title={t('rework.channels.smoke.title')} onClose={onClose} widthClassName="w-[min(1000px,calc(100vw-1.5rem))]"
      footer={<><UiButton variant="ghost" onClick={onClose}>{t('common.close')}</UiButton>
        {!attempted && (pending ? <><UiButton onClick={() => setPending(null)}>{t('rework.channels.smoke.back')}</UiButton><UiButton variant="primary" icon={<FlaskConical />} disabled={!credentialReady} onClick={() => void submit()}>{t('rework.channels.smoke.approve')}</UiButton></>
          : <UiButton variant="primary" disabled={!input.job || !credentialReady || adding} onClick={() => { if (input.job) { setPending(structuredClone(input.job)); setError(''); } }}>{t('rework.channels.smoke.review')}</UiButton>)}</>}>
      <div className="space-y-4">
        <p className="rounded-[var(--r-md)] border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-5 text-text-muted">{t('rework.channels.smoke.warning')}</p>
        {!credentialReady && <p id={credentialAlertId} role="alert" className="text-xs text-warning">{t('rework.channels.smoke.credentialUnavailable')}</p>}
        {pending && !attempted && <p role="status" className="text-sm text-text-dark">{t('rework.channels.smoke.approval', { channel: profile.name, model: pending.modelId, operation: operationLabel(pending.operation) })}</p>}
        {!attempted && <div className="grid min-w-0 gap-5 lg:grid-cols-2">
          <fieldset disabled={Boolean(pending) || adding} className="min-w-0 space-y-3 disabled:opacity-70">
            <UiField label={t('rework.model')}><UiSelect value={model?.id ?? ''} onChange={event => { setModelId(event.target.value); setChoiceId(''); resetModelInput(); }}>{models.map(entry => <option key={entry.id} value={entry.id}>{entry.id}</option>)}</UiSelect></UiField>
            <UiField label={t('rework.channels.operation')}><UiSelect value={choice?.id ?? ''} onChange={event => { setChoiceId(event.target.value); resetModelInput(); }}>{choices.map(entry => <option key={entry.id} value={entry.id}>{entry.modeId ? `${entry.label} · ${operationLabel(entry.operation)}` : operationLabel(entry.operation)}</option>)}</UiSelect></UiField>
            <UiField label={t('rework.channels.samplePrompt')}><UiTextArea value={prompt} onChange={event => setPrompt(event.target.value)} className="min-h-24" /></UiField>
            <DeclaredParameters params={declaredParams} values={params} onChange={setParams} />
            {kinds.length > 0 && <div className="space-y-2 border-t border-[var(--line)] pt-3">
              <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-medium">{t('rework.channels.smoke.references')}</h3><UiButton size="sm" icon={<Plus />} onClick={() => setPicker(true)}>{t('rework.assets')}</UiButton></div>
              <div className="flex flex-wrap gap-2"><UiSelect aria-label={t('rework.channels.smoke.referenceKind')} value={kinds.includes(urlKind) ? urlKind : kinds[0]} onChange={event => setUrlKind(mediaKindSchema.parse(event.target.value))}>{kinds.map(kind => <option key={kind} value={kind}>{t(`rework.${kind}`)}</option>)}</UiSelect><UiInput aria-label={t('rework.channels.smoke.publicUrl')} placeholder={t('rework.channels.smoke.publicUrl')} value={url} onChange={event => setUrl(event.target.value)} className="min-w-40 flex-1" /><UiButton size="sm" disabled={!url.trim()} onClick={() => {
                const source = url.trim();
                if (!isPublicReferenceUrl(source)) { setError(t('rework.channels.smoke.invalidUrl')); return; }
                const kind = kinds.includes(urlKind) ? urlKind : kinds[0];
                if (!kind) return;
                setReferences(current => [...current, { name: source, ref: { kind, assetId: crypto.randomUUID(), path: source, mime: 'application/octet-stream' } }]); setUrl('');
              }}>{t('rework.channels.smoke.addReference')}</UiButton></div>
              {references.map((entry, index) => <div key={`${entry.ref.assetId}-${index}`} className="space-y-2 rounded-[var(--r-md)] border border-[var(--line)] p-2">
                <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs" title={entry.name}>{index + 1}. {entry.name}</span><UiIconButton size="sm" aria-label={t('rework.channels.smoke.removeReference')} onClick={() => setReferences(current => current.filter((_, position) => position !== index))}><Trash2 /></UiIconButton></div>
                {model?.modes && <UiField label={t('rework.channels.smoke.slot')}><UiSelect value={entry.ref.slot ?? ''} onChange={event => setReferences(current => current.map((item, position) => position === index ? { ...item, ref: { ...item.ref, slot: event.target.value || undefined } } : item))}><option value="">{t('rework.channels.smoke.unassigned')}</option>{resolved?.slots.filter(slot => slot.kind === entry.ref.kind).map(slot => <option key={slot.key} value={slot.key}>{slot.label} · {slot.min ?? 0}–{slot.max}</option>)}</UiSelect></UiField>}
                <UiField label="MIME"><UiInput value={entry.ref.mime} onChange={event => setReferences(current => current.map((item, position) => position === index ? { ...item, ref: { ...item.ref, mime: event.target.value } } : item))} /></UiField>
              </div>)}
            </div>}
          </fieldset>
          <div className="min-w-0 space-y-2"><h3 className="text-xs font-semibold">{t('rework.channels.review')}</h3><p className="text-[11px] leading-5 text-text-muted">{t('rework.channels.smoke.previewHint')}</p><pre className="ui-scrollbar max-h-[480px] overflow-auto whitespace-pre-wrap break-all rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--field-bg)] p-3 text-[11px] leading-5 text-text-muted">{input.preview ? JSON.stringify(input.preview, null, 2) : input.error}</pre></div>
        </div>}
        {attempted && <div className="space-y-3" aria-live="polite">
          <p className="text-sm font-medium">{record ? t(`rework.channels.smoke.status.${record.status}`) : t(submitting ? 'rework.channels.smoke.submitting' : 'rework.channels.smoke.noJob')}</p>
          {jobId && <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-[11px] text-text-muted">{jobId}</code><UiIconButton aria-label={t('rework.channels.smoke.copyJob')} onClick={() => void copy(jobId)}><Copy /></UiIconButton></div>}
          {record && <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-text-muted"><dt>{t('rework.channels.smoke.phase')}</dt><dd>{record.phase ? t(`rework.channels.smoke.phases.${record.phase}`, { defaultValue: record.phase }) : '—'}</dd><dt>{t('rework.channels.smoke.upstreamTask')}</dt><dd className="break-all">{record.external_task_id ?? '—'}</dd><dt>{t('rework.channels.smoke.category')}</dt><dd>{record.error_category ? t(`rework.channels.smoke.categories.${record.error_category}`, { defaultValue: record.error_category }) : '—'}</dd><dt>HTTP</dt><dd>{record.error_status ?? '—'}</dd></dl>}
          {record?.error && <p role="alert" className="whitespace-pre-wrap break-words text-xs leading-5 text-danger">{record.error_raw ? record.error.split('\n')[0] : record.error}</p>}
          {record?.error_raw && <details><summary className="cursor-pointer text-xs text-text-muted">{t('rework.channels.smoke.upstreamDiagnostic')}</summary><pre className="ui-scrollbar mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-text-muted">{record.error_raw}</pre></details>}
          {canRecover && <UiButton loading={recovering} disabled={!credentialReady} aria-describedby={credentialReady ? undefined : credentialAlertId} onClick={() => void recover()}>{t('rework.channels.smoke.recover')}</UiButton>}
          {record?.results?.map((result, index) => <SmokeResult key={`${index}-${result.kind}`} result={result} />)}
          <p className="text-xs leading-5 text-text-muted">{t('rework.channels.smoke.closeHint')}</p>
        </div>}
        {notice && <p role="status" className="text-xs text-success">{notice}</p>}
        {error && <p role="alert" className="whitespace-pre-wrap text-xs text-danger">{error}</p>}
      </div>
    </UiModal>
    {picker && <AssetPickerDialog title={t('rework.channels.smoke.references')} confirmLabel={t('common.confirm')} accept={kinds} onPick={assets => void addAssets(assets)} onClose={() => setPicker(false)} />}
  </>;
}

function SmokeResult({ result }: { result: GenerationJobResult }) {
  const { t } = useTranslation();
  const media = result.kind !== 'text' && result.kind !== 'model';
  const { url, error } = useAssetDisplaySource(media ? result.source : null);
  if (result.kind === 'text') return <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-[var(--r-md)] border border-[var(--line)] p-3 text-xs leading-6">{result.source}</pre>;
  if (result.kind === 'model') return <p className="break-all text-xs text-text-muted">{t('rework.channels.smoke.modelImported', { id: result.importedModelId ?? result.source })}</p>;
  if (error) return <p role="alert" className="text-xs text-danger">{error}</p>;
  if (!url) return <p className="text-xs text-text-muted">{t('common.loading')}</p>;
  if (result.kind === 'image') return <img src={url} alt={t('rework.channels.smoke.result')} className="max-h-80 max-w-full rounded-[var(--r-md)] object-contain" />;
  if (result.kind === 'video') return <video src={url} controls preload="metadata" className="max-h-80 max-w-full rounded-[var(--r-md)]" />;
  return <audio src={url} controls preload="metadata" className="w-full" />;
}
