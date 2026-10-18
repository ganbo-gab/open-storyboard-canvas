import { useState } from 'react';
import { useStore, type ReactFlowState } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import {
  AlignHorizontalSpaceAround,
  AlignVerticalSpaceAround,
  ChevronDown,
  CopyPlus,
  Group,
  LayoutGrid,
  Play,
  Tags,
  Trash2,
  Ungroup,
} from 'lucide-react';

import { MenuItem, MenuSurface, Tooltip } from '@/components/ui';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { CANVAS_GENERATION_NODE_TYPES } from '@/features/canvas/domain/canvasCapabilities';
import { CANVAS_COMMAND_VERSION } from '@/features/canvas/domain/canvasCommands';
import {
  CANVAS_NODE_TYPES,
  isEligibleTagGroupMember,
  type CanvasNode,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasActions } from '@/features/canvas/engine/canvasActions';
import { shortcutLabel } from '@/features/canvas/engine/shortcuts';
import { useCanvasStore } from '@/stores/canvasStore';

const GENERATION_TYPES = new Set<CanvasNodeType>(CANVAS_GENERATION_NODE_TYPES);
const TAG_GROUP_PADDING = 28;

interface SelectionFrame {
  count: number;
  /** Screen-space top-centre of the selection bounds, relative to the canvas root. */
  x: number;
  y: number;
  bounds: { x: number; y: number; width: number; height: number };
  singleGroup: boolean;
}

/** Recomputed on every flow change (pan/zoom/drag) but cheap, and equality-gated. */
function selectFrame(state: ReactFlowState): SelectionFrame | null {
  if (state.userSelectionActive) return null;
  let count = 0;
  let groupCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of state.nodeLookup.values()) {
    if (!node.selected) continue;
    count += 1;
    if (node.type === 'groupNode') groupCount += 1;
    const { x, y } = node.internals.positionAbsolute;
    const width = node.measured.width ?? 0;
    const height = node.measured.height ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }
  const singleGroup = count === 1 && groupCount === 1;
  if (count < 2 && !singleGroup) return null;
  const [tx, ty, zoom] = state.transform;
  return {
    count,
    x: Math.round(((minX + maxX) / 2) * zoom + tx),
    y: Math.round(minY * zoom + ty),
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    singleGroup,
  };
}

function sameFrame(a: SelectionFrame | null, b: SelectionFrame | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.count === b.count && a.x === b.x && a.y === b.y && a.singleGroup === b.singleGroup
    && a.bounds.width === b.bounds.width && a.bounds.height === b.bounds.height;
}

