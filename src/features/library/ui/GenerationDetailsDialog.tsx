import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { ArrowUpRight, Copy, FileClock, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiModal } from '@/components/ui';
import { AssetMedia } from '@/features/assets/ui/AssetMedia';
import { openMediaViewer } from '@/features/viewer/viewerStore';
import { requestHistoryNavigation } from '@/features/studio/studioNavigation';
import { useWorkbenchStore } from '@/features/workbench/store/workbenchStore';
import { recoverPersistedGenerationResult } from '@/features/canvas/application/generationRecovery';
import { useCanvasStore } from '@/stores/canvasStore';
import { loadGenerationDetails, type GenerationDetailsTarget, type GenerationDetailData } from '../application/generationDetails';

// Dialog ownership only; every fact is projected from existing task/history stores.
const useDetailsDialog = create<{ target: GenerationDetailsTarget | null }>(() => ({ target: null }));
export function openGenerationDetails(target: GenerationDetailsTarget): void { useDetailsDialog.setState({ target: { ...target } }); }
export function closeGenerationDetails(): void { useDetailsDialog.setState({ target: null }); }
export function GenerationDetailsHost() {
  const target = useDetailsDialog((state) => state.target);
  return target ? <GenerationDetailsDialog target={target} onClose={closeGenerationDetails} /> : null;
}

