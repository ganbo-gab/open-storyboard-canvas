import { useCallback, useEffect, useMemo, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { CheckCircle2, Clock3, LocateFixed, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { listGenerationJobs, type GenerationJobStatus } from '@/commands/ai';
import { canvasNavigationFacade } from '@/features/canvas/application/canvasNavigationFacade';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

interface Props {
  nodes: CanvasNode[];
}

function statusIcon(status: GenerationJobStatus['status']) {
  if (status === 'succeeded') {
    return <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />;
  }
  if (status === 'failed' || status === 'not_found' || status === 'canceled') {
    return <XCircle className="h-4 w-4 text-red-400" aria-hidden="true" />;
  }
  if (status === 'unknown' || status === 'recoverable_wait') {
    return <ShieldAlert className="h-4 w-4 text-amber-400" aria-hidden="true" />;
  }
  return <Clock3 className="h-4 w-4 text-accent" aria-hidden="true" />;
}

function formatUpdatedAt(value: number | undefined, locale: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function GenerationTasksPanel({ nodes }: Props) {
  const { i18n, t } = useTranslation();
  const [jobs, setJobs] = useState<GenerationJobStatus[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [isRefreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nodeIdsByJobId = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const node of nodes) {
      const data = node.data as Record<string, unknown>;
      const jobIds = [data.generationJobId, data.generationLastJobId]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      for (const jobId of jobIds) {
        result.set(jobId, [...(result.get(jobId) ?? []), node.id]);
      }
    }
    return result;
  }, [nodes]);

  const refresh = useCallback(async (background = false) => {
    if (!background) setRefreshing(true);
    try {
      const next = await listGenerationJobs(50);
      setJobs(next);
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
    if (nodeIds.length > 0) {
      await canvasNavigationFacade.focusNodeIds(nodeIds, { select: true, padding: 0.24 });
    }
  }, [nodeIdsByJobId]);

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={t('canvasAgent.tasks')}>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-dark/70 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-text-dark">{t('generationJob.taskPanelTitle')}</div>
          <div className="mt-0.5 text-[11px] leading-4 text-text-muted">
            {t(isTauri()
              ? 'generationJob.desktopPersistenceNotice'
              : 'generationJob.webPersistenceNotice')}
          </div>
        </div>
        <button
          type="button"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[5px] text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          onClick={() => void refresh(false)}
          aria-label={t('generationJob.refreshTasks')}
          title={t('generationJob.refreshTasks')}
          disabled={isRefreshing}
        >
          <RefreshCw
            className={`h-4 w-4 ${isRefreshing ? 'motion-safe:animate-spin' : ''}`}
            aria-hidden="true"
          />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {error ? (
          <div className="rounded-md border border-red-400/35 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-300" role="alert">
            {error}
          </div>
        ) : null}
        {isLoading ? (
          <div className="flex min-h-32 items-center justify-center gap-2 text-xs text-text-muted" role="status">
            <RefreshCw className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
            {t('generationJob.loadingTasks')}
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex min-h-36 flex-col items-center justify-center gap-2 px-6 text-center text-text-muted">
            <Clock3 className="h-6 w-6 opacity-60" aria-hidden="true" />
            <span className="text-xs leading-5">{t('generationJob.noTasks')}</span>
          </div>
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => {
              const nodeIds = nodeIdsByJobId.get(job.job_id) ?? [];
              const canLocate = nodeIds.length > 0;
              const safeRecovery = Boolean(job.external_task_id || job.result_url);
              return (
                <article
                  key={job.job_id}
                  className="rounded-md border border-border-dark/80 bg-surface-dark/45 px-3 py-2.5 shadow-sm transition-colors duration-150 hover:border-text-muted/30"
                >
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 shrink-0">{statusIcon(job.status)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold text-text-dark">
                          {job.model_id || job.provider_id || t('generationJob.unknownModel')}
                        </span>
                        <span className="shrink-0 text-[10px] text-text-muted">
                          {formatUpdatedAt(job.updated_at, i18n.language)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-text-muted">
                        <span>{t(`generationJob.status.${job.status}`, { defaultValue: job.status })}</span>
                        {job.phase ? <span>{t(`generationJob.phase.${job.phase}`, { defaultValue: job.phase })}</span> : null}
                        {job.network_route ? <span>{t(`generationJob.route.${job.network_route}`)}</span> : null}
                        {safeRecovery ? <span className="text-amber-500">{t('generationJob.safeHandle')}</span> : null}
                      </div>
                      {job.error ? (
                        <div className="mt-1.5 line-clamp-2 break-words text-[11px] leading-4 text-text-muted" title={job.error}>
                          {job.error}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[5px] text-text-muted transition-[background-color,color,transform] duration-150 hover:bg-accent/10 hover:text-accent active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                      onClick={() => void locate(job.job_id)}
                      disabled={!canLocate}
                      aria-label={t('generationJob.locateTask')}
                      title={canLocate ? t('generationJob.locateTask') : t('generationJob.taskNodeMissing')}
                    >
                      <LocateFixed className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
