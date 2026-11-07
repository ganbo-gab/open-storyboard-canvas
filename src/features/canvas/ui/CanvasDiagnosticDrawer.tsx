import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import {
  Check, ChevronDown, Copy, FileText, Filter, Info, LocateFixed, RefreshCw,
  RotateCcw, Search, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiIconButton, UiInput } from '@/components/ui';
import {
  diagnosticEventSummaryKey,
  diagnosticEventsToText,
  loadDiagnosticEvents,
  type DiagnosticEvent,
} from '@/features/canvas/application/diagnosticEvents';
import { canvasNavigationFacade } from '@/features/canvas/application/canvasNavigationFacade';
import { recoverPersistedGenerationResult } from '@/features/canvas/application/generationRecovery';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { openGenerationDetails } from '@/features/library/ui/GenerationDetailsDialog';
import { useGenerationHistoryStore } from '@/features/library/history/historyStore';
import { requestHistoryNavigation } from '@/features/studio/studioNavigation';
import { jumpToHistorySource } from '@/features/library/history/history';
import { projectHistoryDiagnostics } from '@/features/library/application/generationDetails';

type FilterKind = 'severity' | 'source';

interface Props {
  isOpen: boolean;
  nodes: CanvasNode[];
  onClose: () => void;
}

const SEVERITIES = ['', 'error', 'warning', 'info', 'debug'] as const;
const SOURCES = ['', 'generation', 'application'] as const;

function eventTone(severity: DiagnosticEvent['severity']): string {
  if (severity === 'error') return 'bg-danger';
  if (severity === 'warning') return 'bg-warning';
  if (severity === 'debug') return 'bg-text-muted';
  return 'bg-accent';
}

function formatTime(value: number | null, locale: string): string {
  if (!value) return '';
  return new Intl.DateTimeFormat(locale, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(value));
}

