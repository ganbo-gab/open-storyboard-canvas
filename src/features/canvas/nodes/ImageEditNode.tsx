import { memo, useEffect, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Bug, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CANVAS_NODE_TYPES, type ImageEditNodeData } from '@/features/canvas/domain/canvasNodes';
import { readGenerationConfiguration } from '@/features/canvas/domain/generationConfiguration';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { useImageModelCatalog, type CatalogEntry } from '@/features/canvas/application/modelCatalog';
import { resolveClipboardImageFile } from '@/features/canvas/clipboard/usePasteBridge';
import { NodeComposer } from '@/features/canvas/composer/NodeComposer';
import { CameraChip, CountChip, ImageModelControls, formatRatioLabel } from '@/features/canvas/composer/ImageParams';
import { PayloadPreviewDialog } from '@/features/canvas/composer/PayloadPreviewDialog';
import { pasteImageAsReference } from '@/features/canvas/composer/pasteReference';
import { useImageGenerationCount } from '@/features/canvas/composer/useImageGenerationCount';
import type { ModelConfigValue } from '@/features/canvas/ui/ModelConfigPicker';
import { usePromptDraft, type PromptDraft } from '@/features/canvas/composer/usePromptDraft';
import { CameraControlPanel } from '@/features/canvas/ui/CameraControlPanel';
import { GeneratorFace } from '@/features/canvas/ui/GeneratorFace';
import { NodeFrame, resolveNodeBox } from '@/features/canvas/ui/NodeFrame';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { getCanvasHistoryReuseOptions } from '@/features/library/application/projectLibraryActions';

type ImageEditNodeProps = NodeProps & {
  id: string;
  data: ImageEditNodeData;
  selected?: boolean;
};

const RESIZE = { minWidth: 360, minHeight: 220, maxWidth: 1400, maxHeight: 1000 } as const;

/** Image generator: a quiet card on the canvas; prompt, references and model live in the composer. */
export const ImageEditNode = memo(({ id, data, selected = false, width, height }: ImageEditNodeProps) => {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const showPayloadPreview = useSettingsStore((state) => state.showNodePayloadPreview);
  const catalog = useImageModelCatalog();
  const draft = usePromptDraft(id, 'prompt', data.prompt ?? '');
  const restoredCount = getCanvasHistoryReuseOptions(data)?.count;
  const [count, setCount] = useState(() => restoredCount ?? 1);
  useEffect(() => { setCount(restoredCount ?? 1); }, [restoredCount]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [payloadOpen, setPayloadOpen] = useState(false);

  // Shown config; generation resolves the same fallback (first usable model) when none is stored.
  const firstUsable = catalog.find((entry) => entry.usable);
  const modelConfig = data.modelConfig
    ?? (firstUsable ? { entryId: firstUsable.id, ratio: firstUsable.supportedRatios[0] ?? 'auto', extraParams: {} } : null);
  const ratio = readGenerationConfiguration({ modelConfig }).aspectRatio;

  return (
    <>
      <NodeFrame
        type={CANVAS_NODE_TYPES.imageEdit}
        selected={selected}
        icon={<Sparkles />}
        title={resolveNodeDisplayName(CANVAS_NODE_TYPES.imageEdit, data)}
        onRename={(displayName) => updateNodeData(id, { displayName })}
        meta={ratio && ratio !== 'auto' ? ratio : undefined}
        actions={showPayloadPreview ? (
          <button
            type="button"
            className="nodrag"
            aria-label={t('node.imageEdit.payloadDebug')}
            title={t('node.imageEdit.payloadDebug')}
            onClick={(event) => {
              event.stopPropagation();
              setPayloadOpen(true);
            }}
          >
            <Bug />
          </button>
        ) : null}
        variant="media"
        {...resolveNodeBox(CANVAS_NODE_TYPES.imageEdit, width, height, RESIZE)}
        resize={RESIZE}
      >
        <GeneratorFace
          kind="image"
          badge={ratio ? formatRatioLabel(ratio, t('modelParams.autoAspectRatio')) : undefined}
          caption={draft.value}
          generating={data.isGenerating === true}
        />
      </NodeFrame>
      {(selected || payloadOpen) && <ImageEditComposer id={id} data={data} selected={selected} draft={draft} catalog={catalog}
        modelConfig={modelConfig} fallbackCount={count} onFallbackCount={setCount}
        onCamera={() => setCameraOpen(true)} payloadOpen={payloadOpen} onClosePreview={() => setPayloadOpen(false)} />}
      <CameraControlPanel
        isOpen={cameraOpen}
        onClose={() => setCameraOpen(false)}
        cameraControl={data.cameraControl}
        onApply={(cameraControl) => updateNodeData(id, { cameraControl })}
      />
    </>
  );
});

ImageEditNode.displayName = 'ImageEditNode';

/** Mount graph-dependent controls only for the active node, preserving large-canvas culling. */
function ImageEditComposer({ id, data, selected, draft, catalog, modelConfig, fallbackCount, onFallbackCount, onCamera, payloadOpen, onClosePreview }: {
  id: string; data: ImageEditNodeData; selected: boolean; draft: PromptDraft; catalog: readonly CatalogEntry[];
  modelConfig: ModelConfigValue | null; fallbackCount: number; onFallbackCount(count: number): void;
  onCamera(): void; payloadOpen: boolean; onClosePreview(): void;
}) {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore(state => state.updateNodeData);
  const changeModel = (next: ModelConfigValue) => updateNodeData(id, { modelConfig: next,
    ...(next.entryId !== modelConfig?.entryId ? { channelModeId: undefined, referenceSlots: undefined } : {}) });
  const batch = useImageGenerationCount(id, modelConfig, fallbackCount, changeModel, onFallbackCount);
  return <>
      <NodeComposer
        nodeId={id}
        open={selected}
        draft={draft}
        placeholder={t('node.imageEdit.promptPlaceholder')}
        slashCommands={[{ id: 'camera', label: t('cameraControl.title'), focusEditor: false, run: () => onCamera() }]}
        onPasteImage={(file) => pasteImageAsReference(id, file)}
        resolvePastedImage={(event) => resolveClipboardImageFile(event.nativeEvent)}
        requestOptions={() => ({ count: batch.requestCount })}
        trailingActions={<CountChip value={batch.count} choices={batch.choices} onChange={batch.setCount} />}
        params={(
          <>
            <ImageModelControls nodeId={id} catalog={catalog} value={modelConfig} onChange={changeModel} />
            <CameraChip active={data.cameraControl?.enabled === true} onClick={() => onCamera()} />
          </>
        )}
      />
      <PayloadPreviewDialog
        nodeId={id}
        open={payloadOpen}
        options={{ ...(getCanvasHistoryReuseOptions(data) ?? {}), count: batch.requestCount }}
        onClose={onClosePreview}
      />
  </>;
}
