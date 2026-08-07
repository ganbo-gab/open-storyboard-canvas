import type { PromptImportMappedRow, PromptImportMappingResult, PromptImportNodeDraft, PromptImportSheet } from './types';

export const PROMPT_IMPORT_MAX_NODES = 500;
export const PROMPT_IMPORT_PREVIEW_ROWS = 50;
export const PROMPT_IMPORT_NODE_WIDTH = 680;
export const PROMPT_IMPORT_NODE_HEIGHT = 380;
export const PROMPT_IMPORT_NODE_COLUMN_GAP = 48;
export const PROMPT_IMPORT_NODE_ROW_GAP = 40;

export interface BuildPromptImportRowsOptions {
  sheet: PromptImportSheet;
  hasHeader: boolean;
  promptColumnIndex: number;
  nameColumnIndex?: number | null;
  rangeStart?: number;
  rangeEnd?: number;
}

export interface PromptImportColumnOption {
  index: number;
  label: string;
}

export interface PromptImportPreviewRow {
  sourceRowNumber: number;
  cells: string[];
}

export function promptImportCellToText(cell: unknown): string {
  if (cell == null) {
    return '';
  }
  return String(cell);
}

export function getPromptImportColumnCount(sheet: PromptImportSheet): number {
  return sheet.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
}

export function getPromptImportDataRowCount(sheet: PromptImportSheet, hasHeader: boolean): number {
  return Math.max(0, sheet.rows.length - (hasHeader ? 1 : 0));
}