export function CanvasDiagnosticDrawer({ isOpen, nodes, onClose }: Props) {
  const { i18n, t } = useTranslation();
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const historyRecords = useGenerationHistoryStore((state) => state.records);
  const [nativeLogsAvailable, setNativeLogsAvailable] = useState(false);
  const [severity, setSeverity] = useState('');
  const [source, setSource] = useState('');
  const [query, setQuery] = useState('');
  const [openFilter, setOpenFilter] = useState<FilterKind | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmRecoveryId, setConfirmRecoveryId] = useState<string | null>(null);
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const filterRef = useRef<HTMLDivElement>(null);

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

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await loadDiagnosticEvents({ limit: 150 });
      setEvents(snapshot.events);
      setNativeLogsAvailable(snapshot.nativeLogsAvailable);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (isOpen) { void refresh(); void useGenerationHistoryStore.getState().initialize().catch(() => undefined); } }, [isOpen, refresh]);
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(event.target as Node)) setOpenFilter(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const filteredEvents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const known = new Set(events.map((event) => event.jobId).filter(Boolean));
    const combined = [...events, ...projectHistoryDiagnostics(historyRecords).filter((event) => !event.jobId || !known.has(event.jobId))];
    return combined.filter((event) => (
      (!severity || event.severity === severity)
      && (!source || event.source === source)
      && (!needle || `${event.message} ${event.category} ${event.jobId ?? ''}`.toLowerCase().includes(needle))
    )).sort((left, right) => (right.occurredAt ?? 0) - (left.occurredAt ?? 0)).slice(0, 250);
  }, [events, historyRecords, query, severity, source]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticEventsToText(filteredEvents));
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    window.setTimeout(() => setCopyState('idle'), 2_000);
  };

  const recover = async (event: DiagnosticEvent) => {
    if (!event.jobId || recoveringId) return;
    setConfirmRecoveryId(null);
    setRecoveringId(event.jobId);
    setStatus(t('generationJob.recoveryRunning'));
    try {
      await recoverPersistedGenerationResult({
        jobId: event.jobId,
        nodeIds: nodeIdsByJobId.get(event.jobId) ?? [],
      });
      setStatus(t('generationJob.recoverySucceeded'));
      await refresh();
    } catch (recoveryError) {
      setStatus(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
    } finally {
      setRecoveringId(null);
    }
  };

  if (!isOpen) return null;

  const filterButton = (kind: FilterKind, value: string, label: string) => (
    <div className="relative">
      <UiButton variant="secondary"
        type="button"
        aria-haspopup="menu"
        aria-expanded={openFilter === kind}
        className={`h-9 gap-1.5 rounded-lg px-2.5 text-xs ${value ? 'border-accent/45 bg-accent/10 text-accent' : ''}`}
        onClick={() => setOpenFilter(openFilter === kind ? null : kind)}
      >
        <Filter className="h-3.5 w-3.5" />{label}<ChevronDown className="h-3.5 w-3.5" />
      </UiButton>
      {openFilter === kind ? (
        <div role="menu" className="ui-menu absolute left-0 top-[calc(100%+6px)] z-30 min-w-36 rounded-xl p-1.5">
          {(kind === 'severity' ? SEVERITIES : SOURCES).map((option) => (
            <UiButton variant="ghost"
              key={option || 'all'} type="button" role="menuitemradio" aria-checked={value === option}
              className="min-h-9 w-full justify-between rounded-lg px-2.5 text-left text-xs"
              onClick={() => {
                if (kind === 'severity') setSeverity(option); else setSource(option);
                setOpenFilter(null);
              }}
            >
              {t(option ? `generationJob.filterOption.${option}` : kind === 'severity' ? 'generationJob.allSeverity' : 'generationJob.allSources')}
              {value === option ? <Check className="h-3.5 w-3.5 text-accent" /> : null}
            </UiButton>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <aside className="agent-view-enter absolute bottom-3 left-[88px] top-3 z-30 flex w-[min(430px,calc(100%-104px))] flex-col overflow-hidden rounded-2xl border border-(--line-strong) bg-elevated shadow-(--shadow-float)" aria-label={t('generationJob.logDrawerTitle')}>
      <header className="flex min-h-14 items-center gap-3 border-b border-(--line) px-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text-dark">{t('generationJob.logDrawerTitle')}</h2>
          <p className="truncate text-[11px] text-text-muted">{t('generationJob.logDrawerDescription')}</p>
        </div>
        <UiIconButton variant="ghost" type="button" className="h-10 w-10 rounded-lg" onClick={() => void copy()} disabled={!filteredEvents.length} aria-label={t('generationJob.copyLogs')}>
          {copyState === 'copied' ? <Check className="h-4 w-4 text-success" /> : copyState === 'failed' ? <X className="h-4 w-4 text-danger" /> : <Copy className="h-4 w-4" />}
        </UiIconButton>
        <UiIconButton variant="ghost" type="button" className="h-10 w-10 rounded-lg" onClick={() => void refresh()} aria-label={t('generationJob.refreshTasks')}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'motion-safe:animate-spin' : ''}`} />
        </UiIconButton>
        <UiIconButton variant="ghost" type="button" className="h-10 w-10 rounded-lg" onClick={onClose} aria-label={t('common.close')}><X className="h-4 w-4" /></UiIconButton>
      </header>

      <div ref={filterRef} className="border-b border-(--line) p-3">
        <label className="relative block">
          <span className="sr-only">{t('generationJob.searchLogs')}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <UiInput id="canvas-diagnostic-search" name="canvasDiagnosticSearch" value={query} onChange={(event) => setQuery(event.target.value.slice(0, 200))} placeholder={t('generationJob.searchLogs')} className="h-10 w-full rounded-xl pl-9 pr-3 text-xs" />
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          {filterButton('severity', severity, severity ? t(`generationJob.filterOption.${severity}`) : t('generationJob.allSeverity'))}
          {filterButton('source', source, source ? t(`generationJob.filterOption.${source}`) : t('generationJob.allSources'))}
        </div>
      </div>

      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-3" aria-live="polite">
        {error ? <div role="alert" className="mb-2 rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger">{error}</div> : null}
        {!nativeLogsAvailable ? <div className="mb-2 rounded-xl border border-(--line) bg-(--hover) p-3 text-xs leading-5 text-text-muted">{t(isTauri() ? 'generationJob.nativeLogsEmpty' : 'generationJob.nativeLogsUnavailable')}</div> : null}
        {loading && !events.length ? <div className="flex min-h-40 items-center justify-center gap-2 text-xs text-text-muted"><RefreshCw className="h-4 w-4 motion-safe:animate-spin" />{t('generationJob.loadingLogs')}</div> : null}
        {!loading && !filteredEvents.length ? <div className="flex min-h-44 flex-col items-center justify-center gap-2 text-xs text-text-muted"><FileText className="h-6 w-6 opacity-60" />{t('generationJob.noLogs')}</div> : null}
        <div className="space-y-2">
          {filteredEvents.map((event) => {
            const expanded = expandedId === event.id;
            const history = event.id.startsWith('history:') ? historyRecords.find((record) => `history:${record.id}` === event.id)
              : event.jobId ? historyRecords.find((record) => record.jobIds?.includes(event.jobId!)) : undefined;
            const nodeIds = event.jobId ? nodeIdsByJobId.get(event.jobId) ?? [] : [];
            return (
              <article key={event.id} className="overflow-hidden rounded-xl border border-(--line) bg-surface transition-colors duration-150 hover:border-(--line-strong)">
                <div className="grid grid-cols-[5px_minmax(0,1fr)_auto] gap-2.5 p-3">
                  <span className={`h-full min-h-9 rounded-full ${eventTone(event.severity)}`} />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-text-dark">{t(`generationJob.summary.${diagnosticEventSummaryKey(event)}`)}</div>
                    <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-text-muted"><span>{formatTime(event.occurredAt, i18n.language)}</span><span>{t(`generationJob.filterOption.${event.source}`)}</span></div>
                    {history ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-text-muted">{history.prompt || t('ui.details.notRecorded')}</p> : null}
                    {history ? <p className="mt-1 truncate text-[11px] text-text-subtle">{history.modelRef} · {t(`rework.generationHistory.surfaces.${history.surface}`)}</p> : null}
                  </div>
                  <div className="flex items-start gap-1">
                    {event.jobId || history ? <UiIconButton variant="ghost" className="h-9 w-9" aria-label={t('ui.details.title')} onClick={() => openGenerationDetails({ jobId: event.jobId, recordId: history?.id, nodeId: nodeIds[0] })}><Info className="h-4 w-4" /></UiIconButton> : null}
                    {nodeIds.length ? <UiIconButton variant="ghost" type="button" className="h-9 w-9 rounded-lg" aria-label={t('generationJob.locateTask')} onClick={() => void canvasNavigationFacade.focusNodeIds(nodeIds, { select: true, padding: 0.24 })}><LocateFixed className="h-4 w-4" /></UiIconButton> : null}
                    {!nodeIds.length && history && jumpToHistorySource(history).surface !== 'unavailable' ? <UiIconButton variant="ghost" className="h-9 w-9" aria-label={t('ui.details.locateSource')} onClick={() => { const destination = jumpToHistorySource(history); if (destination.surface !== 'unavailable') requestHistoryNavigation(destination); }}><LocateFixed className="h-4 w-4" /></UiIconButton> : null}
                    {event.recoverable && event.jobId ? <UiIconButton variant="ghost" type="button" className="h-9 w-9 rounded-lg text-warning" aria-label={t('generationJob.recoverResult')} onClick={() => setConfirmRecoveryId(event.jobId!)}><RotateCcw className={`h-4 w-4 ${recoveringId === event.jobId ? 'motion-safe:animate-spin' : ''}`} /></UiIconButton> : null}
                  </div>
                </div>
                <UiButton variant="ghost" type="button" aria-expanded={expanded} className="min-h-9 w-full justify-between rounded-none border-t border-(--line) px-3 text-[11px]" onClick={() => setExpandedId(expanded ? null : event.id)}>
                  {t(expanded ? 'generationJob.hideRaw' : 'generationJob.showRaw')}<ChevronDown className={`h-3.5 w-3.5 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`} />
                </UiButton>
                {expanded ? <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all border-t border-(--line) bg-(--field-bg) p-3 text-[10px] leading-5 text-text-muted">{diagnosticEventsToText([event])}</pre> : null}
                {confirmRecoveryId === event.jobId ? <div className="border-t border-warning/25 bg-warning/10 p-3 text-xs leading-5 text-text-dark"><p>{t('generationJob.recoveryConfirm')}</p><div className="mt-2 flex justify-end gap-2"><UiButton variant="ghost" type="button" className="h-9 rounded-lg px-3" onClick={() => setConfirmRecoveryId(null)}>{t('common.cancel')}</UiButton><UiButton variant="primary" type="button" className="h-9 rounded-lg px-3" onClick={() => void recover(event)}>{t('generationJob.confirmRecovery')}</UiButton></div></div> : null}
              </article>
            );
          })}
        </div>
        {status ? <div className="sticky bottom-2 mt-3 rounded-xl border border-(--line-strong) bg-elevated p-3 text-xs text-text-dark shadow-(--shadow-pop)" role="status">{status}</div> : null}
      </div>
    </aside>
  );
}
