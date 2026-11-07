import { memo, useEffect, useMemo, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Bug, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CANVAS_NODE_TYPES, type AiTextNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { collectAiTextInputs, computeAiTextInputHash } from '@/features/canvas/application/aiText/helpers';
import { useChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import { NodeComposer } from '@/features/canvas/composer/NodeComposer';
import { ModelPickerChip } from '@/features/canvas/composer/ModelPicker';
import { PayloadPreviewDialog } from '@/features/canvas/composer/PayloadPreviewDialog';
import { useNodeReferences } from '@/features/canvas/composer/useNodeReferences';
import { usePromptDraft } from '@/features/canvas/composer/usePromptDraft';
import { GeneratorFace } from '@/features/canvas/ui/GeneratorFace';
import { NodeFrame, resolveNodeBox, type NodeFrameStatus } from '@/features/canvas/ui/NodeFrame';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type AiTextNodeProps = NodeProps & {
  id: string;
  data: AiTextNodeData;
  selected?: boolean;
};

const RESIZE = { minWidth: 300, minHeight: 180, maxWidth: 1200, maxHeight: 1000 } as const;
const LEGACY_TEXT_AGENT_NOTICE_STORAGE_KEY = 'storyboard:legacy-text-agent-retirement-notice:v1';

/** Text generator: reads connected text/images, streams its answer into a result card. */
export const AiTextNode = memo(({ id, data, selected = false, width, height }: AiTextNodeProps) => {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const showPayloadPreview = useSettingsStore((state) => state.showNodePayloadPreview);
  const catalog = useChatModelCatalog();
  const draft = usePromptDraft(id, 'prompt', data.prompt ?? '');
  const references = useNodeReferences(id);
  const [payloadOpen, setPayloadOpen] = useState(false);
  const [legacyNotice, setLegacyNotice] = useState(false);

  const entry = catalog.find((candidate) => candidate.id === data.model)
    ?? catalog.find((candidate) => candidate.providerId === data.providerId && candidate.usable)
    ?? catalog.find((candidate) => candidate.usable)
    ?? null;

  // A result is stale once its inputs, prompt or model differ from the run that produced it.
  // Recomputed only when upstream content (reference signature), prompt or model changes.
  const stale = useMemo(() => {
    if (!data.lastRunInputHash) return false;
    const { nodes, edges } = useCanvasStore.getState();
    const hash = computeAiTextInputHash({
      providerId: entry?.providerId ?? data.providerId ?? null,
      model: entry?.id ?? data.model,
      agentPrompt: '',
      userPrompt: draft.value,
      parts: collectAiTextInputs(id, nodes, edges),
    });
    return hash !== data.lastRunInputHash;
  }, [data.lastRunInputHash, data.model, data.providerId, draft.value, entry, id, references.all]);

  // Text agents were retired; tell the owner of an old node once, then never again.
  useEffect(() => {
    if (!data.agentId) return;
    try {
      if (window.localStorage.getItem(LEGACY_TEXT_AGENT_NOTICE_STORAGE_KEY)) return;
      window.localStorage.setItem(LEGACY_TEXT_AGENT_NOTICE_STORAGE_KEY, 'shown');
    } catch {
      // Storage can be unavailable in privacy-restricted contexts; showing the notice again is harmless.
    }
    setLegacyNotice(true);
  }, [data.agentId]);

  const textCount = references.all.filter((reference) => reference.kind === 'text').length;
  const imageCount = references.all.filter((reference) => reference.kind === 'image').length;
  const badge = textCount || imageCount
    ? [textCount ? t('node.aiText.textInputCount', { count: textCount }) : null, imageCount ? t('node.aiText.imageInputCount', { count: imageCount }) : null]
      .filter(Boolean).join(' · ')
    : null;

  const status: NodeFrameStatus | null = data.lastError
    ? { kind: 'error', label: data.lastError }
    : legacyNotice
      ? { kind: 'attention', label: t('node.aiText.legacyAgentNotice') }
      : stale
        ? { kind: 'attention', label: t('node.aiText.staleResult') }
        : null;

  return (
    <>
      <NodeFrame
        type={CANVAS_NODE_TYPES.aiText}
        selected={selected}
        icon={<FileText />}
        title={resolveNodeDisplayName(CANVAS_NODE_TYPES.aiText, data)}
        onRename={(displayName) => updateNodeData(id, { displayName })}
        meta={entry?.modelLabel}
        status={status}
        actions={showPayloadPreview ? (
          <button
            type="button"
            className="nodrag"
            aria-label={t('node.aiText.payloadDebug')}
            title={t('node.aiText.payloadDebug')}
            onClick={(event) => {
              event.stopPropagation();
              setPayloadOpen(true);
            }}
          >
            <Bug />
          </button>
        ) : null}
        variant="media"
        {...resolveNodeBox(CANVAS_NODE_TYPES.aiText, width, height, RESIZE)}
        resize={RESIZE}
      >
        <GeneratorFace kind="text" badge={badge} caption={draft.value} />
      </NodeFrame>
      <NodeComposer
        nodeId={id}
        open={selected}
        draft={draft}
        placeholder={t('node.aiText.promptPlaceholder')}
        params={(
          <ModelPickerChip
            options={catalog.map((candidate) => ({
              id: candidate.id,
              group: candidate.providerLabel,
              label: candidate.modelLabel,
              usable: candidate.usable,
              hint: candidate.notReadyReason,
            }))}
            value={entry?.id ?? null}
            onChange={(model) => {
              const picked = catalog.find((candidate) => candidate.id === model);
              if (picked) updateNodeData(id, { model: picked.id, providerId: picked.providerId });
            }}
          />
        )}
      />
      <PayloadPreviewDialog nodeId={id} open={payloadOpen} onClose={() => setPayloadOpen(false)} />
    </>
  );
});

AiTextNode.displayName = 'AiTextNode';
