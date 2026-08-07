import type { Sheet as ExcelSheet } from 'read-excel-file/browser';

import {
  PromptImportError,
  type ParsePromptImportOptions,
  type PromptImportCell,
  type PromptImportSheet,
  type PromptImportTxtMode,
  type PromptImportWarning,
  type PromptImportWorkbook,
} from './types';

export const PROMPT_IMPORT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const PROMPT_IMPORT_MAX_SHEETS = 20;
export const PROMPT_IMPORT_MAX_PARSED_ROWS = 20_000;
export const PROMPT_IMPORT_SUPPORTED_EXTENSIONS = ['txt', 'csv', 'tsv', 'xlsx'] as const;

type SupportedExtension = (typeof PROMPT_IMPORT_SUPPORTED_EXTENSIONS)[number];

interface PromptImportFile {
  name: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

interface XlsxWorkerSuccessMessage {
  type: 'success';
  sheets: ExcelSheet[];
}

interface XlsxWorkerErrorMessage {
  type: 'error';
}

type XlsxWorkerMessage = XlsxWorkerSuccessMessage | XlsxWorkerErrorMessage;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new PromptImportError('aborted');
  }
}

function resolveFileExtension(fileName: string): SupportedExtension {
  const extension = fileName.trim().toLowerCase().split('.').pop() ?? '';
  if (!PROMPT_IMPORT_SUPPORTED_EXTENSIONS.includes(extension as SupportedExtension)) {
    throw new PromptImportError('unsupportedFileType');
  }
  return extension as SupportedExtension;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function decodeTextFile(buffer: ArrayBuffer): { text: string; warnings: PromptImportWarning[] } {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      text: stripBom(new TextDecoder('utf-16le').decode(bytes)),
      warnings: [],
    };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      text: stripBom(new TextDecoder('utf-16be').decode(bytes)),
      warnings: [],
    };
  }

  try {
    return {
      text: stripBom(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      warnings: [],
    };
  } catch {
    try {
      return {
        text: stripBom(new TextDecoder('gb18030', { fatal: true }).decode(bytes)),
        warnings: ['decodedAsGb18030'],
      };
    } catch {
      throw new PromptImportError('invalidFile');
    }
  }
}

function pushDelimitedRow(rows: PromptImportCell[][], row: string[]): void {
  rows.push(row);
  if (rows.length > PROMPT_IMPORT_MAX_PARSED_ROWS) {
    throw new PromptImportError('tooManyRows');
  }
}

export function parseDelimitedText(text: string, delimiter: ',' | '\t'): PromptImportCell[][] {
  if (!text) {
    return [];
  }

  const rows: PromptImportCell[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let index = 0;
  let endedWithRowBreak = false;

  while (index < text.length) {
    const character = text[index];
    endedWithRowBreak = false;

    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      cell += character;
      index += 1;
      continue;
    }

    if (character === '"' && cell.length === 0) {
      quoted = true;
      index += 1;
      continue;
    }
    if (character === delimiter) {
      row.push(cell);
      cell = '';
      index += 1;
      continue;
    }
    if (character === '\n' || character === '\r') {
      row.push(cell);
      pushDelimitedRow(rows, row);
      row = [];
      cell = '';
      if (character === '\r' && text[index + 1] === '\n') {
        index += 2;
      } else {
        index += 1;
      }
      endedWithRowBreak = true;
      continue;
    }

    cell += character;
    index += 1;
  }

  if (quoted) {
    throw new PromptImportError('invalidDelimitedFile');
  }
  if (!endedWithRowBreak || row.length > 0 || cell.length > 0) {
    row.push(cell);
    pushDelimitedRow(rows, row);
  }

  return rows;
}

export function parseTxtText(text: string, mode: PromptImportTxtMode): PromptImportCell[][] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const values = mode === 'paragraphs'
    ? normalized.split(/\n[\t ]*\n+/)
    : normalized.split('\n');

  const rows = values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => [value] as PromptImportCell[]);

  if (rows.length > PROMPT_IMPORT_MAX_PARSED_ROWS) {
    throw new PromptImportError('tooManyRows');
  }
  return rows;
}

