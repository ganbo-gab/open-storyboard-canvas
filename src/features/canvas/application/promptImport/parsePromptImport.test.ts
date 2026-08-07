import { describe, expect, it } from 'vitest';

import csvFixture from './__fixtures__/prompts.csv?raw';
import tsvFixture from './__fixtures__/prompts.tsv?raw';
import txtFixture from './__fixtures__/prompts.txt?raw';
import xlsxBase64Fixture from './__fixtures__/prompts.xlsx.base64?raw';

import {
  PROMPT_IMPORT_MAX_FILE_BYTES,
  PROMPT_IMPORT_MAX_PARSED_ROWS,
  PromptImportError,
  normalizePromptImportExcelSheets,
  parseDelimitedText,
  parsePromptImportFile,
  parseTxtText,
} from './index';
import { parsePromptImportXlsxWorkerBuffer } from './xlsxPromptImportParser';

function textFile(name: string, text: string): File {
  return new File([text], name);
}

describe('prompt import parsers', () => {
  it('parses TXT as non-empty lines or blank-line paragraphs', async () => {
    const text = txtFixture;

    expect(parseTxtText(text, 'nonEmptyLines')).toEqual([
      ['雨夜街道，霓虹倒影'],
      ['角色走进车站。'],
      ['她停下脚步，回头看向镜头。'],
      ['A quiet station at dawn.'],
    ]);
    expect(parseTxtText(text, 'paragraphs')).toEqual([
      ['雨夜街道，霓虹倒影'],
      ['角色走进车站。\n她停下脚步，回头看向镜头。'],
      ['A quiet station at dawn.'],
    ]);

    const workbook = await parsePromptImportFile(textFile('prompts.txt', text), {
      txtMode: 'paragraphs',
    });
    expect(workbook.sheets[0].rows).toHaveLength(3);
  });

  it('parses CSV quotes, commas, multiline prompts, blank rows, and duplicates', async () => {
    const text = csvFixture;
    const rows = parseDelimitedText(text, ',');

    expect(rows[1]).toEqual(['镜头一', '雨夜街道，霓虹倒影', '中文']);
    expect(rows[2]).toEqual(['镜头二', '角色说："出发"\n随后转身', '多行']);
    expect(rows[3]).toEqual(['', '', '空行']);
    expect(rows[5][1]).toBe('雨夜街道，霓虹倒影');

    const workbook = await parsePromptImportFile(textFile('prompts.csv', text));
    expect(workbook.sheets[0].rows).toEqual(rows);
  });

  it('parses TSV quotes, multiline prompts, English, Chinese, and blank rows', async () => {
    const text = tsvFixture;
    const workbook = await parsePromptImportFile(textFile('prompts.tsv', text));

    expect(workbook.sheets[0].rows[1]).toEqual(['镜头一', '室内，柔和侧光', '中文']);
    expect(workbook.sheets[0].rows[2][1]).toBe('第一行\n第二行');
    expect(workbook.sheets[0].rows[3]).toEqual(['', '', '空行']);
    expect(workbook.sheets[0].rows[4][1]).toBe('She whispers "wait"');
  });

  it('dynamically parses a multi-sheet XLSX fixture', async () => {
    const base64 = xlsxBase64Fixture.trim();
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const workbook = await parsePromptImportFile(new File([
      bytes,
    ], 'prompts.xlsx'));

    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['主表', 'English']);
    expect(workbook.sheets[0].rows[1]).toEqual(['镜头一', '雨夜街道，霓虹倒影', '中文']);
    expect(workbook.sheets[0].rows[2][1]).toBe('角色说："出发"\n随后转身');
    expect(workbook.sheets[1].rows[2][1]).toBe('She whispers "wait"');
  });

  it('parses XLSX through the dedicated worker-safe adapter without nested workers', async () => {
    const bytes = Uint8Array.from(
      atob(xlsxBase64Fixture.trim()),
      (character) => character.charCodeAt(0),
    );

    const sheets = await parsePromptImportXlsxWorkerBuffer(bytes.buffer);

    expect(sheets.map((sheet) => sheet.sheet)).toEqual(['主表', 'English']);
    expect(sheets[0].data[1]).toEqual(['镜头一', '雨夜街道，霓虹倒影', '中文']);
  });

  it('rejects unsupported, oversized, malformed, and over-row-limit input', async () => {
    await expect(parsePromptImportFile(textFile('legacy.xls', 'not xls')))
      .rejects.toMatchObject({ code: 'unsupportedFileType' });
    await expect(parsePromptImportFile({
      name: 'large.csv',
      size: PROMPT_IMPORT_MAX_FILE_BYTES + 1,
      arrayBuffer: async () => new ArrayBuffer(0),
    })).rejects.toMatchObject({ code: 'fileTooLarge' });
    expect(() => parseDelimitedText('name,prompt\nrow,"unfinished', ','))
      .toThrowError(PromptImportError);
    expect(() => parseDelimitedText(
      Array.from({ length: PROMPT_IMPORT_MAX_PARSED_ROWS + 1 }, () => 'prompt').join('\n'),
      ',',
    )).toThrowError(PromptImportError);
  });

  it('supports aborting before file parsing begins', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(parsePromptImportFile(textFile('prompts.txt', 'one'), {
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('rejects an empty file and workbooks over the 20-sheet limit', async () => {
    await expect(parsePromptImportFile(textFile('empty.txt', '')))
      .rejects.toMatchObject({ code: 'emptyFile' });
    expect(() => normalizePromptImportExcelSheets(Array.from({ length: 21 }, (_, index) => ({
      sheet: `Sheet ${index + 1}`,
      data: [],
    })))).toThrowError(PromptImportError);
  });

  it('falls back to GB18030 with a warning and recognizes UTF-16 BOM input', async () => {
    const gb18030 = new File([
      new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0xca, 0xc0, 0xbd, 0xe7]),
    ], 'gb18030.txt');
    const gbWorkbook = await parsePromptImportFile(gb18030);
    expect(gbWorkbook.sheets[0].rows).toEqual([['你好'], ['世界']]);
    expect(gbWorkbook.warnings).toEqual(['decodedAsGb18030']);

    const utf16Text = '中文\nEnglish';
    const utf16Bytes = new Uint8Array(2 + utf16Text.length * 2);
    utf16Bytes.set([0xff, 0xfe]);
    for (let index = 0; index < utf16Text.length; index += 1) {
      const code = utf16Text.charCodeAt(index);
      utf16Bytes[2 + index * 2] = code & 0xff;
      utf16Bytes[3 + index * 2] = code >> 8;
    }
    const utf16Workbook = await parsePromptImportFile(new File([utf16Bytes], 'utf16.txt'));
    expect(utf16Workbook.sheets[0].rows).toEqual([['中文'], ['English']]);
    expect(utf16Workbook.warnings).toEqual([]);
  });
});
