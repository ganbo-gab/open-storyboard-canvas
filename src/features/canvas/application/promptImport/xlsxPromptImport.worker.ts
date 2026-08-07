/// <reference lib="webworker" />

import { parsePromptImportXlsxWorkerBuffer } from './xlsxPromptImportParser';

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<{ buffer: ArrayBuffer }>) => {
  try {
    const sheets = await parsePromptImportXlsxWorkerBuffer(event.data.buffer);
    workerScope.postMessage({ type: 'success', sheets });
  } catch {
    workerScope.postMessage({ type: 'error' });
  }
};

export {};
