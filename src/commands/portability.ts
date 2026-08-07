import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { v4 as uuidv4 } from 'uuid';
import type {
  PortabilityProgress,
  ProjectBundlePreview,
  ProjectImportMode,
  ProjectImportResult,
} from '@/features/portability/application/types';

interface NativeProgressEvent extends PortabilityProgress {
  jobId: string;
}

interface NativeOperationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PortabilityProgress) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was cancelled.', 'AbortError');
  }
}

async function runNativeOperation<T>(
  command: string,
  args: Record<string, unknown>,
  options: NativeOperationOptions
): Promise<T> {
  throwIfAborted(options.signal);
  const jobId = uuidv4();
  const unlisten = await listen<NativeProgressEvent>('portability-progress', (event) => {
    if (event.payload.jobId !== jobId) return;
    const { stage, completed, total } = event.payload;
    options.onProgress?.({ stage, completed, total });
  });
  const handleAbort = () => {
    void invoke('cancel_portability_operation', { jobId });
  };
  options.signal?.addEventListener('abort', handleAbort, { once: true });
  try {
    throwIfAborted(options.signal);
    return await invoke<T>(command, { ...args, jobId });
  } finally {
    options.signal?.removeEventListener('abort', handleAbort);
    unlisten();
  }
}

export function exportTauriProjectBundle(
  projectId: string,
  destinationPath: string,
  options: NativeOperationOptions = {}
): Promise<ProjectBundlePreview> {
  return runNativeOperation('export_project_bundle', { projectId, destinationPath }, options);
}

export function inspectTauriProjectBundle(
  path: string,
  options: NativeOperationOptions = {}
): Promise<ProjectBundlePreview> {
  return runNativeOperation('inspect_project_bundle', { path }, options);
}

export function importTauriProjectBundle(
  path: string,
  mode: ProjectImportMode,
  importedSuffix: string,
  options: NativeOperationOptions = {}
): Promise<ProjectImportResult> {
  return runNativeOperation('import_project_bundle', { path, mode, importedSuffix }, options);
}

export function writePortabilityTextFile(path: string, content: string): Promise<void> {
  return invoke('write_portability_text_file', { path, content });
}

export function readPortabilityTextFile(path: string): Promise<string> {
  return invoke<string>('read_portability_text_file', { path });
}
