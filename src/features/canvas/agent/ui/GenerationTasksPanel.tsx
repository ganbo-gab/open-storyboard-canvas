import { useCallback, useEffect, useMemo, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import {
  CheckCircle2, Clock3, LocateFixed, RefreshCw, RotateCcw, ShieldAlert, XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { listGenerationJobs, type GenerationJobStatus } from '@/commands/ai';
import { canvasNavigationFacade } from '@/features/canvas/application/canvasNavigationFacade';
import { recoverPersistedGenerationResult } from '@/features/canvas/application/generationRecovery';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

interface Props { nodes: CanvasNode[] }

function statusIcon(status: GenerationJobStatus['status']) {
  if (status === 'succeeded') return <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />;
  if (status === 'failed' || status === 'not_found' || status === 'canceled') return <XCircle className="h-4 w-4 text-red-500" aria-hidden="true" />;
  if (status === 'unknown' || status === 'recoverable_wait') return <ShieldAlert className="h-4 w-4 text-amber-500" aria-hidden="true" />;
  return <Clock3 className="h-4 w-4 text-accent" aria-hidden="true" />;
}

function formatUpdatedAt(value: number | undefined, locale: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Intl.DateTimeFormat(locale, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

/** Contextual generation work only. Diagnostics live in the canvas left rail. */
export function GenerationTasksPanel({ nodes }: Props) {
  const { i18n, t } = useTranslation();
  const [jobs, setJobs] = useState<GenerationJobStatus[]>([]);
  const [confirmJobId, setConfirmJobId] = useState<string | null>(null);
  const [recoveringJobId, setRecoveringJobId] = useState<string | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [isLoading, setLoading] = useState(true);
  const [isRefreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nodeIdsByJobId = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const node of nodes) {
      const data = node.data as Record<string, unknown>;
      for (const jobId of [data.generationJobId, data.generationLastJobId]) {
        if (typeof jobId === 'string' && jobId.trim()) {
          result.set(jobId, [...(result.get(jobId) ?? []), node.id]);
        }
      }
    }
    return result;
  }, [nodes]);

  const refresh = useCallback(async (background = false) => {
    if (!background) setRefreshing(true);
    try {
      setJobs(await listGenerationJobs(50));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
      if (!background) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => void refresh(true), 4_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const locate = useCallback(async (jobId: string) => {
    const nodeIds = nodeIdsByJobId.get(jobId) ?? [];
    if (nodeIds.length) await canvasNavigationFacade.focusNodeIds(nodeIds, { select: true, padding: 0.24 });
  }, [nodeIdsByJobId]);

  const recover = useCallback(async (job: GenerationJobStatus) => {
    if (recoveringJobId) return;
    const nodeIds = nodeIdsByJobId.get(job.job_id) ?? [];
    setRecoveringJobId(job.job_id);
    setConfirmJobId(null);
    setRecoveryStatus((value) => ({ ...value, [job.job_id]: { ok: true, message: t('generationJob.recoveryRunning') } }));
    try {
      await recoverPersistedGenerationResult({ jobId: job.job_id, nodeIds });
      setRecoveryStatus((value) => ({ ...value, [job.job_id]: { ok: true, message: t('generationJob.recoverySucceeded') } }));
      await refresh(true);
    } catch (recoveryError) {
      setRecoveryStatus((value) => ({ ...value, [job.job_id]: { ok: false, message: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) } }));
    } finally {
      setRecoveringJobId(null);
    }
  }, [nodeIdsByJobId, recoveringJobId, refresh, t]);

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={t('canvasAgent.tasks')}>
      <div className="flex min-h-14 shrink-0 items-center justify-between border-b border-border-dark/70 px-4">
        <div>
          <h2 className="text-sm font-semibold text-text-dark">{t('generationJob.taskPanelTitle')}</h2>
          <p className="mt-0.5 text-[11px] text-text-muted">{t(isTauri() ? 'generationJob.desktopPersistenceNotice' : 'generationJob.webPersistenceNotice')}</p>
        </div>
        <button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-text-muted transition-colors duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-40" onClick={() => void refresh(false)} aria-label={t('generationJob.refreshTasks')} title={t('generationJob.refreshTasks')} disabled={isRefreshing}>
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'motion-safe:animate-spin' : ''}`} />
        </button>
      </div>

      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-3" aria-live="polite">
        {error ? <div className="mb-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-600 dark:text-red-300" role="alert">{error}</div> : null}
        {isLoading ? <div className="flex min-h-32 items-center justify-center gap-2 text-xs text-text-muted" role="status"><RefreshCw className="h-4 w-4 motion-safe:animate-spin" />{t('generationJob.loadingTasks')}</div> : jobs.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-text-muted"><Clock3 className="h-6 w-6 opacity-60" /><span className="text-xs leading-5">{t('generationJob.noTasks')}</span></div>
        ) : (
          <div className="space-y-2">{jobs.map((job) => {
            const nodeIds = nodeIdsByJobId.get(job.job_id) ?? [];
            const canLocate = nodeIds.length > 0;
            const canRecover = isTauri() && canLocate && (job.status === 'recoverable_wait' || job.status === 'unknown') && job.resumable !== false && Boolean(job.external_task_id || job.result_url);
            const status = recoveryStatus[job.job_id];
            const isRecovering = recoveringJobId === job.job_id;
            return <article key={job.job_id} className="rounded-xl border border-border-dark/70 bg-surface-dark/55 px-3 py-2.5 transition-colors duration-150 hover:border-border-dark">
              <div className="flex items-start gap-2.5"><div className="mt-0.5 shrink-0">{statusIcon(job.status)}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-semibold text-text-dark">{job.model_id || job.provider_id || t('generationJob.unknownModel')}</span><span className="shrink-0 text-[10px] text-text-muted">{formatUpdatedAt(job.updated_at, i18n.language)}</span></div><div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-text-muted"><span>{t(`generationJob.status.${job.status}`, { defaultValue: job.status })}</span>{job.phase ? <span>{t(`generationJob.phase.${job.phase}`, { defaultValue: job.phase })}</span> : null}{job.network_route ? <span>{t(`generationJob.route.${job.network_route}`)}</span> : null}{canRecover ? <span className="text-amber-600 dark:text-amber-400">{t('generationJob.safeHandle')}</span> : null}</div>{job.error ? <div className="mt-1.5 line-clamp-2 break-words text-[11px] leading-4 text-text-muted" title={job.error}>{job.error}</div> : null}</div>
                <div className="flex shrink-0 gap-1">{canRecover ? <button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-amber-600 transition-colors duration-150 hover:bg-amber-500/10 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60" onClick={() => setConfirmJobId(job.job_id)} disabled={isRecovering} aria-label={t('generationJob.recoverResult')}><RotateCcw className={`h-4 w-4 ${isRecovering ? 'motion-safe:animate-spin' : ''}`} /></button> : null}<button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-text-muted transition-colors duration-150 hover:bg-accent/10 hover:text-accent disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" onClick={() => void locate(job.job_id)} disabled={!canLocate} aria-label={t('generationJob.locateTask')}><LocateFixed className="h-4 w-4" /></button></div>
              </div>
              {confirmJobId === job.job_id ? <div className="mt-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3 text-[11px] leading-5 text-text-dark"><div>{t('generationJob.recoveryConfirm')}</div><div className="mt-2 flex justify-end gap-1.5"><button type="button" className="h-9 rounded-lg px-3 text-text-muted hover:bg-text-dark/[0.05]" onClick={() => setConfirmJobId(null)}>{t('common.cancel')}</button><button type="button" className="h-9 rounded-lg bg-amber-500 px-3 font-medium text-black" onClick={() => void recover(job)}>{t('generationJob.confirmRecovery')}</button></div></div> : null}
              {status ? <div className={`mt-2 text-[11px] leading-4 ${status.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-300'}`} role="status">{status.message}</div> : null}
            </article>;
          })}</div>
        )}
      </div>
    </section>
  );
}
