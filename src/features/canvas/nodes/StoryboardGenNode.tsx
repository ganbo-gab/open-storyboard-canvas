import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Grid3x3, LayoutGrid, Minus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PopoverSurface, anchorAbove, type MenuAnchor } from '@/components/ui';
import {
  AUTO_REQUEST_ASPECT_RATIO,
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  fitStoryboardFrames,
  type StoryboardGenNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { submitNodeGeneration } from '@/features/canvas/application/generation';
import { parseAspectRatio } from '@/features/canvas/application/imageData';
import { useImageModelCatalog } from '@/features/canvas/application/modelCatalog';
import { ImageModelControls } from '@/features/canvas/composer/ImageParams';
import { NodeComposer } from '@/features/canvas/composer/NodeComposer';
import { useTextDraft } from '@/features/canvas/composer/usePromptDraft';
import type { ComposerReference } from '@/features/canvas/composer/useNodeReferences';
import { NodeFrame, resolveNodeBox, type NodeFrameStatus } from '@/features/canvas/ui/NodeFrame';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type StoryboardGenNodeProps = NodeProps & {
  id: string;
  data: StoryboardGenNodeData;
  selected?: boolean;
};

const RESIZE = { minWidth: 280, minHeight: 220, maxWidth: 1800, maxHeight: 1400 } as const;
const GRID_LIMIT = 9;

function storyboardData(nodeId: string): StoryboardGenNodeData | null {
  const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  return node?.type === CANVAS_NODE_TYPES.storyboardGen ? node.data as StoryboardGenNodeData : null;
}

/** Writes one shot's text against the latest frames, so concurrent grid edits are never overwritten. */
function writeFrameDescription(nodeId: string, frameId: string, description: string) {
  const data = storyboardData(nodeId);
  if (!data) return;
  const frames = data.frames.map((frame) => frame.id === frameId ? { ...frame, description } : frame);
  useCanvasStore.getState().updateNodeData(nodeId, { frames });
}

/** Rows × columns, and (when enabled in settings) whether the ratio applies to each shot or the whole sheet. */
function GridChip({ nodeId, data, advancedRatio, gridPreview }: {
  nodeId: string;
  data: StoryboardGenNodeData;
  advancedRatio: boolean;
  gridPreview: boolean;
}) {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const resize = (patch: { gridRows?: number; gridCols?: number }) => {
    const rows = patch.gridRows ?? data.gridRows;
    const cols = patch.gridCols ?? data.gridCols;
    updateNodeData(nodeId, { ...patch, frames: fitStoryboardFrames(storyboardData(nodeId)?.frames ?? data.frames, rows * cols) });
  };
  const stepper = (label: string, value: number, key: 'gridRows' | 'gridCols') => (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13px]">{label}</span>
      <span className="flex items-center gap-1">
        <button
          type="button"
          className="ui-tile w-8 flex-none"
          aria-label={`${label} −`}
          disabled={value <= 1}
          onClick={() => resize({ [key]: value - 1 })}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="w-6 text-center text-[13px] tabular-nums">{value}</span>
        <button
          type="button"
          className="ui-tile w-8 flex-none"
          aria-label={`${label} +`}
          disabled={value >= GRID_LIMIT}
          onClick={() => resize({ [key]: value + 1 })}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
  const mode = data.ratioControlMode === 'overall' ? 'overall' : 'cell';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-chip"
        aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)}
        onClick={() => setAnchor(anchor ? null : anchorAbove(triggerRef.current!))}
      >
        <Grid3x3 />
        <span className="composer-chip__text">{data.gridRows}×{data.gridCols}</span>
      </button>
      {anchor ? (
        <PopoverSurface anchor={anchor} width={240} label={t('rework.canvas.composer.grid')} onClose={() => setAnchor(null)}>
          <section className="ui-popover__section flex flex-col gap-2">
            {stepper(t('node.storyboardGen.rowsShort'), data.gridRows, 'gridRows')}
            {stepper(t('node.storyboardGen.colsShort'), data.gridCols, 'gridCols')}
          </section>
          {advancedRatio ? (
            <section className="ui-popover__section">
              <div className="ui-popover__title">{t('rework.canvas.composer.ratioAppliesTo')}</div>
              <div className="ui-tiles">
                {(['cell', 'overall'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="ui-tile"
                    aria-pressed={mode === option}
                    onClick={() => updateNodeData(nodeId, { ratioControlMode: option })}
                  >
                    {t(option === 'cell' ? 'node.storyboardGen.ratioModeCell' : 'node.storyboardGen.ratioModeOverall')}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          {gridPreview ? (
            <section className="ui-popover__section">
              <button
                type="button"
                className="ui-tile w-full"
                onClick={() => {
                  setAnchor(null);
                  void submitNodeGeneration(nodeId, { tool: { id: 'gridPreview' } });
                }}
              >
                {t('rework.canvas.composer.gridPreview')}
              </button>
            </section>
          ) : null}
        </PopoverSurface>
      ) : null}
    </>
  );
}

const acceptsImage = (reference: ComposerReference) => reference.kind === 'image';

/**
 * Storyboard generator: the node *is* the sheet. Each cell is one shot; click a cell and the
 * composer below edits that shot (with `@图N`), so writing a 3×3 board never means typing into
 * ten-pixel text boxes.
 */
export const StoryboardGenNode = memo(({ id, data, selected = false, width, height }: StoryboardGenNodeProps) => {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const advancedRatio = useSettingsStore((state) => state.showStoryboardGenAdvancedRatioControls);
  const gridPreview = useSettingsStore((state) => state.enableStoryboardGenGridPreviewShortcut);
  const catalog = useImageModelCatalog();
  const rows = Math.max(1, data.gridRows);
  const cols = Math.max(1, data.gridCols);
  const frames = data.frames ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIndex = Math.max(0, frames.findIndex((frame) => frame.id === activeId));
  const active = frames[activeIndex] ?? null;

  // New and resized boards get one frame per cell (old nodes may hold fewer).
  useEffect(() => {
    if (frames.length !== rows * cols) updateNodeData(id, { frames: fitStoryboardFrames(frames, rows * cols) });
  }, [cols, frames, id, rows, updateNodeData]);

  const writeActive = useCallback((next: string) => {
    if (active) writeFrameDescription(id, active.id, next);
  }, [active, id]);
  const draft = useTextDraft(`${id}:${active?.id ?? ''}`, active?.description ?? '', writeActive);

  // Shown config; generation resolves the same fallback when none is stored.
  const firstUsable = catalog.find((entry) => entry.usable);
  const modelConfig = data.modelConfig
    ?? (firstUsable
      ? {
        entryId: firstUsable.id,
        ratio: firstUsable.supportedRatios.includes(AUTO_REQUEST_ASPECT_RATIO) ? AUTO_REQUEST_ASPECT_RATIO : firstUsable.supportedRatios[0] ?? DEFAULT_ASPECT_RATIO,
        extraParams: {},
      }
      : null);

  // Preview geometry: the chosen ratio governs each shot (or the whole sheet in "overall" mode).
  const ratio = modelConfig?.ratio ?? data.requestAspectRatio ?? AUTO_REQUEST_ASPECT_RATIO;
  const control = Math.max(0.1, parseAspectRatio(ratio === AUTO_REQUEST_ASPECT_RATIO ? data.aspectRatio || DEFAULT_ASPECT_RATIO : ratio));
  const overall = advancedRatio && data.ratioControlMode === 'overall';
  const sheetRatio = overall ? control : control * cols / rows;

  const status: NodeFrameStatus | null = typeof data.lastError === 'string' && data.lastError
    ? { kind: 'error', label: data.lastError }
    : null;
  const shotLabel = (index: number) => t('rework.canvas.composer.shot', { index: String(index + 1).padStart(2, '0') });

  return (
    <>
      <NodeFrame
        type={CANVAS_NODE_TYPES.storyboardGen}
        selected={selected}
        icon={<LayoutGrid />}
        title={resolveNodeDisplayName(CANVAS_NODE_TYPES.storyboardGen, data)}
        onRename={(displayName) => updateNodeData(id, { displayName })}
        meta={`${rows}×${cols}`}
        status={status}
        variant="media"
        {...resolveNodeBox(CANVAS_NODE_TYPES.storyboardGen, width, height, RESIZE)}
        resize={RESIZE}
      >
        <div className="gen-face">
          <div className="gen-face__grid-area">
            <div
              className="storyboard-grid"
              style={{ '--sheet-ratio': sheetRatio, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` } as CSSProperties}
            >
              {frames.slice(0, rows * cols).map((frame, index) => {
                const text = frame.id === active?.id ? draft.value : frame.description;
                return (
                  <button
                    key={frame.id}
                    type="button"
                    className="storyboard-cell"
                    data-active={selected && index === activeIndex ? '' : undefined}
                    aria-label={shotLabel(index)}
                    onClick={() => {
                      draft.flush();
                      setActiveId(frame.id);
                    }}
                  >
                    <span className="storyboard-cell__index">{String(index + 1).padStart(2, '0')}</span>
                    {text.trim()
                      ? <span className="storyboard-cell__text">{text}</span>
                      : <span className="storyboard-cell__empty">{t('rework.canvas.composer.emptyShot')}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </NodeFrame>
      <NodeComposer
        nodeId={id}
        open={selected && active !== null}
        draft={draft}
        referencePromptTarget={active ? { kind: 'storyboardFrame', frameId: active.id } : undefined}
        placeholder={t('rework.canvas.composer.shotPlaceholder', { shot: shotLabel(activeIndex) })}
        acceptsReference={acceptsImage}
        params={(
          <>
            <ImageModelControls nodeId={id} catalog={catalog} value={modelConfig} onChange={(next) => updateNodeData(id, { modelConfig: next, ...(next.entryId !== modelConfig?.entryId ? { channelModeId: undefined, referenceSlots: undefined } : {}) })} />
            <GridChip nodeId={id} data={data} advancedRatio={advancedRatio} gridPreview={gridPreview} />
          </>
        )}
      />
    </>
  );
});

StoryboardGenNode.displayName = 'StoryboardGenNode';