export function clampPromptImportRangeValue(value: number, dataRowCount: number): number {
  const maximum = Math.max(0, Math.floor(dataRowCount));
  if (maximum === 0) {
    return 0;
  }
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

export function promptImportColumnLabel(index: number): string {
  let value = Math.max(0, Math.floor(index));
  let label = '';
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

export function getPromptImportColumnOptions(
  sheet: PromptImportSheet,
  hasHeader: boolean,
): PromptImportColumnOption[] {
  const columnCount = getPromptImportColumnCount(sheet);
  const header = hasHeader ? sheet.rows[0] ?? [] : [];
  return Array.from({ length: columnCount }, (_, index) => {
    const headerText = promptImportCellToText(header[index]).trim();
    const columnLabel = promptImportColumnLabel(index);
    return {
      index,
      label: headerText ? `${columnLabel} - ${headerText}` : columnLabel,
    };
  });
}

export function inferPromptImportColumns(sheet: PromptImportSheet): {
  promptColumnIndex: number;
  nameColumnIndex: number | null;
} {
  const header = sheet.rows[0] ?? [];
  const normalizedHeaders = header.map((cell) => promptImportCellToText(cell).trim().toLowerCase());
  const promptColumnIndex = normalizedHeaders.findIndex((value) => (
    /^(prompt|prompt text|description|提示|提示词|描述)$/.test(value)
  ));
  const nameColumnIndex = normalizedHeaders.findIndex((value) => (
    /^(name|title|shot|名称|标题|镜头名)$/.test(value)
  ));
  return {
    promptColumnIndex: promptColumnIndex >= 0 ? promptColumnIndex : 0,
    nameColumnIndex: nameColumnIndex >= 0 ? nameColumnIndex : null,
  };
}

export function getPromptImportPreviewRows(
  sheet: PromptImportSheet,
  hasHeader: boolean,
  rangeStart: number,
  rangeEnd: number,
  limit = PROMPT_IMPORT_PREVIEW_ROWS,
): PromptImportPreviewRow[] {
  const dataOffset = hasHeader ? 1 : 0;
  const dataRowCount = getPromptImportDataRowCount(sheet, hasHeader);
  if (dataRowCount === 0) {
    return [];
  }
  const start = clampPromptImportRangeValue(rangeStart, dataRowCount);
  const end = clampPromptImportRangeValue(rangeEnd, dataRowCount);
  if (start > end) {
    return [];
  }

  return sheet.rows
    .slice(dataOffset + start - 1, dataOffset + end)
    .slice(0, Math.max(0, Math.floor(limit)))
    .map((row, index) => ({
      sourceRowNumber: dataOffset + start + index,
      cells: row.map(promptImportCellToText),
    }));
}

export function buildPromptImportRows(options: BuildPromptImportRowsOptions): PromptImportMappingResult {
  const dataOffset = options.hasHeader ? 1 : 0;
  const dataRowCount = Math.max(0, options.sheet.rows.length - dataOffset);
  const mappedRows: PromptImportMappedRow[] = [];
  const skipped: PromptImportMappingResult['skipped'] = [];
  const seenPrompts = new Set<string>();
  let duplicateCount = 0;

  if (dataRowCount === 0) {
    return { rows: [], skipped: [], duplicateCount: 0, selectedRowCount: 0 };
  }
  const rangeStart = clampPromptImportRangeValue(options.rangeStart ?? 1, dataRowCount);
  const rangeEnd = clampPromptImportRangeValue(options.rangeEnd ?? dataRowCount, dataRowCount);
  if (rangeStart > rangeEnd) {
    return { rows: [], skipped: [], duplicateCount: 0, selectedRowCount: 0 };
  }

  for (let dataIndex = rangeStart - 1; dataIndex < rangeEnd; dataIndex += 1) {
    const physicalIndex = dataOffset + dataIndex;
    const row = options.sheet.rows[physicalIndex] ?? [];
    const sourceRowNumber = physicalIndex + 1;
    const prompt = promptImportCellToText(row[options.promptColumnIndex]).trim();
    if (!prompt) {
      skipped.push({ sourceRowNumber, reason: 'emptyPrompt' });
      continue;
    }

    if (seenPrompts.has(prompt)) {
      duplicateCount += 1;
    }
    seenPrompts.add(prompt);
    const rawName = options.nameColumnIndex == null
      ? ''
      : promptImportCellToText(row[options.nameColumnIndex]).trim();
    mappedRows.push({
      sourceRowNumber,
      prompt,
      name: rawName || null,
    });
  }

  return {
    rows: mappedRows,
    skipped,
    duplicateCount,
    selectedRowCount: rangeEnd - rangeStart + 1,
  };
}

export function buildPromptImportNodeDrafts(
  rows: PromptImportMappedRow[],
  origin: { x: number; y: number },
  defaultName: (index: number) => string,
): PromptImportNodeDraft[] {
  const columns = Math.min(20, Math.max(1, Math.ceil(Math.sqrt(rows.length * 1.5))));
  const stepX = PROMPT_IMPORT_NODE_WIDTH + PROMPT_IMPORT_NODE_COLUMN_GAP;
  const stepY = PROMPT_IMPORT_NODE_HEIGHT + PROMPT_IMPORT_NODE_ROW_GAP;

  return rows.map((row, index) => ({
    position: {
      x: origin.x + (index % columns) * stepX,
      y: origin.y + Math.floor(index / columns) * stepY,
    },
    dimensions: {
      width: PROMPT_IMPORT_NODE_WIDTH,
      height: PROMPT_IMPORT_NODE_HEIGHT,
    },
    data: {
      displayName: row.name ?? defaultName(index + 1),
      prompt: row.prompt,
    },
  }));
}

export function getPromptImportNodeBounds(
  drafts: PromptImportNodeDraft[],
): { x: number; y: number; width: number; height: number } | null {
  if (drafts.length === 0) {
    return null;
  }

  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;

  for (const draft of drafts) {
    minimumX = Math.min(minimumX, draft.position.x);
    minimumY = Math.min(minimumY, draft.position.y);
    maximumX = Math.max(maximumX, draft.position.x + draft.dimensions.width);
    maximumY = Math.max(maximumY, draft.position.y + draft.dimensions.height);
  }

  return {
    x: minimumX,
    y: minimumY,
    width: maximumX - minimumX,
    height: maximumY - minimumY,
  };
}
