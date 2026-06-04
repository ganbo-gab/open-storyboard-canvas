import { memo } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar } from '@xyflow/react';
import { RotateCcw, Trash2, Ungroup } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiChipButton, UiPanel } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  buildRetryGenerationFetchPatch,
  canRetryGenerationFetch,
} from '@/features/canvas/application/generationRetry';
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from './nodeToolbarConfig';

interface NodeDeleteToolbarProps {
  nodeId: string;
  node?: CanvasNode | null;
}

export const NodeDeleteToolbar = memo(({ nodeId, node }: NodeDeleteToolbarProps) => {
  const { t } = useTranslation();
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const ungroupNode = useCanvasStore((state) => state.ungroupNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const canRetryGeneration = canRetryGenerationFetch(node);
  const canUngroup = node?.type === CANVAS_NODE_TYPES.group;

  return (
    <ReactFlowNodeToolbar
      nodeId={nodeId}
      isVisible
      position={NODE_TOOLBAR_POSITION}
      align={NODE_TOOLBAR_ALIGN}
      offset={NODE_TOOLBAR_OFFSET}
      className={NODE_TOOLBAR_CLASS}
    >
      <UiPanel className="flex items-center gap-1 rounded-full p-1">
        {canRetryGeneration && node && (
          <UiChipButton
            className="h-8 rounded-full border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] px-2.5 text-xs text-text-dark shadow-sm hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]"
            onClick={(event) => {
              event.stopPropagation();
              updateNodeData(nodeId, buildRetryGenerationFetchPatch(node));
            }}
            title={t('nodeToolbar.retryFetch')}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('nodeToolbar.retryFetch')}
          </UiChipButton>
        )}
        {canUngroup && (
          <UiChipButton
            className="h-8 rounded-full border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] px-2.5 text-xs text-text-dark shadow-sm hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]"
            onClick={(event) => {
              event.stopPropagation();
              ungroupNode(nodeId);
            }}
            title={t('nodeToolbar.ungroup')}
          >
            <Ungroup className="h-3.5 w-3.5" />
            {t('nodeToolbar.ungroup')}
          </UiChipButton>
        )}
        <UiChipButton
          className="h-8 rounded-full border-red-500/45 bg-red-500/15 px-2.5 text-xs text-red-300 hover:bg-red-500/25"
          onClick={(event) => {
            event.stopPropagation();
            deleteNode(nodeId);
          }}
          title={t('common.delete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t('common.delete')}
        </UiChipButton>
      </UiPanel>
    </ReactFlowNodeToolbar>
  );
});

NodeDeleteToolbar.displayName = 'NodeDeleteToolbar';
