import { memo, useMemo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Copy, Link2, Power, Tag, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { CANVAS_COMMAND_VERSION } from '@/features/canvas/domain/canvasCommands';
import {
  CANVAS_NODE_TYPES,
  TAG_COLORS,
  isTagGroupNode,
  type TagColor,
  type TagNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { useCanvasStore } from '@/stores/canvasStore';

import { TagRelationsDialog } from './TagRelationsDialog';

type TagNodeProps = NodeProps & {
  id: string;
  data: TagNodeData;
  selected?: boolean;
};

const COLOR_VARIABLES: Record<TagColor, string> = {
  neutral: 'var(--tag-color-neutral)',
  amber: 'var(--tag-color-amber)',
  cyan: 'var(--tag-color-cyan)',
  violet: 'var(--tag-color-violet)',
  rose: 'var(--tag-color-rose)',
};

export const TagNode = memo(({ id, data, selected }: TagNodeProps) => {
  const { t } = useTranslation();
  const [isConnectionsOpen, setIsConnectionsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasSource = useCanvasStore((state) => state.edges.some((edge) => edge.target === id));
  const disabledByGroup = useCanvasStore((state) => state.nodes.some((node) => (
    isTagGroupNode(node)
    && !node.data.enabled
    && (node.data.memberTagIds ?? []).includes(id)
  )));
  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.tag, data),
    [data],
  );
  const effectiveEnabled = data.enabled && !disabledByGroup;

  const run = async (command: Parameters<typeof canvasCommandRegistry.execute>[0]) => {
    const result = await canvasCommandRegistry.execute(command, 'ui');
    setError(result.ok ? null : result.error.message);
  };

  return (
    <>
      <div
        className={`relative h-full min-h-[132px] w-full overflow-visible rounded-lg border bg-[var(--canvas-node-bg)] shadow-[var(--canvas-node-shadow)] ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.3)]'
          : 'border-[var(--canvas-node-border)] hover:border-[var(--canvas-node-border-hover)]'}`}
        style={{ borderTopColor: COLOR_VARIABLES[data.color] }}
      >
        <NodeHeader
          className={NODE_HEADER_FLOATING_POSITION_CLASS}
          icon={<Tag className="h-4 w-4" style={{ color: COLOR_VARIABLES[data.color] }} />}
          titleText={resolvedTitle}
          editable
          onTitleChange={(displayName) => void run({
            type: 'node.rename',
            version: CANVAS_COMMAND_VERSION,
            input: { nodeId: id, displayName },
          })}
        />

        <div className="flex h-full min-h-[130px] flex-col justify-between p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text-dark" title={resolvedTitle}>{resolvedTitle}</p>
              <p className={`mt-1 text-xs ${effectiveEnabled ? 'text-text-muted' : 'text-red-500'}`}>
                {!data.enabled
                  ? t('node.tag.disabled')
                  : disabledByGroup
                    ? t('node.tag.disabledByGroup')
                    : hasSource
                      ? t('node.tag.connected')
                      : t('node.tag.missingSource')}
              </p>
            </div>
            <button
              type="button"
              className={`nodrag nowheel inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors ${data.enabled
                ? 'border-accent/35 bg-accent/10 text-accent'
                : 'border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-text-muted'}`}
              aria-pressed={data.enabled}
              aria-label={data.enabled ? t('node.tag.disable') : t('node.tag.enable')}
              title={data.enabled ? t('node.tag.disable') : t('node.tag.enable')}
              onClick={() => void run({
                type: 'node.setEnabled',
                version: CANVAS_COMMAND_VERSION,
                input: { nodeIds: [id], enabled: !data.enabled },
              })}
            >
              <Power className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--canvas-node-divider)] pt-2">
            <div className="nodrag nowheel flex items-center gap-1" aria-label={t('node.tag.colorLabel')}>
              {TAG_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`h-5 w-5 rounded-full border-2 transition-transform hover:scale-110 ${data.color === color ? 'border-text-dark' : 'border-transparent'}`}
                  style={{ backgroundColor: COLOR_VARIABLES[color] }}
                  aria-label={t(`node.tag.colors.${color}`)}
                  title={t(`node.tag.colors.${color}`)}
                  onClick={() => void run({
                    type: 'tag.setColor',
                    version: CANVAS_COMMAND_VERSION,
                    input: { tagId: id, color },
                  })}
                />
              ))}
            </div>
            <div className="nodrag nowheel flex items-center gap-1">
              <button type="button" className="canvas-node-icon-button" onClick={() => setIsConnectionsOpen(true)} aria-label={t('node.tag.editConnections')} title={t('node.tag.editConnections')}>
                <Link2 className="h-3.5 w-3.5" />
              </button>
              <button type="button" className="canvas-node-icon-button" onClick={() => void run({ type: 'node.duplicate', version: CANVAS_COMMAND_VERSION, input: { copies: [{ sourceNodeId: id }] } })} aria-label={t('node.tag.duplicate')} title={t('node.tag.duplicate')}>
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button type="button" className="canvas-node-icon-button text-red-500" onClick={() => void run({ type: 'node.delete', version: CANVAS_COMMAND_VERSION, input: { nodeIds: [id] } })} aria-label={t('common.delete')} title={t('common.delete')}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          {error ? <p role="alert" className="mt-1 truncate text-[10px] text-red-500" title={error}>{error}</p> : null}
        </div>

        <Handle type="target" id="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-surface-dark !bg-accent" />
        <Handle type="source" id="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-surface-dark !bg-accent" />
      </div>
      <TagRelationsDialog
        isOpen={isConnectionsOpen}
        nodeId={id}
        variant="connections"
        onClose={() => setIsConnectionsOpen(false)}
      />
    </>
  );
});

TagNode.displayName = 'TagNode';
