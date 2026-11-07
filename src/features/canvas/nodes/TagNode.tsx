import { memo, useMemo, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
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
import { NodeFrame, resolveNodeBox } from '@/features/canvas/ui/NodeFrame';
import { useCanvasStore } from '@/stores/canvasStore';
import { UiIconButton } from '@/components/ui';

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

export const TagNode = memo(({ id, data, selected, width, height }: TagNodeProps) => {
  const { t } = useTranslation();
  const [isConnectionsOpen, setIsConnectionsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
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
      <NodeFrame
        type={CANVAS_NODE_TYPES.tag}
        selected={selected}
        icon={<Tag style={{ color: COLOR_VARIABLES[data.color] }} />}
        title={resolvedTitle}
        onRename={(displayName) => updateNodeData(id, { displayName })}
        status={error ? { kind: 'error', label: error } : null}
        {...resolveNodeBox(CANVAS_NODE_TYPES.tag, width, height, { minWidth: 240, minHeight: 132 })}
        resize={false}
        bodyStyle={{ borderTop: `2px solid ${COLOR_VARIABLES[data.color]}` }}
        actions={(
          <>
            <button type="button" className="nodrag" onClick={() => setIsConnectionsOpen(true)} aria-label={t('node.tag.editConnections')} title={t('node.tag.editConnections')}>
              <Link2 />
            </button>
            <button type="button" className="nodrag" onClick={() => void run({ type: 'node.duplicate', version: CANVAS_COMMAND_VERSION, input: { copies: [{ sourceNodeId: id }] } })} aria-label={t('node.tag.duplicate')} title={t('node.tag.duplicate')}>
              <Copy />
            </button>
            <button type="button" className="nodrag text-danger" onClick={() => void run({ type: 'node.delete', version: CANVAS_COMMAND_VERSION, input: { nodeIds: [id] } })} aria-label={t('common.delete')} title={t('common.delete')}>
              <Trash2 />
            </button>
          </>
        )}
      >

        <div className="flex h-full min-h-0 flex-col justify-between">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text-dark" title={resolvedTitle}>{resolvedTitle}</p>
              <p className={`mt-1 text-xs ${effectiveEnabled ? 'text-text-muted' : 'text-danger'}`}>
                {!data.enabled
                  ? t('node.tag.disabled')
                  : disabledByGroup
                    ? t('node.tag.disabledByGroup')
                    : hasSource
                      ? t('node.tag.connected')
                      : t('node.tag.missingSource')}
              </p>
            </div>
            <UiIconButton
              variant="secondary"
              active={data.enabled}
              className="nodrag nowheel"
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
            </UiIconButton>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-(--canvas-node-divider) pt-2">
            <div className="nodrag nowheel flex items-center gap-1" aria-label={t('node.tag.colorLabel')}>
              {TAG_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`h-5 w-5 rounded-full border-2 transition-transform hover:scale-110 active:scale-95 ${data.color === color ? 'border-text-dark' : 'border-transparent'}`}
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
          </div>
          {error ? <p role="alert" className="mt-1 truncate text-[10px] text-danger" title={error}>{error}</p> : null}
        </div>

      </NodeFrame>
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
