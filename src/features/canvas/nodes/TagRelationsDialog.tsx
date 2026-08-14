import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, LocateFixed, Type, Video } from 'lucide-react';

import { UiButton, UiCheckbox, UiModal, UiSelect } from '@/components/ui';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import {
  CANVAS_COMMAND_VERSION,
  type CanvasCommand,
} from '@/features/canvas/domain/canvasCommands';
import {
  isTagGroupNode,
  isEligibleTagGroupMember,
  getTagGroupMemberKind,
  isTagNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import { useCanvasStore } from '@/stores/canvasStore';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { canvasNavigationFacade } from '@/features/canvas/application/canvasNavigationFacade';

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

function getMemberPreview(node: CanvasNode): { kind: 'image' | 'video' | 'text'; source?: string; text?: string } | null {
  const kind = getTagGroupMemberKind(node.type);
  if (!kind) return null;
  const data = node.data as Record<string, unknown>;
  if (kind === 'image') {
    const firstFrame = Array.isArray(data.frames)
      ? data.frames.find((frame) => frame && typeof frame === 'object') as Record<string, unknown> | undefined
      : undefined;
    const source = typeof data.previewImageUrl === 'string'
      ? data.previewImageUrl
      : typeof data.imageUrl === 'string'
        ? data.imageUrl
        : typeof firstFrame?.previewImageUrl === 'string'
          ? firstFrame.previewImageUrl
          : typeof firstFrame?.imageUrl === 'string'
            ? firstFrame.imageUrl
            : undefined;
    return { kind, source };
  }
  if (kind === 'video') {
    const source = typeof data.thumbnailUrl === 'string' ? data.thumbnailUrl : undefined;
    return { kind, source };
  }
  const text = typeof data.content === 'string'
    ? data.content
    : typeof data.rawContent === 'string'
      ? data.rawContent
      : typeof data.prompt === 'string'
        ? data.prompt
        : '';
  return { kind, text: text.trim().slice(0, 160) };
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
      .filter((node) => variant === 'members' ? isEligibleTagGroupMember(node) : isTagNode(node))
      .sort((left, right) => nodeLabel(left).localeCompare(nodeLabel(right))),
    [nodes, variant],
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
    const validTagIds = new Set(snapshot.nodes.filter((node) => isEligibleTagGroupMember(node)).map((node) => node.id));
    const existingMemberIds = group.data.memberNodeIds.filter((memberId) => validTagIds.has(memberId));
    setMissingMemberCount(group.data.unresolvedMemberIds?.length ?? 0);
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
      input: { groupId: nodeId, memberNodeIds: Array.from(selectedNodeIds) },
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
              const preview = variant === 'members' ? getMemberPreview(node) : null;
              const KindIcon = preview?.kind === 'video' ? Video : preview?.kind === 'text' ? Type : Image;
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
                  {preview?.source ? (
                    <img src={resolveImageDisplayUrl(preview.source)} alt="" className="h-11 w-14 shrink-0 rounded object-cover" />
                  ) : preview ? (
                    <span className="flex h-11 w-14 shrink-0 items-center justify-center rounded bg-[var(--canvas-node-bg)] text-text-muted"><KindIcon className="h-4 w-4" /></span>
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{label}</span>
                    {preview ? <span className="mt-0.5 block truncate text-[10px] text-text-muted">{preview.text || t(`node.tag.memberTypes.${preview.kind}`)}</span> : null}
                  </span>
                  {variant === 'members' ? (
                    <button
                      type="button"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-text-muted hover:bg-accent/10 hover:text-accent"
                      aria-label={t('node.tag.locateMember')}
                      title={t('node.tag.locateMember')}
                      onClick={(event) => {
                        event.stopPropagation();
                        void canvasNavigationFacade.focusNodeIds([node.id], { select: true, padding: 0.24 });
                      }}
                    ><LocateFixed className="h-4 w-4" /></button>
                  ) : null}
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
