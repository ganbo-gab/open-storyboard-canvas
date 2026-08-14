import { memo, useMemo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Image, Type, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  getTagGroupMemberKind,
  type TagGroupNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { useCanvasStore } from '@/stores/canvasStore';

type TagGroupNodeProps = NodeProps & {
  id: string;
  data: TagGroupNodeData;
  selected?: boolean;
};

export const TagGroupNode = memo(({ data, selected }: TagGroupNodeProps) => {
  const { t } = useTranslation();
  const nodes = useCanvasStore((state) => state.nodes);
  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.tagGroup, data),
    [data],
  );
  const members = useMemo(() => {
    const memberIds = new Set(data.memberNodeIds);
    return nodes.filter((node) => memberIds.has(node.id));
  }, [data.memberNodeIds, nodes]);
  const missingMemberCount = data.unresolvedMemberIds?.length ?? 0;
  const counts = useMemo(() => members.reduce((result, member) => {
    const kind = getTagGroupMemberKind(member.type);
    if (kind) result[kind] += 1;
    return result;
  }, { image: 0, video: 0, text: 0 }), [members]);
  const color = `var(--tag-color-${data.color})`;
  const shapeClass = data.shape === 'rectangle'
    ? 'rounded-none'
    : data.shape === 'frame'
      ? 'rounded-md border-dashed'
      : 'rounded-2xl';

  return (
      <div
        className={`relative h-full min-h-[180px] w-full overflow-visible border bg-[color-mix(in_srgb,var(--canvas-node-subtle-bg)_45%,transparent)] ${shapeClass} ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.3)]'
          : 'border-[var(--canvas-node-border)]'}`}
        style={{ borderTopColor: color }}
      >
        <div className="pointer-events-none flex h-full min-h-[178px] flex-col p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 rounded-md bg-[var(--canvas-node-menu-bg)]/90 px-2.5 py-2 shadow-sm backdrop-blur">
              <p className="max-w-[240px] truncate text-sm font-medium text-text-dark" title={resolvedTitle}>{resolvedTitle}</p>
              <div className="mt-1.5 flex items-center gap-2.5 text-[11px] text-text-muted">
                <span className="inline-flex items-center gap-1"><Image className="h-3 w-3" />{counts.image}</span>
                <span className="inline-flex items-center gap-1"><Video className="h-3 w-3" />{counts.video}</span>
                <span className="inline-flex items-center gap-1"><Type className="h-3 w-3" />{counts.text}</span>
                {missingMemberCount > 0 ? (
                  <span className="inline-flex items-center gap-1 text-amber-500" title={t('node.tag.missingMemberCount', { count: missingMemberCount })}>
                    <AlertTriangle className="h-3 w-3" />{missingMemberCount}
                  </span>
                ) : null}
              </div>
            </div>
            {!data.enabled ? <span className="rounded-full bg-red-500/15 px-2 py-1 text-[10px] text-red-500">{t('node.tag.groupDisabled')}</span> : null}
          </div>
          {members.length === 0 && missingMemberCount === 0 ? <p className="m-auto text-xs text-text-muted">{t('node.tag.noMembers')}</p> : null}
        </div>
        <Handle type="source" id="source" position={Position.Right} className="!h-2 !w-2 !border-surface-dark !bg-accent" />
        <NodeResizeHandle minWidth={260} minHeight={160} maxWidth={1400} maxHeight={1000} />
      </div>
  );
});

TagGroupNode.displayName = 'TagGroupNode';
