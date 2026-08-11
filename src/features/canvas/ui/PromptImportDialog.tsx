import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { FileSpreadsheet, FileUp, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiCheckbox, UiInput, UiSelect } from '@/components/ui';
import {
  UI_CONTENT_OVERLAY_INSET_CLASS,
  UI_DIALOG_TRANSITION_MS,
} from '@/components/ui/motion';
import { useDialogTransition } from '@/components/ui/useDialogTransition';
import { useModalFocus } from '@/components/ui/useModalFocus';
import {
  PROMPT_IMPORT_MAX_NODES,
  PROMPT_IMPORT_PREVIEW_ROWS,
  PromptImportError,
  buildPromptImportRows,
  clampPromptImportRangeValue,
  getPromptImportColumnOptions,
  getPromptImportDataRowCount,
  getPromptImportPreviewRows,
  inferPromptImportColumns,
  parsePromptImportFile,
  type PromptImportErrorCode,
  type PromptImportMappedRow,
  type PromptImportTxtMode,
  type PromptImportWorkbook,
} from '@/features/canvas/application/promptImport';

interface PromptImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (rows: PromptImportMappedRow[], options: { fitView: boolean }) => void;
}

type DialogStage = 'select' | 'mapping' | 'confirm';

interface MappingDefaults {
  hasHeader: boolean;
  promptColumnIndex: number;
  nameColumnIndex: number | null;
  rangeStart: number;
  rangeEnd: number;
}

function isTxtFile(file: File | null): boolean {
  return file?.name.toLowerCase().endsWith('.txt') ?? false;
}

function initialMappingDefaults(
  workbook: PromptImportWorkbook,
  file: File,
  sheetIndex = 0,
): MappingDefaults {
  const sheet = workbook.sheets[sheetIndex];
  const hasHeader = !isTxtFile(file) && (sheet?.rows.length ?? 0) > 1;
  const dataRowCount = sheet ? getPromptImportDataRowCount(sheet, hasHeader) : 0;
  const inferred = sheet ? inferPromptImportColumns(sheet) : {
    promptColumnIndex: 0,
    nameColumnIndex: null,
  };
  return {
    hasHeader,
    promptColumnIndex: inferred.promptColumnIndex,
    nameColumnIndex: inferred.nameColumnIndex,
    rangeStart: dataRowCount > 0 ? 1 : 0,
    rangeEnd: dataRowCount,
  };
}

function resolveErrorCode(error: unknown): PromptImportErrorCode {
  return error instanceof PromptImportError ? error.code : 'invalidFile';
}