function normalizeExcelCell(cell: unknown): PromptImportCell {
  if (cell == null) {
    return null;
  }
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime()) ? '' : cell.toISOString();
  }
  if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
    return cell;
  }
  return String(cell);
}

export function normalizePromptImportExcelSheets(rawSheets: ExcelSheet[]): PromptImportSheet[] {
  if (rawSheets.length > PROMPT_IMPORT_MAX_SHEETS) {
    throw new PromptImportError('tooManySheets');
  }

  let rowCount = 0;
  return rawSheets.map((sheet, index) => {
    rowCount += sheet.data.length;
    if (rowCount > PROMPT_IMPORT_MAX_PARSED_ROWS) {
      throw new PromptImportError('tooManyRows');
    }
    return {
      name: sheet.sheet.trim() || `Sheet ${index + 1}`,
      rows: sheet.data.map((row) => row.map(normalizeExcelCell)),
    };
  });
}

async function parseXlsxDirect(buffer: ArrayBuffer): Promise<ExcelSheet[]> {
  try {
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    return await readXlsxFile(buffer);
  } catch (error) {
    if (error instanceof PromptImportError) {
      throw error;
    }
    throw new PromptImportError('invalidXlsx');
  }
}

async function parseXlsxWithWorker(
  buffer: ArrayBuffer,
  signal?: AbortSignal,
): Promise<ExcelSheet[]> {
  if (typeof Worker === 'undefined') {
    return parseXlsxDirect(buffer);
  }

  const { default: PromptImportXlsxWorker } = await import('./xlsxPromptImport.worker?worker');
  throwIfAborted(signal);

  return new Promise<ExcelSheet[]>((resolve, reject) => {
    const worker = new PromptImportXlsxWorker();
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', handleAbort);
      worker.terminate();
      callback();
    };
    const handleAbort = () => finish(() => reject(new PromptImportError('aborted')));

    worker.onmessage = (event: MessageEvent<XlsxWorkerMessage>) => {
      const message = event.data;
      if (message.type === 'success') {
        finish(() => resolve(message.sheets));
      } else {
        finish(() => reject(new PromptImportError('invalidXlsx')));
      }
    };
    worker.onerror = () => finish(() => reject(new PromptImportError('invalidXlsx')));
    signal?.addEventListener('abort', handleAbort, { once: true });
    worker.postMessage({ buffer }, [buffer]);
  });
}

function sheetNameFromFile(fileName: string): string {
  const name = fileName.replace(/\.[^.]+$/, '').trim();
  return name || 'Prompts';
}

export async function parsePromptImportFile(
  file: PromptImportFile,
  options: ParsePromptImportOptions = {},
): Promise<PromptImportWorkbook> {
  if (file.size > PROMPT_IMPORT_MAX_FILE_BYTES) {
    throw new PromptImportError('fileTooLarge');
  }
  if (file.size === 0) {
    throw new PromptImportError('emptyFile');
  }

  const extension = resolveFileExtension(file.name);
  const reportProgress = options.onProgress ?? (() => undefined);
  throwIfAborted(options.signal);
  reportProgress(0.05);

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new PromptImportError('invalidFile');
  }
  throwIfAborted(options.signal);
  reportProgress(0.2);

  if (extension === 'xlsx') {
    const sheets = normalizePromptImportExcelSheets(await parseXlsxWithWorker(buffer, options.signal));
    throwIfAborted(options.signal);
    reportProgress(1);
    return {
      fileName: file.name,
      sheets,
      warnings: [],
    };
  }

  const { text, warnings } = decodeTextFile(buffer);
  throwIfAborted(options.signal);
  const rows = extension === 'txt'
    ? parseTxtText(text, options.txtMode ?? 'nonEmptyLines')
    : parseDelimitedText(text, extension === 'csv' ? ',' : '\t');
  reportProgress(1);

  return {
    fileName: file.name,
    sheets: [{ name: sheetNameFromFile(file.name), rows }],
    warnings,
  };
}
