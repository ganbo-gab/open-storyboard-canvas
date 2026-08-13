import { invoke, isTauri } from '@tauri-apps/api/core';

export type DiagnosticSeverity = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface DiagnosticLogEntry {
  id: string;
  timestamp: string | null;
  severity: DiagnosticSeverity | string;
  source: string;
  message: string;
}

export interface DiagnosticLogQuery {
  severity?: string;
  source?: string;
  query?: string;
  limit?: number;
}

export interface DiagnosticLogResult {
  available: boolean;
  entries: DiagnosticLogEntry[];
}

export async function readDiagnosticLogs(query: DiagnosticLogQuery = {}): Promise<DiagnosticLogResult> {
  if (!isTauri()) return { available: false, entries: [] };
  return await invoke<DiagnosticLogResult>('read_diagnostic_logs', {
    query: {
      ...query,
      limit: Math.max(1, Math.min(250, Math.round(query.limit ?? 100))),
    },
  });
}
