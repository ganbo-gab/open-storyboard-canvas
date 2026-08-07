import type { CanvasNodeData } from '@/features/canvas/domain/canvasNodes';

export type PromptImportCell = string | number | boolean | null;

export interface PromptImportSheet {
  name: string;
  rows: PromptImportCell[][];
}

export interface PromptImportWorkbook {
  fileName: string;
  sheets: PromptImportSheet[];
  warnings: PromptImportWarning[];
}

export type PromptImportWarning = 'decodedAsGb18030';

export type PromptImportErrorCode =
  | 'aborted'
  | 'emptyFile'
  | 'fileTooLarge'
  | 'invalidDelimitedFile'
  | 'invalidFile'
  | 'invalidXlsx'
  | 'tooManyRows'
  | 'tooManySheets'
  | 'unsupportedFileType';

export class PromptImportError extends Error {
  constructor(public readonly code: PromptImportErrorCode) {
    super(code);
    this.name = 'PromptImportError';
  }
}

export type PromptImportTxtMode = 'nonEmptyLines' | 'paragraphs';

export interface ParsePromptImportOptions {
  txtMode?: PromptImportTxtMode;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

export interface PromptImportMappedRow {
  sourceRowNumber: number;
  prompt: string;
  name: string | null;
}

export interface PromptImportSkippedRow {
  sourceRowNumber: number;
  reason: 'emptyPrompt';
}

export interface PromptImportMappingResult {
  rows: PromptImportMappedRow[];
  skipped: PromptImportSkippedRow[];
  duplicateCount: number;
  selectedRowCount: number;
}

export interface PromptImportNodeDraft {
  position: { x: number; y: number };
  dimensions: { width: number; height: number };
  data: Partial<CanvasNodeData>;
}
