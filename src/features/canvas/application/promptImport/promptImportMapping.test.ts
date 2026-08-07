import { describe, expect, it } from 'vitest';

import {
  PROMPT_IMPORT_NODE_COLUMN_GAP,
  PROMPT_IMPORT_NODE_HEIGHT,
  PROMPT_IMPORT_NODE_WIDTH,
  buildPromptImportNodeDrafts,
  buildPromptImportRows,
  clampPromptImportRangeValue,
  getPromptImportNodeBounds,
  getPromptImportPreviewRows,
  promptImportColumnLabel,
} from './index';

describe('prompt import mapping', () => {
  const sheet = {
    name: 'Prompts',
    rows: [
      ['name', 'prompt'],
      ['Opening', 'Rainy street'],
      ['', ''],
      ['Duplicate', 'Rainy street'],
      [null, 'Quiet station'],
      ['Outside range', 'Ignore me'],
    ],
  };

  it('maps columns and range, skips empty prompts, and preserves duplicates', () => {
    const result = buildPromptImportRows({
      sheet,
      hasHeader: true,
      promptColumnIndex: 1,
      nameColumnIndex: 0,
      rangeStart: 1,
      rangeEnd: 4,
    });

    expect(result.selectedRowCount).toBe(4);
    expect(result.rows).toEqual([
      { sourceRowNumber: 2, prompt: 'Rainy street', name: 'Opening' },
      { sourceRowNumber: 4, prompt: 'Rainy street', name: 'Duplicate' },
      { sourceRowNumber: 5, prompt: 'Quiet station', name: null },
    ]);
    expect(result.skipped).toEqual([{ sourceRowNumber: 3, reason: 'emptyPrompt' }]);
    expect(result.duplicateCount).toBe(1);
  });

  it('lays nodes out on a stable grid and assigns only missing names', () => {
    const mapped = buildPromptImportRows({
      sheet,
      hasHeader: true,
      promptColumnIndex: 1,
      nameColumnIndex: 0,
      rangeStart: 1,
      rangeEnd: 4,
    });
    const drafts = buildPromptImportNodeDrafts(mapped.rows, { x: 100, y: 200 }, (index) => `Prompt ${index}`);

    expect(drafts[0]).toMatchObject({
      position: { x: 100, y: 200 },
      data: { displayName: 'Opening', prompt: 'Rainy street' },
    });
    expect(drafts[2]).toMatchObject({
      position: {
        x: 100 + 2 * (PROMPT_IMPORT_NODE_WIDTH + PROMPT_IMPORT_NODE_COLUMN_GAP),
        y: 200,
      },
      data: { displayName: 'Prompt 3', prompt: 'Quiet station' },
    });
    expect(drafts[1].position.x).toBe(100 + PROMPT_IMPORT_NODE_WIDTH + PROMPT_IMPORT_NODE_COLUMN_GAP);

    expect(getPromptImportNodeBounds(drafts)).toEqual({
      x: 100,
      y: 200,
      width: 3 * PROMPT_IMPORT_NODE_WIDTH + 2 * PROMPT_IMPORT_NODE_COLUMN_GAP,
      height: PROMPT_IMPORT_NODE_HEIGHT,
    });
  });

  it('returns no bounds for an empty import and clamps range controls to the sheet', () => {
    expect(getPromptImportNodeBounds([])).toBeNull();
    expect(clampPromptImportRangeValue(Number.NaN, 8)).toBe(1);
    expect(clampPromptImportRangeValue(-10, 8)).toBe(1);
    expect(clampPromptImportRangeValue(4.9, 8)).toBe(4);
    expect(clampPromptImportRangeValue(99, 8)).toBe(8);
    expect(clampPromptImportRangeValue(1, 0)).toBe(0);
  });

  it('formats spreadsheet column labels beyond Z', () => {
    expect([0, 25, 26, 27, 51, 52].map(promptImportColumnLabel))
      .toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA']);
  });

  it('caps previews at the first 50 selected rows', () => {
    const preview = getPromptImportPreviewRows({
      name: 'Large',
      rows: [
        ['prompt'],
        ...Array.from({ length: 75 }, (_, index) => [`Prompt ${index + 1}`]),
      ],
    }, true, 1, 75);

    expect(preview).toHaveLength(50);
    expect(preview[0]).toEqual({ sourceRowNumber: 2, cells: ['Prompt 1'] });
    expect(preview[49]).toEqual({ sourceRowNumber: 51, cells: ['Prompt 50'] });
  });
});
