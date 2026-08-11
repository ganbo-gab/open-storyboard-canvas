import { memo, useMemo, useState } from 'react';
import { Copy, Power, Tags, Trash2, UsersRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { CANVAS_COMMAND_VERSION } from '@/features/canvas/domain/canvasCommands';
import {
  CANVAS_NODE_TYPES,
  isTagNode,
  type TagGroupNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { useCanvasStore } from '@/stores/canvasStore';

import { TagRelationsDialog } from './TagRelationsDialog';

type TagGroupNodeProps = {
  id: string;
  data: TagGroupNodeData;
  selected?: boolean;
};

export const TagGroupNode = memo(({ id, data, selected }: TagGroupNodeProps) => {
  const { t } = useTranslation();
  const nodes = useCanvasStore((state) => state.nodes);
  const [isMembersOpen, setIsMembersOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.tagGroup, data),
    [data],
  );
  const members = useMemo(() => {
    const memberIds = new Set(data.memberTagIds);
    return nodes.filter((node) => memberIds.has(node.id) && isTagNode(node));
  }, [data.memberTagIds, nodes]);
  const missingMemberCount = Math.max(0, data.memberTagIds.length - members.length);

  const run = async (command: Parameters<typeof canvasCommandRegistry.execute>[0]) => {
    const result = await canvasCommandRegistry.execute(command, 'ui');
    setError(result.ok ? null : result.error.message);
  };

  return (
    <>
      <div
        className={`relative h-full min-h-[180px] w-full overflow-visible rounded-lg border bg-[var(--canvas-node-subtle-bg)] ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.3)]'
          : 'border-[var(--canvas-node-border)]'}`}
      >
        <NodeHeader
          className={NODE_HEADER_FLOATING_POSITION_CLASS}
          icon={<Tags className="h-4 w-4" />}
          titleText={resolvedTitle}
          editable
          onTitleChange={(displayName) => void run({
            type: 'node.rename',
            version: CANVAS_COMMAND_VERSION,
            input: { nodeId: id, displayName },
          })}
        />

        <div className="flex h-full min-h-[178px] flex-col p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text-dark" title={resolvedTitle}>{resolvedTitle}</p>
              <p className={`mt-1 text-xs ${data.enabled ? 'text-text-muted' : 'text-red-500'}`}>
                {data.enabled
                  ? t('node.tag.memberCount', { count: members.length })
                  : t('node.tag.groupDisabled')}
              </p>
              {missingMemberCount > 0 ? (
                <p className="mt-1 text-[10px] text-amber-500">
                  {t('node.tag.missingMemberCount', { count: missingMemberCount })}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              className={`nodrag nowheel inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors ${data.enabled
                ? 'border-accent/35 bg-accent/10 text-accent'
                : 'border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-text-muted'}`}
              aria-pressed={data.enabled}
              aria-label={data.enabled ? t('node.tag.disableGroup') : t('node.tag.enableGroup')}
              title={data.enabled ? t('node.tag.disableGroup') : t('node.tag.enableGroup')}
              onClick={() => void run({
                type: 'node.setEnabled',
                version: CANVAS_COMMAND_VERSION,
                input: { nodeIds: [id], enabled: !data.enabled },
              })}
            >
              <Power className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-3 min-h-0 flex-1 overflow-hidden rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-bg)] p-2">
            {members.length === 0 ? (
              <p className="py-3 text-center text-xs text-text-muted">{t('node.tag.noMembers')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {members.slice(0, 8).map((member) => {
                  const label = resolveNodeDisplayName(member.type, member.data);
                  return <span key={member.id} title={label} className="max-w-full truncate rounded border border-[var(--canvas-node-field-border)] px-2 py-1 text-[11px] text-text-dark">{label}</span>;
                })}
                {members.length > 8 ? <span className="px-1 py-1 text-[11px] text-text-muted">+{members.length - 8}</span> : null}
              </div>
            )}
          </div>

          <div className="nodrag nowheel mt-2 flex items-center justify-end gap-1 border-t border-[var(--canvas-node-divider)] pt-2">
            <button type="button" className="canvas-node-icon-button" onClick={() => setIsMembersOpen(true)} aria-label={t('node.tag.editMembers')} title={t('node.tag.editMembers')}>
              <UsersRound className="h-3.5 w-3.5" />
            </button>
            <button type="button" className="canvas-node-icon-button" onClick={() => void run({ type: 'node.duplicate', version: CANVAS_COMMAND_VERSION, input: { copies: [{ sourceNodeId: id }] } })} aria-label={t('node.tag.duplicate')} title={t('node.tag.duplicate')}>
              <Copy className="h-3.5 w-3.5" />
            </button>
            <button type="button" className="canvas-node-icon-button text-red-500" onClick={() => void run({ type: 'node.delete', version: CANVAS_COMMAND_VERSION, input: { nodeIds: [id] } })} aria-label={t('common.delete')} title={t('common.delete')}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          {error ? <p role="alert" className="mt-1 truncate text-[10px] text-red-500" title={error}>{error}</p> : null}
        </div>
        <NodeResizeHandle minWidth={260} minHeight={160} maxWidth={900} maxHeight={700} />
      </div>
      <TagRelationsDialog
        isOpen={isMembersOpen}
        nodeId={id}
        variant="members"
        onClose={() => setIsMembersOpen(false)}
      />
    </>
  );
});

TagGroupNode.displayName = 'TagGroupNode';
