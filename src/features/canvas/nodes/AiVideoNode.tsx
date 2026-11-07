import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Bug, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CANVAS_NODE_TYPES, type AiVideoNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  parseDreaminaTransitionSegments,
  resizeDreaminaTransitionSegments,
} from '@/features/canvas/application/dreaminaCapabilities';
import { resolveVideoModelConfig, useVideoModelCatalog } from '@/features/canvas/application/videoModelCatalog';
import { resolveClipboardImageFile } from '@/features/canvas/clipboard/usePasteBridge';
import { CameraChip } from '@/features/canvas/composer/ImageParams';
import { NodeComposer } from '@/features/canvas/composer/NodeComposer';
import { PayloadPreviewDialog } from '@/features/canvas/composer/PayloadPreviewDialog';
import { pasteImageAsReference } from '@/features/canvas/composer/pasteReference';
import { useNodeReferences, type ComposerReference } from '@/features/canvas/composer/useNodeReferences';
import { usePromptDraft } from '@/features/canvas/composer/usePromptDraft';
import { DREAMINA_MULTIFRAME_ENTRY_ID, VideoModelControls, describeVideoDuration } from '@/features/canvas/composer/VideoParams';
import { CameraControlPanel } from '@/features/canvas/ui/CameraControlPanel';
import { GeneratorFace } from '@/features/canvas/ui/GeneratorFace';
import { NodeFrame, resolveNodeBox } from '@/features/canvas/ui/NodeFrame';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type AiVideoNodeProps = NodeProps & {
  id: string;
  data: AiVideoNodeData;
  selected?: boolean;
};

const RESIZE = { minWidth: 360, minHeight: 220, maxWidth: 1400, maxHeight: 1000 } as const;

/** Video generator: same card + composer as the image generator, with video settings. */
export const AiVideoNode = memo(({ id, data, selected = false, width, height }: AiVideoNodeProps) => {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const showPayloadPreview = useSettingsStore((state) => state.showNodePayloadPreview);
  const catalog = useVideoModelCatalog();
  const draft = usePromptDraft(id, 'prompt', data.prompt ?? '');
  const references = useNodeReferences(id);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [payloadOpen, setPayloadOpen] = useState(false);

  const modelConfig = useMemo(() => resolveVideoModelConfig(catalog, data.modelConfig), [catalog, data.modelConfig]);
  const entry = catalog.find((candidate) => candidate.id === modelConfig?.entryId);
  const schema = entry?.inputSchema;

  const acceptsReference = useCallback((reference: ComposerReference) => {
    if (!schema) return true;
    if (reference.kind === 'image') return schema.images.enabled;
    if (reference.kind === 'video') return schema.video.enabled;
    if (reference.kind === 'audio') return schema.audio.enabled;
    return true;
  }, [schema]);
  const imageCount = schema?.images.enabled
    ? Math.min(schema.images.max, references.all.filter((reference) => reference.kind === 'image' && reference.imageUrl).length)
    : 0;

  // Multi-frame video needs one transition per gap between frames; keep the count in step with the wiring.
  const multiframe = entry?.id === DREAMINA_MULTIFRAME_ENTRY_ID && imageCount >= 3;
  const transitions = modelConfig?.extraParams?.dreaminaTransitionSegments ?? modelConfig?.extraParams?.transitionSegments;
  useEffect(() => {
    if (!multiframe || !modelConfig) return;
    const expected = imageCount - 1;
    if (parseDreaminaTransitionSegments(transitions)?.length === expected) return;
    const extraParams: Record<string, unknown> = { ...(modelConfig.extraParams ?? {}), dreaminaTransitionSegments: resizeDreaminaTransitionSegments(transitions, expected) };
    delete extraParams.transitionSegments;
    updateNodeData(id, { modelConfig: { ...modelConfig, extraParams } });
  }, [id, imageCount, modelConfig, multiframe, transitions, updateNodeData]);

  return (
    <>
      <NodeFrame
        type={CANVAS_NODE_TYPES.aiVideo}
        selected={selected}
        icon={<Video />}
        title={resolveNodeDisplayName(CANVAS_NODE_TYPES.aiVideo, data)}
        onRename={(displayName) => updateNodeData(id, { displayName })}
        meta={modelConfig ? describeVideoDuration(entry, data.channelModeId, modelConfig.duration, t('node.aiVideo.workflow')) : undefined}
        actions={showPayloadPreview ? (
          <button
            type="button"
            className="nodrag"
            aria-label={t('node.aiVideo.payloadDebug')}
            title={t('node.aiVideo.payloadDebug')}
            onClick={(event) => {
              event.stopPropagation();
              setPayloadOpen(true);
            }}
          >
            <Bug />
          </button>
        ) : null}
        variant="media"
        {...resolveNodeBox(CANVAS_NODE_TYPES.aiVideo, width, height, RESIZE)}
        resize={RESIZE}
      >
        <GeneratorFace
          kind="video"
          badge={modelConfig?.aspectRatio}
          caption={draft.value}
          generating={data.isGenerating === true}
        />
      </NodeFrame>
      <NodeComposer
        nodeId={id}
        open={selected}
        draft={draft}
        placeholder={t('node.aiVideo.promptPlaceholder')}
        slashCommands={[{ id: 'camera', label: t('cameraControl.title'), focusEditor: false, run: () => setCameraOpen(true) }]}
        acceptsReference={acceptsReference}
        onPasteImage={schema?.images.enabled === false ? undefined : (file) => pasteImageAsReference(id, file)}
        resolvePastedImage={(event) => resolveClipboardImageFile(event.nativeEvent)}
        params={(
          <>
            <VideoModelControls
              catalog={catalog}
              value={modelConfig}
              imageCount={imageCount}
              // A different model has different modes and slots: never carry them over.
              onChange={(next) => updateNodeData(id, next.entryId === modelConfig?.entryId
                ? { modelConfig: next }
                : { modelConfig: next, channelModeId: undefined, referenceSlots: undefined })}
              channel={{
                modeId: data.channelModeId,
                slots: data.referenceSlots ?? {},
                references: references.all,
                onChange: ({ config, ...patch }) => updateNodeData(id, {
                  ...patch,
                  ...(config && modelConfig ? { modelConfig: { ...modelConfig, ...config } } : {}),
                }),
              }}
            />
            <CameraChip active={data.cameraControl?.enabled === true} onClick={() => setCameraOpen(true)} />
          </>
        )}
      />
      <CameraControlPanel
        isOpen={cameraOpen}
        onClose={() => setCameraOpen(false)}
        cameraControl={data.cameraControl}
        onApply={(cameraControl) => updateNodeData(id, { cameraControl })}
      />
      <PayloadPreviewDialog nodeId={id} open={payloadOpen} onClose={() => setPayloadOpen(false)} />
    </>
  );
});

AiVideoNode.displayName = 'AiVideoNode';