export function GenerationDetailsDialog({ target, onClose }: { target: GenerationDetailsTarget; onClose(): void }) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<GenerationDetailData | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [revision, refresh] = useState(0); const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let canceled = false; setData(null); setError('');
    void loadGenerationDetails(target).then((result) => { if (!canceled) setData(result); }, (cause: unknown) => { if (!canceled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { canceled = true; };
  }, [target, revision]);
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setNotice(t('ui.details.copied')); }
    catch { setError(t('ui.details.copyFailed')); }
  };
  const value = (key: string, original?: string | number | null) => {
    if (key === 'currentProject' && original === null) return t('ui.details.unassignedProject');
    if (original === undefined || original === null || original === '') return t('ui.details.notRecorded');
    if ((key === 'submittedAt' || key === 'updatedAt') && typeof original === 'number') return new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'medium' }).format(original);
    if (key === 'status') return t(`generationJob.status.${original}`, { defaultValue: String(original) });
    if (key === 'source') return t(`rework.generationHistory.surfaces.${original}`, { defaultValue: String(original) });
    if (key === 'phase') return t(`ui.details.phases.${original}`, { defaultValue: String(original) });
    if (key === 'duration') return `${original}s`;
    return String(original);
  };
  const recover = async (jobId: string) => {
    if (busy) return; setBusy(jobId); setError('');
    try {
      const task = data?.record?.taskId ? useWorkbenchStore.getState().tasks[data.record.taskId] : undefined;
      if (task?.jobId === jobId) await useWorkbenchStore.getState().recoverResult(task.id);
      else {
        const nodes = useCanvasStore.getState().nodes.filter((node) => node.data.generationJobId === jobId || node.data.generationLastJobId === jobId);
        await recoverPersistedGenerationResult({ jobId, nodeIds: nodes.map((node) => node.id) });
      }
      setNotice(t('ui.details.queried')); refresh((current) => current + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  const openResult = (index: number) => {
    const selected = data?.outputs[index]; if (!selected || selected.kind === 'text' || selected.kind === 'model') return;
    const media = data!.outputs.filter((output) => output.kind === 'image' || output.kind === 'video' || output.kind === 'audio');
    const entries = media.flatMap((output, outputIndex) => output.kind === 'text' || output.kind === 'model' ? [] : [{ id: `${outputIndex}`, kind: output.kind, source: output.source, title: t('ui.details.resultNumber', { number: outputIndex + 1 }), prompt: data?.prompt }]);
    openMediaViewer(entries, media.findIndex((output) => output.source === selected.source));
  };
  return <UiModal isOpen title={t('ui.details.title')} onClose={onClose} containerClassName="z-[8800]" widthClassName="w-[min(940px,calc(100vw-3rem))]"
    footer={<><UiButton variant="ghost" icon={<Copy />} disabled={!data} onClick={() => data && void copy(data.diagnostics)}>{t('ui.details.copyDiagnostics')}</UiButton><UiButton variant="primary" icon={<ArrowUpRight />} disabled={!data || data.source.surface === 'unavailable'} onClick={() => { if (data?.source.surface !== 'unavailable' && data) { requestHistoryNavigation(data.source); onClose(); } }}>{t('ui.details.locateSource')}</UiButton></>}>
    <div className="space-y-5">
      {error ? <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm text-danger">{error}</p> : null}
      {notice ? <p role="status" className="text-xs text-success">{notice}</p> : null}
      {!data ? <p role="status" className="py-10 text-center text-text-muted">{t('common.loading')}</p> : <>
        <p className="text-xs leading-5 text-text-subtle">{t('ui.details.evidenceOnly')}</p>
        {data.records.length > 1 ? <label className="flex items-center gap-3 text-sm text-text-muted"><FileClock className="h-4 w-4" />{t('ui.details.attempt')}<select className="ui-input min-w-0 flex-1" value={data.record?.id ?? ''} onChange={(event) => openGenerationDetails({ ...target, recordId: event.target.value, jobId: undefined })}>{data.records.map((record) => <option key={record.id} value={record.id}>{new Date(record.createdAt).toLocaleString(i18n.language)} · {record.modelRef} · {t(`generationJob.status.${record.status}`, { defaultValue: record.status })}</option>)}</select></label> : null}
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-xl bg-raised p-4">{data.facts.map((fact) => <div key={fact.key} className="flex min-w-0 gap-4 text-sm"><dt className="w-24 shrink-0 text-text-subtle">{t(`ui.details.fields.${fact.key}`)}</dt><dd className={`min-w-0 flex-1 break-words ${fact.value === undefined ? 'text-text-subtle' : 'text-text'}`}>{value(fact.key, fact.value)}</dd></div>)}</dl>
        <section className="space-y-2"><div className="flex items-center justify-between"><h3 className="text-sm font-medium">{t('ui.details.prompt')}</h3><UiButton size="sm" variant="ghost" disabled={!data.prompt} onClick={() => data.prompt && void copy(data.prompt)}><Copy className="h-3.5 w-3.5" />{t('ui.details.copy')}</UiButton></div><p className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-line p-3 text-sm leading-6">{data.prompt || t('ui.details.notRecorded')}</p></section>
        <section className="space-y-2"><h3 className="text-sm font-medium">{t('ui.details.upstreamPrompt')}</h3><p className="max-h-40 overflow-auto whitespace-pre-wrap text-sm leading-6 text-text-muted">{data.upstreamPrompt || t('ui.details.upstreamMissing')}</p></section>
        <section className="space-y-2"><h3 className="text-sm font-medium">{t('ui.details.tasks')}</h3>{data.jobs.length ? data.jobs.map((job) => {
          const task = data.record?.taskId ? useWorkbenchStore.getState().tasks[data.record.taskId] : undefined;
          const onCanvas = useCanvasStore.getState().nodes.some((node) => node.data.generationJobId === job.job_id || node.data.generationLastJobId === job.job_id);
          const recoverable = (job.resumable || job.local_result_missing) && (task?.jobId === job.job_id || onCanvas);
          return <div key={job.job_id} className="rounded-xl border border-line p-3"><div className="flex items-center justify-between gap-3"><span className="text-sm">{value('status', job.status)}</span>{recoverable ? <UiButton size="sm" disabled={Boolean(busy)} loading={busy === job.job_id} icon={<RotateCcw />} onClick={() => void recover(job.job_id)}>{t('ui.details.retrieve')}</UiButton> : null}</div><dl className="mt-2 space-y-1 text-xs text-text-muted"><div className="flex gap-3"><dt className="shrink-0">{t('ui.details.localTask')}</dt><dd className="break-all">{job.job_id}</dd></div><div className="flex gap-3"><dt className="shrink-0">{t('ui.details.upstreamTask')}</dt><dd className="break-all">{job.external_task_id || t('ui.details.notRecorded')}</dd></div></dl>{recoverable ? <p className="mt-2 text-xs text-text-subtle">{t('ui.details.retrieveHint')}</p> : null}</div>;
        }) : <p className="text-sm text-text-subtle">{t('ui.details.noTask')}</p>}</section>
        {data.errors.length ? <section className="space-y-2"><h3 className="text-sm font-medium text-danger">{t('ui.details.errors')}</h3>{data.errors.map((message, index) => <p key={index} className="whitespace-pre-wrap rounded-lg bg-danger/10 p-3 text-xs leading-5 text-danger">{message}</p>)}</section> : null}
        <section className="space-y-2"><h3 className="text-sm font-medium">{t('ui.details.results')}</h3>{data.outputs.length ? <div className="grid grid-cols-3 gap-3">{data.outputs.map((output, index) => output.kind === 'text' ? <pre key={index} className="max-h-52 overflow-auto whitespace-pre-wrap rounded-xl bg-raised p-3 text-xs">{output.source}</pre> : output.kind === 'model' ? <div key={index} className="rounded-xl bg-raised p-4 text-xs text-text-muted">{t('ui.details.modelResult')}</div> : <button key={index} type="button" className="overflow-hidden rounded-xl border border-line bg-raised text-left" onClick={() => openResult(index)}><AssetMedia source={output.source} kind={output.kind} className="aspect-video w-full object-contain" /><span className="block p-2 text-xs">{t('ui.details.resultNumber', { number: index + 1 })}</span></button>)}</div> : <p className="text-sm text-text-subtle">{t('ui.details.noResult')}</p>}</section>
        <details className="rounded-xl border border-line p-3"><summary className="cursor-pointer text-xs text-text-muted">{t('ui.details.raw')}</summary><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs leading-5 text-text-subtle">{data.diagnostics}</pre></details>
      </>}
    </div>
  </UiModal>;
}
