import { useCallback, useEffect, useMemo, useState } from 'react';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { UiButton, UiInput } from '@/components/ui';
import type { VisualToolEditorProps } from './types';

const MIN_GRID_SIZE = 1;
const MAX_GRID_SIZE = 8;
const DEFAULT_LINE_THICKNESS_PERCENT = 0.5;
const MAX_LINE_THICKNESS_PERCENT = 20;
const LEGACY_DEFAULT_LINE_THICKNESS_PX = 6;
const PREVIEW_VIEWPORT_HEIGHT = 'h-[min(560px,60vh)]';

interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SplitLayout {
  lineRects: OverlayRect[];
  cellRects: CellRect[];
  minCellWidth: number;
  maxCellWidth: number;
  minCellHeight: number;
  maxCellHeight: number;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return fallback;
}

function clampInteger(value: number, min: number, max: number, fallback = min): number {
  const safeValue = Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.round(safeValue)));
}

function clampDecimal(value: number, min: number, max: number, fallback = min, precision = 2): number {
  const safeValue = Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(min, Math.min(max, safeValue));
  const factor = 10 ** precision;
  return Math.round(clamped * factor) / factor;
}

function resolveMaxLineThicknessPx(rows: number, cols: number, width: number, height: number): number {
  const maxByWidth = cols > 1 ? Math.floor((width - cols) / (cols - 1)) : Number.MAX_SAFE_INTEGER;
  const maxByHeight = rows > 1 ? Math.floor((height - rows) / (rows - 1)) : Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.min(maxByWidth, maxByHeight));
}

function resolveLineThicknessPxFromPercent(
  lineThicknessPercent: number,
  rows: number,
  cols: number,
  width: number,
  height: number
): number {
  if (lineThicknessPercent <= 0) {
    return 0;
  }

  const basis = Math.max(1, Math.min(width, height));
  const rawPixelThickness = Math.max(1, Math.round((basis * lineThicknessPercent) / 100));
  const maxAllowed = resolveMaxLineThicknessPx(rows, cols, width, height);
  return clampInteger(rawPixelThickness, 0, maxAllowed);
}

function splitSizes(total: number, segments: number): number[] {
  const base = Math.floor(total / segments);
  const remainder = total % segments;

  return Array.from({ length: segments }, (_value, index) => base + (index < remainder ? 1 : 0));
}

function computeSplitLayout(
  imageWidth: number,
  imageHeight: number,
  rows: number,
  cols: number,
  lineThickness: number
): SplitLayout | null {
  const usableWidth = imageWidth - (cols - 1) * lineThickness;
  const usableHeight = imageHeight - (rows - 1) * lineThickness;

  if (usableWidth < cols || usableHeight < rows) {
    return null;
  }

  const colWidths = splitSizes(usableWidth, cols);
  const rowHeights = splitSizes(usableHeight, rows);

  const lineRects: OverlayRect[] = [];
  const xOffsets: number[] = [];
  const yOffsets: number[] = [];

  let cursorX = 0;
  for (let col = 0; col < cols; col += 1) {
    xOffsets.push(cursorX);
    cursorX += colWidths[col];
    if (col < cols - 1 && lineThickness > 0) {
      lineRects.push({
        x: cursorX,
        y: 0,
        width: lineThickness,
        height: imageHeight,
      });
      cursorX += lineThickness;
    }
  }

  let cursorY = 0;
  for (let row = 0; row < rows; row += 1) {
    yOffsets.push(cursorY);
    cursorY += rowHeights[row];
    if (row < rows - 1 && lineThickness > 0) {
      lineRects.push({
        x: 0,
        y: cursorY,
        width: imageWidth,
        height: lineThickness,
      });
      cursorY += lineThickness;
    }
  }

  const cellRects: CellRect[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      cellRects.push({
        x: xOffsets[col],
        y: yOffsets[row],
        width: colWidths[col],
        height: rowHeights[row],
      });
    }
  }

  return {
    lineRects,
    cellRects,
    minCellWidth: Math.min(...colWidths),
    maxCellWidth: Math.max(...colWidths),
    minCellHeight: Math.min(...rowHeights),
    maxCellHeight: Math.max(...rowHeights),
  };
}

function toPercent(value: number, total: number): string {
  if (total <= 0) {
    return '0%';
  }

  return `${(value / total) * 100}%`;
}

