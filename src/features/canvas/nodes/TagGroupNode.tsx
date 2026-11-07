import { memo, useMemo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { AlertTriangle, Image, Tags, Type, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  getTagGroupMemberKind,
  type TagGroupNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeFrame } from '@/features/canvas/ui/NodeFrame';
import { useCanvasStore } from '@/stores/canvasStore';

type TagGroupNodeProps = NodeProps & {
  id: string;
  data: TagGroupNodeData;
  selected?: boolean;
};

export const TagGroupNode = memo(({ id, data, selected }: TagGroupNodeProps) => {
  const { t } = useTranslation();
  const nodes = useCanvasStore((state) => state.nodes);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
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
  const borderRadius = data.shape === 'rectangle' ? 0 : data.shape === 'frame' ? 6 : 16;

  return (
    <NodeFrame
      type={CANVAS_NODE_TYPES.tagGroup}
      selected={selected}
      variant="group"
      icon={<Tags style={{ color }} />}
      title={resolvedTitle}
      onRename={(displayName) => updateNodeData(id, { displayName })}
      meta={(
        <span className="inline-flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1"><Image className="h-3 w-3" />{counts.image}</span>
          <span className="inline-flex items-center gap-1"><Video className="h-3 w-3" />{counts.video}</span>
          <span className="inline-flex items-center gap-1"><Type className="h-3 w-3" />{counts.text}</span>
          {missingMemberCount > 0 ? (
            <span className="inline-flex items-center gap-1 text-warning" title={t('node.tag.missingMemberCount', { count: missingMemberCount })}>
              <AlertTriangle className="h-3 w-3" />{missingMemberCount}
            </span>
          ) : null}
        </span>
      )}
      badges={!data.enabled ? <span className="node-frame__badge text-danger">{t('node.tag.groupDisabled')}</span> : null}
      status={missingMemberCount > 0 ? { kind: 'attention', label: t('node.tag.missingMemberCount', { count: missingMemberCount }) } : null}
      resize={{ minWidth: 260, minHeight: 160, maxWidth: 1400, maxHeight: 1000 }}
      bodyStyle={{ borderRadius, border: `1px ${data.shape === 'frame' ? 'dashed' : 'solid'} ${color}` }}
    >
      {members.length === 0 && missingMemberCount === 0 ? <p className="pointer-events-none m-auto text-xs text-text-muted">{t('node.tag.noMembers')}</p> : null}
    </NodeFrame>
  );
});

TagGroupNode.displayName = 'TagGroupNode';
