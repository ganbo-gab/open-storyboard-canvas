import { useCallback, useEffect, useMemo, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import {
  Check, CheckCircle2, ChevronDown, Clock3, Copy, FileText,
  LocateFixed, RefreshCw, RotateCcw, Search, ShieldAlert, X, XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { listGenerationJobs, type GenerationJobStatus } from '@/commands/ai';
import {
  diagnosticEventsToText,
  loadDiagnosticEvents,
  type DiagnosticEvent,
} from '@/features/canvas/application/diagnosticEvents';
import { recoverPersistedGenerationResult } from '@/features/canvas/application/generationRecovery';
import { canvasNavigationFacade } from '@/features/canvas/application/canvasNavigationFacade';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

interface Props { nodes: CanvasNode[] }
type Surface = 'tasks' | 'logs';

function statusIcon(status: GenerationJobStatus['status']) {
  if (status === 'succeeded') return <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />;
  if (status === 'failed' || status === 'not_found' || status === 'canceled') return <XCircle className="h-4 w-4 text-red-400" aria-hidden="true" />;
  if (status === 'unknown' || status === 'recoverable_wait') return <ShieldAlert className="h-4 w-4 text-amber-400" aria-hidden="true" />;
  return <Clock3 className="h-4 w-4 text-accent" aria-hidden="true" />;
}

function formatUpdatedAt(value: number | undefined, locale: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function eventTone(severity: DiagnosticEvent['severity']): string {
  if (severity === 'error') return 'bg-red-400';
  if (severity === 'warning') return 'bg-amber-400';
  if (severity === 'debug') return 'bg-text-muted';
  return 'bg-accent';
}

export function GenerationTasksPanel({ nodes }: Props) {
  const { i18n, t } = useTranslation();
  const [surface, setSurface] = useState<Surface>('tasks');
  const [jobs, setJobs] = useState<GenerationJobStatus[]>([]);
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [nativeLogsAvailable, setNativeLogsAvailable] = useState(false);
  const [severity, setSeverity] = useState('');
  const [source, setSource] = useState('');
  const [query, setQuery] = useState('');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [confirmJobId, setConfirmJobId] = useState<string | null>(null);
  const [recoveringJobId, setRecoveringJobId] = useState<string | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [isLoading, setLoading] = useState(true);
  const [isRefreshing, setRefreshing] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  const nodeIdsByJobId = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const node of nodes) {
      const data = node.data as Record<string, unknown>;
      const jobIds = [data.generationJobId, data.generationLastJobId]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      for (const jobId of jobIds) result.set(jobId, [...(result.get(jobId) ?? []), node.id]);
    }
    return result;
  }, [nodes]);

  const refresh = useCallback(async (background = false) => {
    if (!background) setRefreshing(true);
    try {
      if (surface === 'logs') {
        const snapshot = await loadDiagnosticEvents({ limit: 100 });
        setEvents(snapshot.events);
        setNativeLogsAvailable(snapshot.nativeLogsAvailable);
      } else {
        setJobs(await listGenerationJobs(50));
      }
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
      if (!background) setRefreshing(false);
    }
  }, [surface]);

  useEffect(() => { setLoading(true); void refresh(true); }, [refresh]);
  useEffect(() => {
    if (surface !== 'tasks') return undefined;
    const timer = window.setInterval(() => void refresh(true), 4_000);
    return () => window.clearInterval(timer);
  }, [refresh, surface]);

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

  const filteredEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return events.filter((event) => (
      (!severity || event.severity === severity)
      && (!source || event.source === source)
      && (!normalizedQuery || `${event.message} ${event.category} ${event.jobId ?? ''}`.toLowerCase().includes(normalizedQuery))
    ));
  }, [events, query, severity, source]);

  const copyDiagnostics = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(diagnosticEventsToText(filteredEvents));
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    window.setTimeout(() => setCopyState('idle'), 2_000);
  }, [filteredEvents]);

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={t('canvasAgent.tasks')}>
      <div className="shrink-0 border-b border-border-dark/70 px-3 pb-2.5 pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="inline-grid h-9 grid-cols-2 rounded-[5px] bg-text-dark/[0.05] p-0.5" role="tablist" aria-label={t('generationJob.operationsView')}>
            {(['tasks', 'logs'] as const).map((value) => (
              <button key={value} type="button" role="tab" aria-selected={surface === value}
                className={`min-w-20 rounded-[4px] px-3 text-xs transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${surface === value ? 'bg-surface-dark text-text-dark shadow-sm' : 'text-text-muted hover:text-text-dark'}`}
                onClick={() => setSurface(value)}>
                {t(`generationJob.view.${value}`)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {surface === 'logs' ? (
              <button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-[5px] text-text-muted transition-colors duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-40" onClick={() => void copyDiagnostics()} disabled={!filteredEvents.length} aria-label={t('generationJob.copyLogs')} title={t('generationJob.copyLogs')}>
                {copyState === 'copied' ? <Check className="h-4 w-4 text-emerald-500" /> : copyState === 'failed' ? <X className="h-4 w-4 text-red-400" /> : <Copy className="h-4 w-4" />}
              </button>
            ) : null}
            <button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-[5px] text-text-muted transition-colors duration-150 hover:bg-text-dark/[0.05] hover:text-text-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-40" onClick={() => void refresh(false)} aria-label={t('generationJob.refreshTasks')} title={t('generationJob.refreshTasks')} disabled={isRefreshing}>
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'motion-safe:animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        {surface === 'logs' ? (
          <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-1.5">
            <label className="relative min-w-0">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" aria-hidden="true" />
              <span className="sr-only">{t('generationJob.searchLogs')}</span>
              <input value={query} onChange={(event) => setQuery(event.target.value.slice(0, 200))} placeholder={t('generationJob.searchLogs')} className="h-9 w-full rounded-[5px] border border-border-dark/70 bg-surface-dark pl-8 pr-2 text-xs text-text-dark outline-none transition-colors duration-150 placeholder:text-text-muted focus:border-accent/60" />
            </label>
            <select value={severity} onChange={(event) => setSeverity(event.target.value)} aria-label={t('generationJob.filterSeverity')} className="h-9 rounded-[5px] border border-border-dark/70 bg-surface-dark px-2 text-xs text-text-dark outline-none focus:border-accent/60">
              <option value="">{t('generationJob.allSeverity')}</option><option value="error">Error</option><option value="warning">Warning</option><option value="info">Info</option><option value="debug">Debug</option>
            </select>
            <select value={source} onChange={(event) => setSource(event.target.value)} aria-label={t('generationJob.filterSource')} className="h-9 rounded-[5px] border border-border-dark/70 bg-surface-dark px-2 text-xs text-text-dark outline-none focus:border-accent/60">
              <option value="">{t('generationJob.allSources')}</option><option value="generation">{t('generationJob.sourceGeneration')}</option><option value="application">{t('generationJob.sourceApplication')}</option>
            </select>
          </div>
        ) : (
          <div className="mt-1.5 text-[11px] leading-4 text-text-muted">{t(isTauri() ? 'generationJob.desktopPersistenceNotice' : 'generationJob.webPersistenceNotice')}</div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" aria-live="polite">
        {error ? <div className="mb-2 rounded-[5px] border border-red-400/35 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-300" role="alert">{error}</div> : null}
        {isLoading ? <div className="flex min-h-32 items-center justify-center gap-2 text-xs text-text-muted" role="status"><RefreshCw className="h-4 w-4 motion-safe:animate-spin" />{t(surface === 'logs' ? 'generationJob.loadingLogs' : 'generationJob.loadingTasks')}</div> : surface === 'logs' ? (
          <div>
            {!nativeLogsAvailable ? <div className="mb-2 rounded-[5px] border border-border-dark/70 bg-text-dark/[0.03] px-3 py-2 text-[11px] leading-4 text-text-muted">{t(isTauri() ? 'generationJob.nativeLogsEmpty' : 'generationJob.nativeLogsUnavailable')}</div> : null}
            {!filteredEvents.length ? <div className="flex min-h-36 flex-col items-center justify-center gap-2 text-center text-text-muted"><FileText className="h-6 w-6 opacity-60" /><span className="text-xs">{t('generationJob.noLogs')}</span></div> : (
              <div className="space-y-1.5">{filteredEvents.map((event) => {
                const expanded = expandedEventId === event.id;
                return <article key={event.id} className="rounded-[5px] border border-border-dark/70 bg-surface-dark/40">
                  <button type="button" aria-expanded={expanded} className="grid min-h-11 w-full grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-2 px-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60" onClick={() => setExpandedEventId(expanded ? null : event.id)}>
                    <span className={`h-6 w-1 rounded-full ${eventTone(event.severity)}`} aria-hidden="true" />
                    <span className="min-w-0"><span className="flex items-center gap-2 text-[10px] uppercase text-text-muted"><span>{event.source}</span><span>{event.category}</span>{event.occurredAt ? <span>{formatUpdatedAt(event.occurredAt, i18n.language)}</span> : null}</span><span className={`mt-0.5 block break-words text-[11px] leading-4 text-text-dark ${expanded ? '' : 'line-clamp-1'}`}>{event.message}</span></span>
                    <ChevronDown className={`h-4 w-4 text-text-muted transition-transform duration-150 motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`} />
                  </button>
                  {expanded ? <div className="border-t border-border-dark/60 px-3 py-2 text-[11px] leading-5 text-text-muted"><div className="break-all font-mono">{event.id}</div>{event.jobId ? <div className="mt-1 break-all font-mono">jobId: {event.jobId}</div> : null}{event.recoverable ? <div className="mt-1 text-amber-500">{t('generationJob.logRecoverable')}</div> : null}</div> : null}
                </article>;
              })}</div>
            )}
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex min-h-36 flex-col items-center justify-center gap-2 px-6 text-center text-text-muted"><Clock3 className="h-6 w-6 opacity-60" /><span className="text-xs leading-5">{t('generationJob.noTasks')}</span></div>
        ) : (
          <div className="space-y-2">{jobs.map((job) => {
            const nodeIds = nodeIdsByJobId.get(job.job_id) ?? [];
            const canLocate = nodeIds.length > 0;
            const canRecover = isTauri() && canLocate && (job.status === 'recoverable_wait' || job.status === 'unknown') && job.resumable !== false && Boolean(job.external_task_id || job.result_url);
            const status = recoveryStatus[job.job_id];
            const isRecovering = recoveringJobId === job.job_id;
            return <article key={job.job_id} className="rounded-[5px] border border-border-dark/80 bg-surface-dark/45 px-3 py-2.5 shadow-sm transition-colors duration-150 hover:border-text-muted/30">
              <div className="flex items-start gap-2.5"><div className="mt-0.5 shrink-0">{statusIcon(job.status)}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-semibold text-text-dark">{job.model_id || job.provider_id || t('generationJob.unknownModel')}</span><span className="shrink-0 text-[10px] text-text-muted">{formatUpdatedAt(job.updated_at, i18n.language)}</span></div><div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-text-muted"><span>{t(`generationJob.status.${job.status}`, { defaultValue: job.status })}</span>{job.phase ? <span>{t(`generationJob.phase.${job.phase}`, { defaultValue: job.phase })}</span> : null}{job.network_route ? <span>{t(`generationJob.route.${job.network_route}`)}</span> : null}{canRecover ? <span className="text-amber-500">{t('generationJob.safeHandle')}</span> : null}</div>{job.error ? <div className="mt-1.5 line-clamp-2 break-words text-[11px] leading-4 text-text-muted" title={job.error}>{job.error}</div> : null}</div>
                <div className="flex shrink-0 gap-1">{canRecover ? <button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-[5px] text-amber-500 transition-colors duration-150 hover:bg-amber-500/10 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60" onClick={() => setConfirmJobId(job.job_id)} disabled={isRecovering} aria-label={t('generationJob.recoverResult')} title={t('generationJob.recoverResult')}><RotateCcw className={`h-4 w-4 ${isRecovering ? 'motion-safe:animate-spin' : ''}`} /></button> : null}<button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-[5px] text-text-muted transition-colors duration-150 hover:bg-accent/10 hover:text-accent disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" onClick={() => void locate(job.job_id)} disabled={!canLocate} aria-label={t('generationJob.locateTask')} title={canLocate ? t('generationJob.locateTask') : t('generationJob.taskNodeMissing')}><LocateFixed className="h-4 w-4" /></button></div>
              </div>
              {confirmJobId === job.job_id ? <div className="mt-2 rounded-[5px] border border-amber-400/35 bg-amber-400/[0.07] p-2.5 text-[11px] leading-4 text-text-dark"><div>{t('generationJob.recoveryConfirm')}</div><div className="mt-2 flex justify-end gap-1.5"><button type="button" className="h-9 rounded-[5px] px-3 text-text-muted hover:bg-text-dark/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60" onClick={() => setConfirmJobId(null)}>{t('common.cancel')}</button><button type="button" className="h-9 rounded-[5px] bg-amber-500 px-3 font-medium text-black transition-opacity duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300" onClick={() => void recover(job)}>{t('generationJob.confirmRecovery')}</button></div></div> : null}
              {status ? <div className={`mt-2 text-[11px] leading-4 ${status.ok ? 'text-emerald-500' : 'text-red-400'}`} role="status">{status.message}</div> : null}
            </article>;
          })}</div>
        )}
      </div>
    </section>
  );
}
