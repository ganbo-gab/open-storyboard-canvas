import { useCallback, useEffect, useMemo, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import {
  CheckCircle2, Clock3, LocateFixed, RefreshCw, RotateCcw, ShieldAlert, XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { listGenerationJobs, type GenerationJobStatus } from '@/commands/ai';
import { UiButton, UiIconButton } from '@/components/ui';
import { canvasNavigationFacade } from '@/features/canvas/application/canvasNavigationFacade';
import { recoverPersistedGenerationResult } from '@/features/canvas/application/generationRecovery';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

interface Props { nodes: CanvasNode[] }

function statusIcon(status: GenerationJobStatus['status']) {
  if (status === 'succeeded') return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />;
  if (status === 'failed' || status === 'not_found' || status === 'canceled') return <XCircle className="h-4 w-4 text-danger" aria-hidden="true" />;
  if (status === 'unknown' || status === 'recoverable_wait') return <ShieldAlert className="h-4 w-4 text-warning" aria-hidden="true" />;
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
      <div className="flex min-h-14 shrink-0 items-center justify-between border-b border-[var(--line)] px-4">
        <div>
          <h2 className="text-sm font-semibold text-text-dark">{t('generationJob.taskPanelTitle')}</h2>
          <p className="mt-0.5 text-[11px] text-text-muted">{t(isTauri() ? 'generationJob.desktopPersistenceNotice' : 'generationJob.webPersistenceNotice')}</p>
        </div>
        <UiIconButton size="lg" onClick={() => void refresh(false)} aria-label={t('generationJob.refreshTasks')} title={t('generationJob.refreshTasks')} disabled={isRefreshing}>
          <RefreshCw className={isRefreshing ? 'motion-safe:animate-spin' : undefined} />
        </UiIconButton>
      </div>

      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-3" aria-live="polite">
        {error ? <div className="mb-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs leading-5 text-danger" role="alert">{error}</div> : null}
        {isLoading ? <div className="flex min-h-32 items-center justify-center gap-2 text-xs text-text-muted" role="status"><RefreshCw className="h-4 w-4 motion-safe:animate-spin" />{t('generationJob.loadingTasks')}</div> : jobs.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-text-muted"><Clock3 className="h-6 w-6 opacity-60" /><span className="text-xs leading-5">{t('generationJob.noTasks')}</span></div>
        ) : (
          <div className="space-y-2">{jobs.map((job) => {
            const nodeIds = nodeIdsByJobId.get(job.job_id) ?? [];
            const canLocate = nodeIds.length > 0;
            const canRecover = isTauri() && canLocate && (job.status === 'recoverable_wait' || job.status === 'unknown') && job.resumable !== false && Boolean(job.external_task_id || job.result_url);
            const status = recoveryStatus[job.job_id];
            const isRecovering = recoveringJobId === job.job_id;
            return <article key={job.job_id} className="rounded-xl border border-[var(--line)] bg-[var(--field-bg)] px-3 py-2.5 transition-colors duration-(--dur-1) hover:border-[var(--line-strong)]">
              <div className="flex items-start gap-2.5"><div className="mt-0.5 shrink-0">{statusIcon(job.status)}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-semibold text-text-dark">{job.model_id || job.provider_id || t('generationJob.unknownModel')}</span><span className="shrink-0 text-[10px] text-text-muted">{formatUpdatedAt(job.updated_at, i18n.language)}</span></div><div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-text-muted"><span>{t(`generationJob.status.${job.status}`, { defaultValue: job.status })}</span>{job.phase ? <span>{t(`generationJob.phase.${job.phase}`, { defaultValue: job.phase })}</span> : null}{job.network_route ? <span>{t(`generationJob.route.${job.network_route}`)}</span> : null}{canRecover ? <span className="text-warning">{t('generationJob.safeHandle')}</span> : null}</div>{job.error ? <div className="mt-1.5 line-clamp-2 wrap-break-word text-[11px] leading-4 text-text-muted" title={job.error}>{job.error}</div> : null}</div>
                <div className="flex shrink-0 gap-1">{canRecover ? <UiIconButton size="lg" className="text-warning hover:bg-warning/10" onClick={() => setConfirmJobId(job.job_id)} disabled={isRecovering} aria-label={t('generationJob.recoverResult')}><RotateCcw className={isRecovering ? 'motion-safe:animate-spin' : undefined} /></UiIconButton> : null}<UiIconButton size="lg" className="hover:bg-accent/10 hover:text-accent" onClick={() => void locate(job.job_id)} disabled={!canLocate} aria-label={t('generationJob.locateTask')}><LocateFixed /></UiIconButton></div>
              </div>
              {confirmJobId === job.job_id ? <div className="mt-2 rounded-xl border border-warning/30 bg-warning/[0.07] p-3 text-[11px] leading-5 text-text-dark"><div>{t('generationJob.recoveryConfirm')}</div><div className="mt-2 flex justify-end gap-1.5"><UiButton variant="ghost" onClick={() => setConfirmJobId(null)}>{t('common.cancel')}</UiButton><UiButton variant="primary" onClick={() => void recover(job)}>{t('generationJob.confirmRecovery')}</UiButton></div></div> : null}
              {status ? <div className={`mt-2 text-[11px] leading-4 ${status.ok ? 'text-success' : 'text-danger'}`} role="status">{status.message}</div> : null}
            </article>;
          })}</div>
        )}
      </div>
    </section>
  );
}
