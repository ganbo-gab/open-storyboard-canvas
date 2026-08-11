import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiCheckbox, UiModal, UiSelect } from '@/components/ui';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import {
  CANVAS_COMMAND_VERSION,
  type CanvasCommand,
} from '@/features/canvas/domain/canvasCommands';
import {
  isTagGroupNode,
  isTagNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import { useCanvasStore } from '@/stores/canvasStore';

type TagRelationsDialogProps = {
  isOpen: boolean;
  nodeId: string;
  onClose: () => void;
  variant: 'connections' | 'members';
};

function nodeLabel(node: CanvasNode): string {
  return resolveNodeDisplayName(node.type, node.data);
}

function createTransactionId(nodeId: string): string {
  return `ui-tag-relations-${nodeId}-${Date.now().toString(36)}`;
}

export function TagRelationsDialog({
  isOpen,
  nodeId,
  onClose,
  variant,
}: TagRelationsDialogProps) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const [sourceNodeId, setSourceNodeId] = useState('');
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set());
  const [missingMemberCount, setMissingMemberCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const sourceCandidates = useMemo(
    () => nodes
      .filter((node) => node.id !== nodeId && nodeHasSourceHandle(node.type))
      .sort((left, right) => nodeLabel(left).localeCompare(nodeLabel(right))),
    [nodeId, nodes],
  );
  const targetCandidates = useMemo(
    () => nodes
      .filter((node) => node.id !== nodeId && nodeHasTargetHandle(node.type))
      .sort((left, right) => nodeLabel(left).localeCompare(nodeLabel(right))),
    [nodeId, nodes],
  );
  const tagCandidates = useMemo(
    () => nodes
      .filter(isTagNode)
      .sort((left, right) => nodeLabel(left).localeCompare(nodeLabel(right))),
    [nodes],
  );

  useEffect(() => {
    if (!isOpen) return;
    const snapshot = useCanvasStore.getState();
    setError(null);
    setMissingMemberCount(0);
    if (variant === 'connections') {
      setSourceNodeId(snapshot.edges.find((edge) => edge.target === nodeId)?.source ?? '');
      setSelectedNodeIds(new Set(
        snapshot.edges.filter((edge) => edge.source === nodeId).map((edge) => edge.target),
      ));
      return;
    }
    const group = snapshot.nodes.find((node) => node.id === nodeId);
    if (!isTagGroupNode(group)) {
      setSelectedNodeIds(new Set());
      return;
    }
    const validTagIds = new Set(snapshot.nodes.filter(isTagNode).map((node) => node.id));
    const existingMemberIds = group.data.memberTagIds.filter((tagId) => validTagIds.has(tagId));
    setMissingMemberCount(group.data.memberTagIds.length - existingMemberIds.length);
    setSelectedNodeIds(new Set(existingMemberIds));
  }, [isOpen, nodeId, variant]);

  const toggleSelected = (candidateId: string) => {
    setSelectedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  };

  const saveConnections = () => {
    const currentInbound = edges.filter((edge) => edge.target === nodeId);
    const currentOutbound = edges.filter((edge) => edge.source === nodeId);
    const disconnectIds = [
      ...currentInbound
        .filter((edge) => edge.source !== sourceNodeId)
        .map((edge) => edge.id),
      ...currentOutbound
        .filter((edge) => !selectedNodeIds.has(edge.target))
        .map((edge) => edge.id),
    ];
    const commands: CanvasCommand[] = [];
    if (disconnectIds.length > 0) {
      commands.push({
        type: 'edge.disconnect',
        version: CANVAS_COMMAND_VERSION,
        input: { edgeIds: Array.from(new Set(disconnectIds)) },
      });
    }
    if (sourceNodeId && !currentInbound.some((edge) => edge.source === sourceNodeId)) {
      commands.push({
        type: 'edge.connect',
        version: CANVAS_COMMAND_VERSION,
        input: { sourceNodeId, targetNodeId: nodeId },
      });
    }
    selectedNodeIds.forEach((targetNodeId) => {
      if (!currentOutbound.some((edge) => edge.target === targetNodeId)) {
        commands.push({
          type: 'edge.connect',
          version: CANVAS_COMMAND_VERSION,
          input: { sourceNodeId: nodeId, targetNodeId },
        });
      }
    });

    if (commands.length === 0) {
      onClose();
      return;
    }
    if (commands.length > 100) {
      setError(t('node.tag.tooManyConnections'));
      return;
    }
    setIsSaving(true);
    const result = canvasCommandRegistry.executeTransaction({
      id: createTransactionId(nodeId),
      origin: 'ui',
      expectedRevision: canvasCommandRegistry.getRevision(),
      commands,
    });
    setIsSaving(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onClose();
  };

  const saveMembers = async () => {
    setIsSaving(true);
    const result = await canvasCommandRegistry.execute({
      type: 'tagGroup.setMembers',
      version: CANVAS_COMMAND_VERSION,
      input: { groupId: nodeId, memberTagIds: Array.from(selectedNodeIds) },
    }, 'ui');
    setIsSaving(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onClose();
  };

  const candidates = variant === 'connections' ? targetCandidates : tagCandidates;
  const title = variant === 'connections'
    ? t('node.tag.connectionsTitle')
    : t('node.tag.membersTitle');

  return (
    <UiModal
      isOpen={isOpen}
      title={title}
      onClose={onClose}
      widthClassName="w-[560px]"
      footer={(
        <>
          <UiButton type="button" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </UiButton>
          <UiButton
            type="button"
            size="sm"
            variant="primary"
            disabled={isSaving}
            onClick={() => void (variant === 'connections' ? saveConnections() : saveMembers())}
          >
            {isSaving ? t('common.saving') : t('common.save')}
          </UiButton>
        </>
      )}
    >
      <div className="space-y-4">
        {variant === 'connections' ? (
          <label className="block space-y-1.5 text-xs text-text-muted">
            <span>{t('node.tag.sourceLabel')}</span>
            <UiSelect
              value={sourceNodeId}
              aria-label={t('node.tag.sourceLabel')}
              onChange={(event) => setSourceNodeId(event.target.value)}
            >
              <option value="">{t('node.tag.noSource')}</option>
              {sourceCandidates.map((node) => (
                <option key={node.id} value={node.id}>{nodeLabel(node)}</option>
              ))}
            </UiSelect>
          </label>
        ) : null}

        <section aria-label={variant === 'connections' ? t('node.tag.targetsLabel') : t('node.tag.membersLabel')}>
          <div className="mb-2 flex items-center justify-between gap-3 text-xs text-text-muted">
            <span>{variant === 'connections' ? t('node.tag.targetsLabel') : t('node.tag.membersLabel')}</span>
            <span>{t('node.tag.selectedCount', { count: selectedNodeIds.size })}</span>
          </div>
          {variant === 'members' && missingMemberCount > 0 ? (
            <p className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              {t('node.tag.missingMembersWillBeRemoved', { count: missingMemberCount })}
            </p>
          ) : null}
          <div className="max-h-[320px] space-y-1 overflow-y-auto pr-1">
            {candidates.length === 0 ? (
              <p className="py-6 text-center text-sm text-text-muted">{t('node.tag.emptyCandidates')}</p>
            ) : candidates.map((node) => {
              const label = nodeLabel(node);
              return (
                <div
                  key={node.id}
                  className="flex cursor-pointer items-center gap-3 rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-subtle-bg)] px-3 py-2 text-sm text-text-dark hover:border-accent/45"
                  title={label}
                  onClick={() => toggleSelected(node.id)}
                >
                  <UiCheckbox
                    checked={selectedNodeIds.has(node.id)}
                    aria-label={label}
                    onClick={(event) => event.stopPropagation()}
                    onCheckedChange={() => toggleSelected(node.id)}
                  />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                </div>
              );
            })}
          </div>
        </section>
        {error ? (
          <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
            {error}
          </p>
        ) : null}
      </div>
    </UiModal>
  );
}