export function SelectionToolbar({ scheduleCanvasPersist }: { scheduleCanvasPersist: (delayMs?: number) => void }) {
  const { t } = useTranslation();
  const actions = useCanvasActions();
  const frame = useStore(selectFrame, sameFrame);
  const [arrangeAnchor, setArrangeAnchor] = useState<{ x: number; y: number } | null>(null);
  if (!frame) return null;

  // Read at render time: this component re-renders whenever the selection frame changes.
  const nodes: CanvasNode[] = useCanvasStore.getState().nodes.filter((node) => node.selected);
  const canGenerate = nodes.some((node) => GENERATION_TYPES.has(node.type));
  const tagMembers = nodes.filter(isEligibleTagGroupMember);

  const createTagGroup = () => {
    if (tagMembers.length < 2) return;
    const nodeId = `tag-group-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
    void canvasCommandRegistry.execute({
      type: 'node.create',
      version: CANVAS_COMMAND_VERSION,
      input: {
        nodeType: CANVAS_NODE_TYPES.tagGroup,
        nodeId,
        position: { x: frame.bounds.x - TAG_GROUP_PADDING, y: frame.bounds.y - TAG_GROUP_PADDING },
        dimensions: {
          width: Math.max(420, Math.min(1400, frame.bounds.width + TAG_GROUP_PADDING * 2)),
          height: Math.max(260, Math.min(1000, frame.bounds.height + TAG_GROUP_PADDING * 2)),
        },
        configuration: { displayName: t('node.menu.tagGroup'), memberNodeIds: tagMembers.map((node) => node.id) },
      },
    }, 'ui').then((result) => {
      if (!result.ok) return;
      useCanvasStore.getState().setSelectedNode(nodeId);
      scheduleCanvasPersist(0);
    });
  };

  return (
    <div
      className="canvas-chrome canvas-selection-bar"
      data-canvas-overlay=""
      style={{ left: frame.x, top: Math.max(56, frame.y - 14) }}
    >
      <span className="canvas-selection-bar__count">
        {t('rework.canvas.selected', { count: frame.singleGroup ? 1 : frame.count })}
      </span>
      {frame.singleGroup ? (
        <Tooltip label={t('rework.canvas.menu.ungroup')} shortcut={shortcutLabel('organize.ungroup')} side="top">
          <button type="button" className="canvas-action" onClick={actions.ungroupSelection}>
            <Ungroup />{t('rework.canvas.menu.ungroup')}
          </button>
        </Tooltip>
      ) : (
        <>
          <button
            type="button"
            className="canvas-action"
            aria-expanded={Boolean(arrangeAnchor)}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setArrangeAnchor(arrangeAnchor ? null : { x: rect.left, y: rect.bottom + 6 });
            }}
          >
            <LayoutGrid />{t('rework.canvas.selection.arrange')}<ChevronDown />
          </button>
          <Tooltip label={t('rework.canvas.menu.group')} shortcut={shortcutLabel('organize.group')} side="top">
            <button type="button" className="canvas-action" onClick={actions.groupSelection}>
              <Group />{t('rework.canvas.menu.group')}
            </button>
          </Tooltip>
          <Tooltip
            label={tagMembers.length < 2 ? t('canvas.batchToolbar.tagGroupUnavailable') : t('canvas.batchToolbar.tagGroup')}
            side="top"
          >
            <button type="button" className="canvas-action" disabled={tagMembers.length < 2} onClick={createTagGroup}>
              <Tags />{t('canvas.batchToolbar.tagGroup')}
            </button>
          </Tooltip>
        </>
      )}
      <Tooltip label={t('rework.canvas.menu.duplicate')} shortcut={shortcutLabel('edit.duplicate')} side="top">
        <button type="button" className="canvas-action canvas-action--icon" aria-label={t('rework.canvas.menu.duplicate')} onClick={actions.duplicateSelection}>
          <CopyPlus />
        </button>
      </Tooltip>
      {canGenerate ? (
        <Tooltip label={t('rework.canvas.selection.generateHint')} side="top">
          <button type="button" className="canvas-action" onClick={actions.generateSelection}>
            <Play />{t('rework.canvas.selection.generate')}
          </button>
        </Tooltip>
      ) : null}
      <Tooltip label={t('common.delete')} shortcut={shortcutLabel('edit.delete')} side="top">
        <button type="button" className="canvas-action canvas-action--icon" data-tone="danger" aria-label={t('common.delete')} onClick={actions.deleteSelection}>
          <Trash2 />
        </button>
      </Tooltip>
      {arrangeAnchor ? (
        <MenuSurface anchor={arrangeAnchor} onClose={() => setArrangeAnchor(null)} width={200}>
          <MenuItem icon={<LayoutGrid />} label={t('rework.canvas.menu.arrangeGrid')} onClick={() => { setArrangeAnchor(null); actions.layoutSelection('grid'); }} />
          <MenuItem icon={<AlignHorizontalSpaceAround />} label={t('rework.canvas.selection.arrangeRow')} onClick={() => { setArrangeAnchor(null); actions.layoutSelection('horizontal'); }} />
          <MenuItem icon={<AlignVerticalSpaceAround />} label={t('rework.canvas.selection.arrangeColumn')} onClick={() => { setArrangeAnchor(null); actions.layoutSelection('vertical'); }} />
        </MenuSurface>
      ) : null}
    </div>
  );
}
