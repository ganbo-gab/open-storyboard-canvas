import { beforeEach, describe, expect, it, vi } from 'vitest';

import { diagnosticEventSummaryKey, diagnosticEventsToText, loadDiagnosticEvents } from './diagnosticEvents';

const { listGenerationJobsMock, readDiagnosticLogsMock } = vi.hoisted(() => ({
  listGenerationJobsMock: vi.fn(),
  readDiagnosticLogsMock: vi.fn(),
}));

vi.mock('@/commands/ai', () => ({ listGenerationJobs: listGenerationJobsMock }));
vi.mock('@/commands/diagnosticLogs', () => ({ readDiagnosticLogs: readDiagnosticLogsMock }));

describe('diagnostic event projection', () => {
  beforeEach(() => {
    readDiagnosticLogsMock.mockReset();
    listGenerationJobsMock.mockReset();
    readDiagnosticLogsMock.mockResolvedValue({
      available: true,
      entries: [{
        id: '1', timestamp: '2026-08-13T10:00:00Z', severity: 'error', source: 'network',
        message: 'request https://example.com/result?token=private failed',
      }],
    });
    listGenerationJobsMock.mockResolvedValue([{ job_id: 'job-1', status: 'recoverable_wait', resumable: true, external_task_id: 'task-1', error: 'download failed', updated_at: 2 }]);
  });

  it('applies the same filters to native and persisted generation evidence', async () => {
    const snapshot = await loadDiagnosticEvents({ source: 'generation', query: 'download', limit: 5 });
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({ source: 'generation', jobId: 'job-1', recoverable: true });
  });

  it('redacts URL query secrets before returning or copying evidence', async () => {
    const snapshot = await loadDiagnosticEvents({ limit: 10 });
    const copied = diagnosticEventsToText(snapshot.events);
    expect(copied).not.toContain('private');
    expect(copied).toContain('token=%5Bredacted%5D');
  });

  it('keeps persisted generation evidence when native log reading fails', async () => {
    readDiagnosticLogsMock.mockRejectedValueOnce(
      new Error('Authorization: Bearer private-token at /Users/person/storyboard.log'),
    );

    const snapshot = await loadDiagnosticEvents({ limit: 10 });

    expect(snapshot.nativeLogsAvailable).toBe(false);
    expect(snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'generation', jobId: 'job-1' }),
      expect.objectContaining({ source: 'application', category: 'diagnostic-source' }),
    ]));
    expect(diagnosticEventsToText(snapshot.events)).not.toMatch(/private-token|\/Users\/person/);
  });

  it('keeps native log evidence when persisted task reading fails', async () => {
    listGenerationJobsMock.mockRejectedValueOnce(new Error('database temporarily unavailable'));

    const snapshot = await loadDiagnosticEvents({ limit: 10 });

    expect(snapshot.nativeLogsAvailable).toBe(true);
    expect(snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'application', category: 'network' }),
      expect.objectContaining({ source: 'generation', category: 'diagnostic-source' }),
    ]));
  });

  it('maps redacted technical evidence to stable human-readable summary keys', () => {
    expect(diagnosticEventSummaryKey({
      id: 'start', occurredAt: 1, severity: 'info', source: 'application',
      category: 'open_storyboard_canvas', message: 'Open Storyboard Canvas starting...', recoverable: false,
    })).toBe('applicationStarted');
    expect(diagnosticEventSummaryKey({
      id: 'download', occurredAt: 1, severity: 'error', source: 'generation',
      category: 'materialize', message: 'download failed', recoverable: true,
    })).toBe('generationFailed');
  });
});
