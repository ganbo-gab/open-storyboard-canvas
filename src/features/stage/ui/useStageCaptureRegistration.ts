import { useEffect, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { isBlueprintNode, type BlueprintNodeData, type DirectorMotionProjectV1, type DirectorStudioCameraSettings, type DirectorStudioLightingSettings } from '@/features/canvas/domain/canvasNodes';
import type { BlueprintSceneExportOptions, BlueprintSceneHandle } from '@/features/canvas/ui/BlueprintScene';
import { normalizeDirectorMotionProject, sampleNormalizedDirectorMotion } from '@/features/canvas/application/directorMotion';
import { blobToDataUrl } from '@/features/canvas/application/imageData';
import { deleteAssetReference, saveAsset } from '@/features/assets/application/assetCatalog';
import { useCanvasStore } from '@/stores/canvasStore';
import { createStageCaptureBridge, registerStageViewport } from '../application/stageCommands';
import { assertStageCaptureActive, assertStageCaptureDataCurrent } from '../application/stageCapture';
import { persistDirectorStudioImageSource } from '../application/stageSnapshotMedia';
import type { StageWorkspace } from '../domain/stage';

interface CaptureInputs {
  data: BlueprintNodeData; motionProject: DirectorMotionProjectV1; motionPreviewProject: DirectorMotionProjectV1;
  timelineOpen: boolean; camera: DirectorStudioCameraSettings; lighting: DirectorStudioLightingSettings; panoramaUrl: string | null;
}
interface Options extends CaptureInputs {
  nodeId: string; projectId: string | null;
  editorRef: RefObject<BlueprintSceneHandle | null>;
  exportOptions(): BlueprintSceneExportOptions;
  timeSource: { getSnapshot(): number };
  setWorkspace(mode: StageWorkspace): void;
}

/** Registration and capture revision checks live together; no view or persisted state is owned here. */
export function useStageCaptureRegistration(options: Options): void {
  const { t } = useTranslation();
  const { nodeId, projectId, editorRef, exportOptions, timeSource } = options;
  // Never label a render-phase mutable ref as committed renderer state.
  const committed = useRef(options);
  useEffect(() => { committed.current = options; });
  useEffect(() => registerStageViewport(nodeId, createStageCaptureBridge({
    snapshot: (requests) => {
      const editor = editorRef.current;
      if (!editor) throw new Error(t('directorStudio.addToCanvasNoSnapshot'));
      const time = requests[0].timeSeconds, current = committed.current;
      const node = useCanvasStore.getState().nodes.find((entry) => entry.id === nodeId);
      if (!isBlueprintNode(node)) throw new Error('Stage viewport is unavailable.');
      assertStageCaptureDataCurrent(current.data, node.data);
      const revision = editor.getCaptureRevision();
      if (!revision || revision.inputs.items !== current.data.items || revision.inputs.customActionPoses !== current.data.customActionPoses
        || revision.inputs.mode !== (current.data.mode === 'panorama' ? 'panorama' : 'flat') || revision.inputs.panoramaUrl !== current.panoramaUrl
        || revision.inputs.cameraFov !== current.camera.fov || revision.inputs.cameraDistance !== current.camera.lensDistance
        || revision.inputs.lighting !== current.lighting || revision.inputs.motionProject !== (current.timelineOpen ? current.motionProject : undefined)) {
        throw new Error('Stage renderer synchronization is not ready for the current scene.');
      }
      const project = time !== undefined ? current.motionProject : current.timelineOpen ? current.motionPreviewProject : normalizeDirectorMotionProject(undefined);
      return { editor, revision, data: node.data,
        frame: sampleNormalizedDirectorMotion(project, time ?? (current.timelineOpen ? timeSource.getSnapshot() : 0), current.data.items), options: exportOptions() };
    },
    render: async (request, state, signal) => {
      if (useCanvasStore.getState().nodes.find((node) => node.id === nodeId)?.data !== state.data) throw new Error('Stage changed during capture. Capture the updated scene explicitly.');
      const image = await state.editor.captureFrame({ ...request, revision: state.revision, ...(request.view !== 'current' ? { frame: state.frame } : {}), options: state.options }, signal);
      if (useCanvasStore.getState().nodes.find((node) => node.id === nodeId)?.data !== state.data) throw new Error('Stage changed during capture. Capture the updated scene explicitly.');
      return image;
    },
    persistImage: async (image, request, signal) => {
      assertStageCaptureActive(signal);
      const raw = await blobToDataUrl(image);
      assertStageCaptureActive(signal);
      const source = await persistDirectorStudioImageSource(raw);
      assertStageCaptureActive(signal);
      const asset = await saveAsset({ kind: 'image', source, name: `${t('directorStudio.title')} · ${t('directorStudio.toolbar.screenshot')}`, origin: 'generated',
        projectId: projectId ?? undefined, nodeId, metadata: { stageNodeId: nodeId, view: request.view, ...(request.timeSeconds !== undefined ? { timeSeconds: request.timeSeconds } : {}) } });
      return { assetId: asset.id };
    },
    discardImage: deleteAssetReference,
    setWorkspace: (mode) => committed.current.setWorkspace(mode),
  })), [nodeId, projectId, editorRef, exportOptions, timeSource, t]);
}