export function PromptImportDialog({ isOpen, onClose, onImport }: PromptImportDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const abortControllerRef = useRef<AbortController | null>(null);
  const { shouldRender, isVisible } = useDialogTransition(isOpen, UI_DIALOG_TRANSITION_MS);

  const [stage, setStage] = useState<DialogStage>('select');
  const [file, setFile] = useState<File | null>(null);
  const [txtMode, setTxtMode] = useState<PromptImportTxtMode>('nonEmptyLines');
  const [workbook, setWorkbook] = useState<PromptImportWorkbook | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [hasHeader, setHasHeader] = useState(false);
  const [promptColumnIndex, setPromptColumnIndex] = useState(0);
  const [nameColumnIndex, setNameColumnIndex] = useState<number | null>(null);
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [fitView, setFitView] = useState(true);
  const [isParsing, setIsParsing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errorCode, setErrorCode] = useState<PromptImportErrorCode | null>(null);

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setStage('select');
    setFile(null);
    setTxtMode('nonEmptyLines');
    setWorkbook(null);
    setSheetIndex(0);
    setHasHeader(false);
    setPromptColumnIndex(0);
    setNameColumnIndex(null);
    setRangeStart(1);
    setRangeEnd(0);
    setFitView(true);
    setIsParsing(false);
    setProgress(0);
    setErrorCode(null);
  }, []);

  const requestClose = useCallback(() => {
    abortControllerRef.current?.abort();
    onClose();
  }, [onClose]);
  const { dialogRef, onKeyDown } = useModalFocus({
    isOpen: isOpen && shouldRender,
    onClose: requestClose,
  });

  useEffect(() => {
    if (!isOpen) {
      reset();
    }
  }, [isOpen, reset]);

  useEffect(() => {
    if (!isOpen || !shouldRender || stage === 'select') {
      return;
    }

    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      dialog.focus({ preventScroll: true });
    }
  }, [isOpen, shouldRender, stage]);

  const selectedSheet = workbook?.sheets[sheetIndex] ?? null;
  const columnOptions = useMemo(
    () => selectedSheet ? getPromptImportColumnOptions(selectedSheet, hasHeader) : [],
    [hasHeader, selectedSheet],
  );
  const dataRowCount = selectedSheet
    ? getPromptImportDataRowCount(selectedSheet, hasHeader)
    : 0;
  const mapping = useMemo(() => selectedSheet ? buildPromptImportRows({
    sheet: selectedSheet,
    hasHeader,
    promptColumnIndex,
    nameColumnIndex,
    rangeStart,
    rangeEnd,
  }) : null, [
    hasHeader,
    nameColumnIndex,
    promptColumnIndex,
    rangeEnd,
    rangeStart,
    selectedSheet,
  ]);
  const previewRows = useMemo(() => selectedSheet ? getPromptImportPreviewRows(
    selectedSheet,
    hasHeader,
    rangeStart,
    rangeEnd,
    PROMPT_IMPORT_PREVIEW_ROWS,
  ) : [], [hasHeader, rangeEnd, rangeStart, selectedSheet]);
  const isOverNodeLimit = (mapping?.rows.length ?? 0) > PROMPT_IMPORT_MAX_NODES;

  const applyDefaults = useCallback((defaults: MappingDefaults) => {
    setHasHeader(defaults.hasHeader);
    setPromptColumnIndex(defaults.promptColumnIndex);
    setNameColumnIndex(defaults.nameColumnIndex);
    setRangeStart(defaults.rangeStart);
    setRangeEnd(defaults.rangeEnd);
  }, []);

  const handleParse = useCallback(async () => {
    if (!file || isParsing) {
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsParsing(true);
    setProgress(0);
    setErrorCode(null);
    try {
      const parsedWorkbook = await parsePromptImportFile(file, {
        txtMode,
        signal: controller.signal,
        onProgress: setProgress,
      });
      if (abortControllerRef.current !== controller) {
        return;
      }
      setWorkbook(parsedWorkbook);
      setSheetIndex(0);
      applyDefaults(initialMappingDefaults(parsedWorkbook, file));
      setStage('mapping');
    } catch (error) {
      if (abortControllerRef.current === controller) {
        setErrorCode(resolveErrorCode(error));
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setIsParsing(false);
      }
    }
  }, [applyDefaults, file, isParsing, txtMode]);

  const handleSheetChange = useCallback((nextSheetIndex: number) => {
    if (!workbook || !file) {
      return;
    }
    setSheetIndex(nextSheetIndex);
    applyDefaults(initialMappingDefaults(workbook, file, nextSheetIndex));
    setStage('mapping');
  }, [applyDefaults, file, workbook]);

  const handleHeaderChange = useCallback((nextHasHeader: boolean) => {
    const nextDataRowCount = selectedSheet
      ? getPromptImportDataRowCount(selectedSheet, nextHasHeader)
      : 0;
    setHasHeader(nextHasHeader);
    setRangeStart(nextDataRowCount > 0 ? 1 : 0);
    setRangeEnd(nextDataRowCount);
  }, [selectedSheet]);

  const handleRangeStartChange = useCallback((value: number) => {
    const nextValue = clampPromptImportRangeValue(value, dataRowCount);
    setRangeStart(nextValue);
    if (nextValue > rangeEnd) {
      setRangeEnd(nextValue);
    }
  }, [dataRowCount, rangeEnd]);

  const handleRangeEndChange = useCallback((value: number) => {
    const nextValue = clampPromptImportRangeValue(value, dataRowCount);
    setRangeEnd(nextValue);
    if (nextValue < rangeStart) {
      setRangeStart(nextValue);
    }
  }, [dataRowCount, rangeStart]);

  const handleConfirmImport = useCallback(() => {
    if (!mapping || mapping.rows.length === 0 || isOverNodeLimit) {
      return;
    }
    onImport(mapping.rows, { fitView });
    onClose();
  }, [fitView, isOverNodeLimit, mapping, onClose, onImport]);

  if (!shouldRender) {
    return null;
  }

  return createPortal((
    <div
      className={`fixed ${UI_CONTENT_OVERLAY_INSET_CLASS} z-[130] flex items-center justify-center p-3 sm:p-5`}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheelCapture={(event) => event.stopPropagation()}
      onTouchMoveCapture={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className={`absolute inset-0 bg-black/55 transition-opacity duration-[180ms] ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        onClick={requestClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`relative flex max-h-[calc(100vh-64px)] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-[var(--ui-border-soft)] bg-[var(--ui-surface-panel)] text-text-dark shadow-[var(--ui-shadow-panel)] transition-[opacity,transform] duration-[180ms] ${isVisible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--ui-border-soft)] px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold">{t('promptImport.title')}</h2>
            <p id={descriptionId} className="mt-0.5 text-xs text-text-muted">
              {t(`promptImport.stage.${stage}`)}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label={t('common.close')}
            title={t('common.close')}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-[var(--canvas-node-menu-hover)] hover:text-text-dark"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {stage === 'select' && (
            <div className="space-y-4">
              <label className="block space-y-1.5 text-sm font-medium">
                <span>{t('promptImport.fileLabel')}</span>
                <UiInput
                  data-autofocus="true"
                  type="file"
                  accept=".txt,.csv,.tsv,.xlsx"
                  disabled={isParsing}
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setWorkbook(null);
                    setErrorCode(null);
                    setProgress(0);
                  }}
                  className="min-h-10 py-1.5 file:mr-3 file:rounded-md file:border-0 file:bg-accent/15 file:px-3 file:py-1 file:text-xs file:font-medium file:text-accent"
                />
              </label>
              <p className="text-xs text-text-muted">{t('promptImport.supportedFiles')}</p>

              {isTxtFile(file) && (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">{t('promptImport.txtMode.label')}</legend>
                  <div className="inline-flex max-w-full rounded-md border border-[var(--ui-border-soft)] p-1">
                    {(['nonEmptyLines', 'paragraphs'] as PromptImportTxtMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={txtMode === mode}
                        onClick={() => setTxtMode(mode)}
                        className={`min-h-9 rounded px-3 py-1.5 text-xs transition-colors ${txtMode === mode ? 'bg-accent text-white' : 'text-text-muted hover:text-text-dark'}`}
                      >
                        {t(`promptImport.txtMode.${mode}`)}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              {isParsing && (
                <div className="space-y-2" role="status" aria-live="polite">
                  <div className="flex items-center justify-between text-xs text-text-muted">
                    <span>{t('promptImport.parsing')}</span>
                    <span>{Math.round(progress * 100)}%</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={t('promptImport.parsing')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(progress * 100)}
                    className="h-1.5 overflow-hidden rounded bg-[var(--canvas-node-field-bg)]"
                  >
                    <div
                      className="h-full w-full origin-left bg-accent transition-transform"
                      style={{ transform: `scaleX(${Math.max(0, Math.min(1, progress))})` }}
                    />
                  </div>
                </div>
              )}

              {errorCode && (
                <p role="alert" className="rounded-md border border-red-500/35 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                  {t(`promptImport.errors.${errorCode}`)}
                </p>
              )}
            </div>
          )}

          {stage === 'mapping' && selectedSheet && mapping && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {workbook && workbook.sheets.length > 1 && (
                  <label className="space-y-1.5 text-xs font-medium">
                    <span>{t('promptImport.sheet')}</span>
                    <UiSelect
                      aria-label={t('promptImport.sheet')}
                      value={String(sheetIndex)}
                      onChange={(event) => handleSheetChange(Number(event.target.value))}
                    >
                      {workbook.sheets.map((sheet, index) => (
                        <option key={`${sheet.name}-${index}`} value={index}>{sheet.name}</option>
                      ))}
                    </UiSelect>
                  </label>
                )}
                <label className="space-y-1.5 text-xs font-medium">
                  <span>{t('promptImport.promptColumn')}</span>
                  <UiSelect
                    aria-label={t('promptImport.promptColumn')}
                    value={String(promptColumnIndex)}
                    onChange={(event) => setPromptColumnIndex(Number(event.target.value))}
                  >
                    {columnOptions.map((option) => (
                      <option key={option.index} value={option.index}>{option.label}</option>
                    ))}
                  </UiSelect>
                </label>
                <label className="space-y-1.5 text-xs font-medium">
                  <span>{t('promptImport.nameColumn')}</span>
                  <UiSelect
                    aria-label={t('promptImport.nameColumn')}
                    value={nameColumnIndex == null ? '-1' : String(nameColumnIndex)}
                    onChange={(event) => setNameColumnIndex(Number(event.target.value) < 0 ? null : Number(event.target.value))}
                  >
                    <option value="-1">{t('promptImport.noNameColumn')}</option>
                    {columnOptions.map((option) => (
                      <option key={option.index} value={option.index}>{option.label}</option>
                    ))}
                  </UiSelect>
                </label>
                <label className="flex items-end gap-2 pb-1 text-xs font-medium">
                  <UiCheckbox checked={hasHeader} onCheckedChange={handleHeaderChange} />
                  <span>{t('promptImport.hasHeader')}</span>
                </label>
              </div>

              <fieldset className="grid gap-3 sm:grid-cols-2">
                <legend className="mb-2 text-sm font-medium">{t('promptImport.range')}</legend>
                <label className="space-y-1.5 text-xs font-medium">
                  <span>{t('promptImport.rangeStart')}</span>
                  <UiInput
                    type="number"
                    min={dataRowCount > 0 ? 1 : 0}
                    max={dataRowCount}
                    value={rangeStart}
                    disabled={dataRowCount === 0}
                    onChange={(event) => handleRangeStartChange(Number(event.target.value))}
                  />
                </label>
                <label className="space-y-1.5 text-xs font-medium">
                  <span>{t('promptImport.rangeEnd')}</span>
                  <UiInput
                    type="number"
                    min={dataRowCount > 0 ? 1 : 0}
                    max={dataRowCount}
                    value={rangeEnd}
                    disabled={dataRowCount === 0}
                    onChange={(event) => handleRangeEndChange(Number(event.target.value))}
                  />
                </label>
              </fieldset>

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted" role="status" aria-live="polite">
                <span>{t('promptImport.totalRows', { count: dataRowCount })}</span>
                <span>{t('promptImport.validRows', { count: mapping.rows.length })}</span>
                <span>{t('promptImport.skippedRows', { count: mapping.skipped.length })}</span>
                <span>{t('promptImport.duplicateRows', { count: mapping.duplicateCount })}</span>
              </div>

              {workbook?.warnings.includes('decodedAsGb18030') && (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                  {t('promptImport.warnings.decodedAsGb18030')}
                </p>
              )}
              {isOverNodeLimit && (
                <p role="alert" className="rounded-md border border-red-500/35 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                  {t('promptImport.errors.tooManyNodes', { count: mapping.rows.length, limit: PROMPT_IMPORT_MAX_NODES })}
                </p>
              )}

              <div className="overflow-hidden rounded-md border border-[var(--ui-border-soft)]">
                <div className="flex items-center justify-between border-b border-[var(--ui-border-soft)] px-3 py-2 text-xs text-text-muted">
                  <span>{t('promptImport.preview')}</span>
                  <span>{t('promptImport.previewLimit', { count: Math.min(PROMPT_IMPORT_PREVIEW_ROWS, previewRows.length) })}</span>
                </div>
                <div className="ui-scrollbar max-h-[310px] overflow-auto">
                  <table className="min-w-full border-collapse text-left text-xs">
                    <thead className="sticky top-0 z-10 bg-[var(--ui-surface-panel)] text-text-muted">
                      <tr>
                        <th scope="col" className="border-b border-r border-[var(--ui-border-soft)] px-2 py-2 font-medium">#</th>
                        {columnOptions.map((column) => (
                          <th key={column.index} scope="col" className="min-w-36 border-b border-r border-[var(--ui-border-soft)] px-2 py-2 font-medium last:border-r-0">
                            {column.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((row) => (
                        <tr key={row.sourceRowNumber} className="align-top odd:bg-black/[0.03] dark:odd:bg-white/[0.02]">
                          <th scope="row" className="border-b border-r border-[var(--ui-border-soft)] px-2 py-2 font-normal text-text-muted">
                            {row.sourceRowNumber}
                          </th>
                          {columnOptions.map((column) => (
                            <td key={column.index} className="max-w-80 whitespace-pre-wrap break-words border-b border-r border-[var(--ui-border-soft)] px-2 py-2 last:border-r-0">
                              {row.cells[column.index] ?? ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {stage === 'confirm' && mapping && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-md border border-[var(--ui-border-soft)] bg-[var(--canvas-node-field-bg)] px-4 py-3">
                <FileSpreadsheet className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                <div className="min-w-0">
                  <p className="font-medium">{t('promptImport.confirmTitle', { count: mapping.rows.length })}</p>
                  <p className="mt-1 text-sm text-text-muted">
                    {t('promptImport.confirmSummary', {
                      skipped: mapping.skipped.length,
                      duplicates: mapping.duplicateCount,
                    })}
                  </p>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <UiCheckbox checked={fitView} onCheckedChange={setFitView} />
                <span>{t('promptImport.fitImportedNodes')}</span>
              </label>
              <p className="text-sm text-text-muted">{t('promptImport.noAutomaticGeneration')}</p>
            </div>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--ui-border-soft)] px-4 py-3 sm:px-5">
          {stage === 'select' && (
            <>
              <UiButton type="button" onClick={requestClose}>{t('common.cancel')}</UiButton>
              {isParsing ? (
                <UiButton type="button" variant="primary" onClick={() => abortControllerRef.current?.abort()}>
                  {t('promptImport.cancelParsing')}
                </UiButton>
              ) : (
                <UiButton type="button" variant="primary" disabled={!file} onClick={() => void handleParse()}>
                  <FileUp className="mr-1.5 h-4 w-4" />
                  {t('promptImport.parse')}
                </UiButton>
              )}
            </>
          )}
          {stage === 'mapping' && (
            <>
              <UiButton type="button" onClick={() => setStage('select')}>{t('promptImport.back')}</UiButton>
              <UiButton
                type="button"
                variant="primary"
                disabled={!mapping || mapping.rows.length === 0 || isOverNodeLimit}
                onClick={() => setStage('confirm')}
              >
                {t('promptImport.reviewImport')}
              </UiButton>
            </>
          )}
          {stage === 'confirm' && (
            <>
              <UiButton type="button" onClick={() => setStage('mapping')}>{t('promptImport.back')}</UiButton>
              <UiButton type="button" variant="primary" onClick={handleConfirmImport}>
                {t('promptImport.importNodes', { count: mapping?.rows.length ?? 0 })}
              </UiButton>
            </>
          )}
        </footer>
      </div>
    </div>
  ), document.body);
}
