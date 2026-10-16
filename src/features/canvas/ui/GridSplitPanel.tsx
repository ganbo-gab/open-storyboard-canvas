import { memo, useCallback, useState } from 'react';
import { Grid3x3, Scissors, ChevronDown, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { NODE_TOOL_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { CustomGridSelector } from './CustomGridSelector';

interface GridSplitPanelProps {
  node: CanvasNode;
  isOpen: boolean;
  onClose: () => void;
  buttonRect: DOMRect;
}

interface GridPreset {
  labelKey: string;
  rows: number;
  cols: number;
}

const GRID_PRESETS: GridPreset[] = [
  { labelKey: 'gridSplit.presets.2x2', rows: 2, cols: 2 },
  { labelKey: 'gridSplit.presets.3x3', rows: 3, cols: 3 },
  { labelKey: 'gridSplit.presets.4x4', rows: 4, cols: 4 },
  { labelKey: 'gridSplit.presets.5x5', rows: 5, cols: 5 },
];

export const GridSplitPanel = memo(({ node, isOpen, onClose, buttonRect }: GridSplitPanelProps) => {
  const { t } = useTranslation();
  const openToolDialog = useCanvasStore((state) => state.openToolDialog);
  const [showCustomSelector, setShowCustomSelector] = useState(false);
  const [customRows, setCustomRows] = useState(2);
  const [customCols, setCustomCols] = useState(2);

  const handlePresetSelect = useCallback(
    (rows: number, cols: number) => {
      // Pass the user-picked grid through to the split dialog so it opens
      // already pointing at e.g. 2x2 / 4x4 instead of the plugin default
      // 3x3. Without the override the user would always have to manually
      // set the grid even right after picking a preset.
      openToolDialog({
        nodeId: node.id,
        toolType: NODE_TOOL_TYPES.splitStoryboard,
        initialOptionsOverride: { rows, cols },
      });
      onClose();
    },
    [node.id, openToolDialog, onClose]
  );

  const handleCustomSelect = useCallback(
    (rows: number, cols: number) => {
      setCustomRows(rows);
      setCustomCols(cols);
      openToolDialog({
        nodeId: node.id,
        toolType: NODE_TOOL_TYPES.splitStoryboard,
        initialOptionsOverride: { rows, cols },
      });
      onClose();
    },
    [node.id, openToolDialog, onClose]
  );

  const handleCustomToggle = useCallback(() => {
    setShowCustomSelector((prev) => !prev);
  }, []);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed z-100 min-w-[180px] rounded-xl border border-[rgba(255,255,255,0.18)] bg-surface-dark/95 p-2 shadow-2xl backdrop-blur-xs"
      style={{
        left: `${buttonRect.left}px`,
        top: `${buttonRect.bottom + 4}px`,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <div className="flex items-center gap-2">
          <Grid3x3 className="h-4 w-4 text-accent" />
          <span className="text-sm font-medium text-text-dark">{t('gridSplit.title')}</span>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-text-muted hover:bg-bg-dark hover:text-text-dark transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Divider */}
      <div className="my-1.5 h-px bg-[rgba(255,255,255,0.1)]" />

      {/* Preset grid options */}
      <div className="space-y-0.5">
        {GRID_PRESETS.map((preset) => (
          <button
            key={preset.labelKey}
            type="button"
            className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs text-text-dark transition-colors hover:bg-bg-dark"
            onClick={() => handlePresetSelect(preset.rows, preset.cols)}
          >
            <Grid3x3 className="h-3.5 w-3.5 text-text-muted" />
            {t(preset.labelKey)}
          </button>
        ))}
      </div>

      {/* Divider */}
      <div className="my-2 h-px bg-[rgba(255,255,255,0.1)]" />

      {/* Custom grid option */}
      <div className="space-y-2">
        <button
          type="button"
          className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs text-text-dark transition-colors hover:bg-bg-dark"
          onClick={handleCustomToggle}
        >
          <Scissors className="h-3.5 w-3.5 text-text-muted" />
          <span className="flex-1">{t('gridSplit.custom')}</span>
          <ChevronDown
            className={`h-3.5 w-3.5 text-text-muted transition-transform ${showCustomSelector ? 'rotate-180' : ''}`}
          />
        </button>

        {/* Custom grid selector */}
        {showCustomSelector && (
          <div className="rounded-lg border border-[rgba(255,255,255,0.12)] bg-bg-dark/80 p-3">
            <CustomGridSelector
              rows={customRows}
              cols={customCols}
              onChange={handleCustomSelect}
            />
          </div>
        )}
      </div>
    </div>
  );
});

GridSplitPanel.displayName = 'GridSplitPanel';
