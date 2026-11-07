import { memo, useCallback, useMemo, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { AudioLines, Bug } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CANVAS_NODE_TYPES, type AiAudioNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { currentAudioInputHash } from '@/features/canvas/application/generation/audioGeneration';
import { AudioModelControls, type AudioChannelState } from '@/features/canvas/composer/AudioParams';
import { declaredChannelModes } from '@/features/canvas/composer/ChannelModeSections';
import { useChannelAudioModelCatalog, type ChannelAudioModelEntry } from '@/features/channels/application/audioModelCatalog';
import { resolveNativeChannelModel } from '@/features/channels/application/channelService';
import { modeParamDefaults, retainModeState } from '@/features/channels/application/modelModes';
import { NodeComposer } from '@/features/canvas/composer/NodeComposer';
import { PayloadPreviewDialog } from '@/features/canvas/composer/PayloadPreviewDialog';
import { useNodeReferences, type ComposerReference } from '@/features/canvas/composer/useNodeReferences';
import { usePromptDraft } from '@/features/canvas/composer/usePromptDraft';
import { GeneratorFace } from '@/features/canvas/ui/GeneratorFace';
import { NodeFrame, resolveNodeBox, type NodeFrameStatus } from '@/features/canvas/ui/NodeFrame';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type AiAudioNodeProps = NodeProps & {
  id: string;
  data: AiAudioNodeData;
  selected?: boolean;
};

const RESIZE = { minWidth: 300, minHeight: 180, maxWidth: 1200, maxHeight: 900 } as const;

/** Audio generator: speaks the prompt (plus connected text) with the chosen model and voice. */
export const AiAudioNode = memo(({ id, data, selected = false, width, height }: AiAudioNodeProps) => {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const showPayloadPreview = useSettingsStore((state) => state.showNodePayloadPreview);
  const draft = usePromptDraft(id, 'prompt', data.prompt ?? '');
  const references = useNodeReferences(id);
  const [payloadOpen, setPayloadOpen] = useState(false);

  const channelCatalog = useChannelAudioModelCatalog();
  const native = resolveNativeChannelModel(data.modelId ?? '');
  const channelEntry = (native ? channelCatalog.find((entry) => entry.channelModelRef.profileId === native.profile.id && entry.modelId === native.model.id) : undefined)
    ?? (!data.modelId ? channelCatalog.find((entry) => entry.usable) : undefined);
  // Connected text feeds the prompt; media uses declared reference slots.
  const acceptsReference = useCallback((reference: ComposerReference) => reference.kind === 'text', []);

  const channelMode = channelEntry ? channelEntry.modes.find((mode) => mode.mode.id === data.channelModeId) ?? channelEntry.modes[0] : undefined;
  const channel: AudioChannelState | null = channelEntry && channelMode ? {
    entry: channelEntry,
    mode: channelMode,
    params: { ...modeParamDefaults(channelMode), ...(data.audioGenerationParams ?? {}) },
    slots: data.referenceSlots ?? {},
    references: references.all,
    onChange: (patch) => updateNodeData(id, patch),
  } : null;
  const pickChannelModel = (entry: ChannelAudioModelEntry) => {
    const mode = entry.modes[0];
    if (!mode) return;
    const declared = Boolean(declaredChannelModes(entry.modes));
    const kept = retainModeState(mode, (data.audioGenerationParams ?? {}), data.referenceSlots ?? {});
    updateNodeData(id, {
      modelId: entry.id,
      channelModeId: declared ? mode.mode.id : undefined,
      referenceSlots: declared ? kept.slots : undefined,
      audioGenerationParams: kept.params,
    });
  };

  const textCount = references.all.filter((reference) => reference.kind === 'text').length;
  // Recomputed when the node, its model settings or upstream content change — not on unrelated canvas edits.
  const stale = useMemo(() => {
    if (!data.lastRunInputHash) return false;
    const current = currentAudioInputHash(id);
    return current !== null && current !== data.lastRunInputHash;
  }, [channelCatalog, data, id, references.all]);
  const status: NodeFrameStatus | null = data.modelId && !channelEntry
    ? { kind: 'error', label: t('node.aiAudio.unavailableModel') }
    : data.lastError
    ? { kind: 'error', label: data.lastError }
    : stale ? { kind: 'attention', label: t('node.aiAudio.staleResult') } : null;

  return (
    <>
      <NodeFrame
        type={CANVAS_NODE_TYPES.aiAudio}
        selected={selected}
        icon={<AudioLines />}
        title={resolveNodeDisplayName(CANVAS_NODE_TYPES.aiAudio, data)}
        onRename={(displayName) => updateNodeData(id, { displayName })}
        meta={channel?.entry.modelLabel}
        status={status}
        actions={showPayloadPreview ? (
          <button
            type="button"
            className="nodrag"
            aria-label={t('node.aiAudio.payloadDebug')}
            title={t('node.aiAudio.payloadDebug')}
            onClick={(event) => {
              event.stopPropagation();
              setPayloadOpen(true);
            }}
          >
            <Bug />
          </button>
        ) : null}
        variant="media"
        {...resolveNodeBox(CANVAS_NODE_TYPES.aiAudio, width, height, RESIZE)}
        resize={RESIZE}
      >
        <GeneratorFace
          kind="audio"
          badge={textCount ? t('node.aiText.textInputCount', { count: textCount }) : null}
          caption={draft.value}
        />
      </NodeFrame>
      <NodeComposer
        nodeId={id}
        open={selected}
        draft={draft}
        placeholder={t('node.aiAudio.promptPlaceholder')}
        acceptsReference={acceptsReference}
        generateLabel={t('node.aiAudio.generate')}
        params={(
          <AudioModelControls
            selectedModelId={data.modelId}
            channelCatalog={channelCatalog}
            channel={channel}
            onPickChannelModel={pickChannelModel}
          />
        )}
      />
      <PayloadPreviewDialog nodeId={id} open={payloadOpen} onClose={() => setPayloadOpen(false)} />
    </>
  );
});

AiAudioNode.displayName = 'AiAudioNode';
