import readXlsxFile, { type Sheet as ExcelSheet } from 'read-excel-file/universal';

export async function parsePromptImportXlsxWorkerBuffer(
  buffer: ArrayBuffer,
): Promise<ExcelSheet[]> {
  return await readXlsxFile(buffer);
}
