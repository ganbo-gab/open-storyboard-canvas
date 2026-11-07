import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton } from '@/components/ui';

interface CustomGridSelectorProps {
  rows: number;
  cols: number;
  onChange: (rows: number, cols: number) => void;
}

const GRID_SIZE = 5;

export const CustomGridSelector = memo(({ rows, cols, onChange }: CustomGridSelectorProps) => {
  const { t } = useTranslation();
  const [hoverCell, setHoverCell] = useState<{ row: number; col: number } | null>(null);

  const handleCellEnter = useCallback((row: number, col: number) => {
    setHoverCell({ row, col });
  }, []);

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      onChange(row, col);
    },
    [onChange]
  );

  const displayRows = hoverCell ? hoverCell.row : rows;
  const displayCols = hoverCell ? hoverCell.col : cols;

  return (
    <div className="space-y-3">
      {/* Header with column numbers */}
      <div className="flex items-center gap-1 pl-6">
        {Array.from({ length: GRID_SIZE }, (_, index) => (
          <div
            key={`col-${index}`}
            className="flex h-6 w-6 items-center justify-center text-xs text-text-muted"
          >
            {index + 1}
          </div>
        ))}
      </div>

      {/* Grid with row numbers */}
      <div className="flex flex-col gap-1">
        {Array.from({ length: GRID_SIZE }, (_, rowIndex) => (
          <div key={`row-${rowIndex}`} className="flex items-center gap-1">
            {/* Row number */}
            <div className="flex h-6 w-6 items-center justify-center text-xs text-text-muted">
              {rowIndex + 1}
            </div>

            {/* Cells */}
            <div className="flex gap-1">
              {Array.from({ length: GRID_SIZE }, (_, colIndex) => {
                const isSelected = rowIndex < displayRows && colIndex < displayCols;
                const isHovered =
                  hoverCell && rowIndex < hoverCell.row && colIndex < hoverCell.col;

                return (
                  <UiButton variant="ghost"
                    key={`cell-${rowIndex}-${colIndex}`}
                    className={`h-6 w-6 min-w-0 cursor-pointer rounded-sm p-0 transition-[background-color,box-shadow] duration-150 ${isSelected ? 'bg-accent' : 'bg-(--press) hover:bg-(--hover)'} ${isHovered && !isSelected ? 'bg-accent/40' : ''}`}
                    onMouseEnter={() => handleCellEnter(rowIndex + 1, colIndex + 1)}
                    onClick={() => handleCellClick(rowIndex + 1, colIndex + 1)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Current selection display */}
      <div className="text-center text-xs text-text-muted">
        {t('gridSplit.currentSelection', { rows: displayRows, cols: displayCols })}
      </div>
    </div>
  );
});

CustomGridSelector.displayName = 'CustomGridSelector';
