import { listGenerationJobs, type GenerationJobStatus } from '@/commands/ai';
import {
  readDiagnosticLogs,
  type DiagnosticLogEntry,
  type DiagnosticLogQuery,
} from '@/commands/diagnosticLogs';
import { sanitizeGenerationDiagnosticText } from './generationErrorReport';

export interface DiagnosticEvent {
  id: string;
  occurredAt: number | null;
  severity: 'debug' | 'info' | 'warning' | 'error';
  source: 'application' | 'generation';
  category: string;
  message: string;
  jobId?: string;
  nodeIds?: string[];
  recoverable: boolean;
}

export type DiagnosticEventSummaryKey =
  | 'generationFailed'
  | 'generationRecovered'
  | 'generationRunning'
  | 'generationCompleted'
  | 'applicationStarted'
  | 'canvasOpened'
  | 'networkFailed'
  | 'diagnosticsUnavailable'
  | 'applicationEvent'
  | 'generationEvent';

/**
 * Maps structured/redacted evidence to stable product language. The original
 * redacted record remains available separately and is never used as the row
 * title, so log wording changes cannot make the drawer unreadable.
 */
export function diagnosticEventSummaryKey(event: DiagnosticEvent): DiagnosticEventSummaryKey {
  const category = event.category.toLowerCase();
  const message = event.message.toLowerCase();
  if (category === 'diagnostic-source') return 'diagnosticsUnavailable';
  if (event.source === 'generation') {
    if (event.severity === 'error' || /failed|error|失败|download/.test(message)) return 'generationFailed';
    if (/recover|materializ|取回|保存结果/.test(`${category} ${message}`)) return 'generationRecovered';
    if (/succeed|complete|已完成/.test(message)) return 'generationCompleted';
    return 'generationRunning';
  }
  if (/open storyboard canvas starting/.test(message)) return 'applicationStarted';
  if (/main page loaded|frontend_ready/.test(message)) return 'canvasOpened';
  if (/network|request|connect|timeout|fetch|http/.test(`${category} ${message}`) && event.severity !== 'info') {
    return 'networkFailed';
  }
  return 'applicationEvent';
}

function severity(value: string): DiagnosticEvent['severity'] {
  if (value === 'error') return 'error';
  if (value === 'warn' || value === 'warning') return 'warning';
  if (value === 'debug' || value === 'trace') return 'debug';
  return 'info';
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeEventText(value: string): string {
  return sanitizeGenerationDiagnosticText(value)
    .replace(/((?:request|response)[ _-]?body\s*[=:]\s*).*$/gi, '$1[redacted]')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s"']+\\)*[^\s"']*/gi, '[local-path redacted]')
    .replace(/\\\\[^\s"']+/g, '[local-path redacted]')
    .replace(/(^|[\s"'(=])\/(?:[^/\s"']+\/)+[^\s"']*/g, '$1[local-path redacted]');
}

function projectLog(entry: DiagnosticLogEntry): DiagnosticEvent {
  return {
    id: `log:${entry.id}`,
    occurredAt: parseTimestamp(entry.timestamp),
    severity: severity(entry.severity),
    source: 'application',
    category: entry.source || 'application',
    message: sanitizeEventText(entry.message).slice(0, 4_096),
    recoverable: false,
  };
}

function projectJob(job: GenerationJobStatus): DiagnosticEvent {
  const recoverable = Boolean(job.resumable && (job.external_task_id || job.result_url));
  const message = job.error
    || `任务 ${job.status}${job.phase ? ` · ${job.phase}` : ''}`;
  return {
    id: `generation:${job.job_id}:${job.updated_at ?? job.created_at ?? 0}`,
    occurredAt: job.updated_at ?? job.created_at ?? null,
    severity: job.status === 'failed' || job.status === 'unknown' ? 'error' : recoverable ? 'warning' : 'info',
    source: 'generation',
    category: job.error_category || job.phase || 'generation',
    message: sanitizeEventText(message).slice(0, 4_096),
    jobId: job.job_id,
    recoverable,
  };
}

function sourceFailure(
  source: DiagnosticEvent['source'],
  error: unknown,
): DiagnosticEvent {
  const fallback = source === 'application'
    ? 'Application file logs are temporarily unavailable.'
    : 'Persisted generation events are temporarily unavailable.';
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
  return {
    id: `diagnostic-source:${source}:${Date.now()}`,
    occurredAt: Date.now(),
    severity: 'warning',
    source,
    category: 'diagnostic-source',
    message: sanitizeEventText(detail || fallback).slice(0, 4_096),
    recoverable: false,
  };
}

export interface DiagnosticEventSnapshot {
  nativeLogsAvailable: boolean;
  events: DiagnosticEvent[];
}

export async function loadDiagnosticEvents(query: DiagnosticLogQuery = {}): Promise<DiagnosticEventSnapshot> {
  const [nativeResult, jobsResult] = await Promise.allSettled([
    readDiagnosticLogs(query),
    listGenerationJobs(Math.max(1, Math.min(100, query.limit ?? 50))),
  ]);
  const native = nativeResult.status === 'fulfilled'
    ? nativeResult.value
    : { available: false, entries: [] };
  const jobs = jobsResult.status === 'fulfilled' ? jobsResult.value : [];
  const severityFilter = query.severity?.trim().toLowerCase();
  const sourceFilter = query.source?.trim().toLowerCase();
  const textFilter = query.query?.trim().toLowerCase();
  const events = [
    ...native.entries.map(projectLog),
    ...jobs.map(projectJob),
    ...(nativeResult.status === 'rejected' ? [sourceFailure('application', nativeResult.reason)] : []),
    ...(jobsResult.status === 'rejected' ? [sourceFailure('generation', jobsResult.reason)] : []),
  ]
    .filter((event) => !severityFilter || event.severity === severityFilter)
    .filter((event) => !sourceFilter || event.source === sourceFilter || event.category.toLowerCase().includes(sourceFilter))
    .filter((event) => !textFilter || `${event.message} ${event.category} ${event.jobId ?? ''}`.toLowerCase().includes(textFilter))
    .sort((left, right) => (right.occurredAt ?? 0) - (left.occurredAt ?? 0))
    .slice(0, Math.max(1, Math.min(250, Math.round(query.limit ?? 100))));
  return { nativeLogsAvailable: native.available, events };
}

export function diagnosticEventsToText(events: readonly DiagnosticEvent[]): string {
  return events.map((event) => {
    const when = event.occurredAt ? new Date(event.occurredAt).toISOString() : 'unknown-time';
    const job = event.jobId ? ` jobId=${event.jobId}` : '';
    return sanitizeEventText(
      `[${when}] ${event.severity.toUpperCase()} ${event.category}${job}: ${event.message}`,
    ).slice(0, 4_500);
  }).join('\n');
}