function splitSizeLabel(min: number, max: number): string {
  if (min === max) {
    return `${min}`;
  }
  return `${min} - ${max}`;
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

interface NumberStepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

function NumberStepper({ label, value, min, max, onChange }: NumberStepperProps) {
  const decreaseDisabled = value <= min;
  const increaseDisabled = value >= max;

  return (
    <div className="space-y-1.5">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="flex items-center gap-2">
        <UiButton variant="secondary"
          type="button"
          className="h-9 w-9 shrink-0 rounded-lg p-0 text-sm"
          onClick={() => onChange(value - 1)}
          disabled={decreaseDisabled}
        >
          -
        </UiButton>
        <UiInput
          type="number"
          value={value}
          min={min}
          max={max}
          step={1}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-9 text-center"
        />
        <UiButton variant="secondary"
          type="button"
          className="h-9 w-9 shrink-0 rounded-lg p-0 text-sm"
          onClick={() => onChange(value + 1)}
          disabled={increaseDisabled}
        >
          +
        </UiButton>
      </div>
    </div>
  );
}

export function SplitStoryboardToolEditor({ sourceImageUrl, options, onOptionsChange }: VisualToolEditorProps) {
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const displaySourceImageUrl = useMemo(() => resolveImageDisplayUrl(sourceImageUrl), [sourceImageUrl]);

  useEffect(() => {
    setNaturalSize(null);
  }, [displaySourceImageUrl]);

  const rows = clampInteger(toFiniteNumber(options.rows, 3), MIN_GRID_SIZE, MAX_GRID_SIZE);
  const cols = clampInteger(toFiniteNumber(options.cols, 3), MIN_GRID_SIZE, MAX_GRID_SIZE);

  const legacyLineThicknessPx = Math.max(0, toFiniteNumber(options.lineThickness, LEGACY_DEFAULT_LINE_THICKNESS_PX));
  const maxLineThicknessPercent = useMemo(() => {
    if (!naturalSize) {
      return MAX_LINE_THICKNESS_PERCENT;
    }

    const maxLinePx = resolveMaxLineThicknessPx(rows, cols, naturalSize.width, naturalSize.height);
    const basis = Math.max(1, Math.min(naturalSize.width, naturalSize.height));
    return clampDecimal((maxLinePx / basis) * 100, 0, MAX_LINE_THICKNESS_PERCENT);
  }, [cols, naturalSize, rows]);

  const fallbackLineThicknessPercent = useMemo(() => {
    if (!naturalSize) {
      return DEFAULT_LINE_THICKNESS_PERCENT;
    }

    const basis = Math.max(1, Math.min(naturalSize.width, naturalSize.height));
    return clampDecimal(
      (legacyLineThicknessPx / basis) * 100,
      0,
      maxLineThicknessPercent,
      DEFAULT_LINE_THICKNESS_PERCENT
    );
  }, [legacyLineThicknessPx, maxLineThicknessPercent, naturalSize]);

  const rawLineThicknessPercent = Math.max(
    0,
    toFiniteNumber(options.lineThicknessPercent, fallbackLineThicknessPercent)
  );
  const lineThicknessPercent = clampDecimal(
    rawLineThicknessPercent,
    0,
    maxLineThicknessPercent,
    fallbackLineThicknessPercent
  );

  const lineThicknessPx = useMemo(() => {
    if (!naturalSize) {
      return 0;
    }

    return resolveLineThicknessPxFromPercent(
      lineThicknessPercent,
      rows,
      cols,
      naturalSize.width,
      naturalSize.height
    );
  }, [cols, lineThicknessPercent, naturalSize, rows]);

  const layout = useMemo(() => {
    if (!naturalSize) {
      return null;
    }

    return computeSplitLayout(
      naturalSize.width,
      naturalSize.height,
      rows,
      cols,
      lineThicknessPx
    );
  }, [cols, lineThicknessPx, naturalSize, rows]);

  const updateOptions = useCallback(
    (patch: Partial<Record<'rows' | 'cols' | 'lineThicknessPercent', number>>) => {
      const nextRows = clampInteger(
        patch.rows ?? rows,
        MIN_GRID_SIZE,
        MAX_GRID_SIZE
      );
      const nextCols = clampInteger(
        patch.cols ?? cols,
        MIN_GRID_SIZE,
        MAX_GRID_SIZE
      );

      const unresolvedLineThicknessPercent = Math.max(
        0,
        patch.lineThicknessPercent ?? lineThicknessPercent
      );

      const nextMaxLineThicknessPercent = naturalSize
        ? clampDecimal(
            (resolveMaxLineThicknessPx(nextRows, nextCols, naturalSize.width, naturalSize.height) /
              Math.max(1, Math.min(naturalSize.width, naturalSize.height))) *
              100,
            0,
            MAX_LINE_THICKNESS_PERCENT
          )
        : MAX_LINE_THICKNESS_PERCENT;

      const nextLineThicknessPercent = clampDecimal(
        unresolvedLineThicknessPercent,
        0,
        nextMaxLineThicknessPercent
      );

      onOptionsChange({
        ...options,
        rows: nextRows,
        cols: nextCols,
        lineThicknessPercent: nextLineThicknessPercent,
      });
    },
    [cols, lineThicknessPercent, naturalSize, onOptionsChange, options, rows]
  );

  const hasLayoutError = Boolean(naturalSize && !layout);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span>原图 + 切割预览</span>
          {naturalSize && (
            <span>
              {naturalSize.width} x {naturalSize.height}px
            </span>
          )}
        </div>

        <div
          className={`ui-scrollbar flex ${PREVIEW_VIEWPORT_HEIGHT} items-center justify-center overflow-auto rounded-xl border border-(--canvas-node-border) bg-(--canvas-node-media-bg) p-3`}
        >
          <div className="relative inline-flex items-center justify-center">
            <img
              src={displaySourceImageUrl}
              alt="split-preview"
              className="max-h-full w-auto max-w-full rounded-lg border border-(--canvas-node-border) object-contain"
              onLoad={(event) => {
                const target = event.currentTarget;
                setNaturalSize({
                  width: Math.max(1, target.naturalWidth),
                  height: Math.max(1, target.naturalHeight),
                });
              }}
            />

            {naturalSize && layout && (
              <div className="pointer-events-none absolute inset-0 rounded-lg">
                {layout.lineRects.map((rect, index) => (
                  <div
                    key={`line-${index}`}
                    className="absolute bg-red-400/35"
                    style={{
                      left: toPercent(rect.x, naturalSize.width),
                      top: toPercent(rect.y, naturalSize.height),
                      width: toPercent(rect.width, naturalSize.width),
                      height: toPercent(rect.height, naturalSize.height),
                    }}
                  />
                ))}

                {layout.cellRects.map((cell, index) => (
                  <div
                    key={`cell-${index}`}
                    className="absolute border border-white/40"
                    style={{
                      left: toPercent(cell.x, naturalSize.width),
                      top: toPercent(cell.y, naturalSize.height),
                      width: toPercent(cell.width, naturalSize.width),
                      height: toPercent(cell.height, naturalSize.height),
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-text-muted">
          <div className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-xs bg-red-400/70" />
            红色区域为切割时会丢弃的分割线像素
          </div>
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-(--canvas-node-border) bg-(--canvas-node-subtle-bg) p-3.5">
        <div className="text-sm font-medium text-text-dark">切割参数</div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <NumberStepper
            label="行数"
            value={rows}
            min={MIN_GRID_SIZE}
            max={MAX_GRID_SIZE}
            onChange={(value) => updateOptions({ rows: value })}
          />
          <NumberStepper
            label="列数"
            value={cols}
            min={MIN_GRID_SIZE}
            max={MAX_GRID_SIZE}
            onChange={(value) => updateOptions({ cols: value })}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span>分割线粗细</span>
            <span>
              {formatPercent(lineThicknessPercent)}
              {naturalSize ? ` (${lineThicknessPx}px)` : ''}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(0, maxLineThicknessPercent)}
            step={0.1}
            value={lineThicknessPercent}
            onChange={(event) => updateOptions({ lineThicknessPercent: Number(event.target.value) })}
            className="ui-range w-full"
          />
          <UiInput
            type="number"
            value={lineThicknessPercent}
            min={0}
            max={Math.max(0, maxLineThicknessPercent)}
            step={0.1}
            onChange={(event) => updateOptions({ lineThicknessPercent: Number(event.target.value) })}
            className="h-9"
          />
        </div>

        <div className="rounded-lg border border-(--canvas-node-field-border) bg-(--canvas-node-field-bg) px-3 py-2 text-xs text-text-muted">
          <div className="flex items-center justify-between">
            <span>输出小格数量</span>
            <span className="font-medium text-text-dark">{rows * cols}</span>
          </div>
          {layout && (
            <>
              <div className="mt-1 flex items-center justify-between">
                <span>单格宽度(px)</span>
                <span>{splitSizeLabel(layout.minCellWidth, layout.maxCellWidth)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span>单格高度(px)</span>
                <span>{splitSizeLabel(layout.minCellHeight, layout.maxCellHeight)}</span>
              </div>
            </>
          )}
        </div>

        {hasLayoutError && (
          <div className="rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">
            当前分割线过粗，导致可切割区域不足。请减少线宽或降低行列数。
          </div>
        )}
      </div>
    </div>
  );
}
