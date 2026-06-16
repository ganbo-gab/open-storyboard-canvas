import {
  AUTO_REQUEST_ASPECT_RATIO,
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  type ImageSize,
  type AiAudioNodeData,
  type AiTextNodeData,
  type AiVideoNodeData,
  type AudioNodeData,
  type BlueprintNodeData,
  type CanvasNodeData,
  type CanvasNodeType,
  type ExportImageNodeData,
  type GroupNodeData,
  type ImageEditNodeData,
  type JsonCardNodeData,
  type PanoramaNodeData,
  type StoryboardGenNodeData,
  type StoryboardSplitNodeData,
  type TextAnnotationNodeData,
  type UploadImageNodeData,
  type VideoNodeData,
} from './canvasNodes';
import { DEFAULT_NODE_DISPLAY_NAME } from './nodeDisplay';
import { DEFAULT_IMAGE_MODEL_ID } from '../models';

export type MenuIconKey = 'upload' | 'sparkles' | 'layout' | 'text' | 'video' | 'audio';
export type CanvasNodeSelectionToolbarMode = 'full' | 'deleteOnly' | 'none';

export interface CanvasNodeCapabilities {
  toolbar: boolean;
  selectionToolbar?: CanvasNodeSelectionToolbarMode;
  promptInput: boolean;
}

export interface CanvasNodeConnectivity {
  sourceHandle: boolean;
  targetHandle: boolean;
  connectMenu: {
    fromSource: boolean;
    fromTarget: boolean;
  };
}

export interface CanvasNodeDefinition<TData extends CanvasNodeData = CanvasNodeData> {
  type: CanvasNodeType;
  menuLabelKey: string;
  menuIcon: MenuIconKey;
  visibleInMenu: boolean;
  defaultSize?: {
    width: number;
    height: number;
  };
  capabilities: CanvasNodeCapabilities;
  connectivity: CanvasNodeConnectivity;
  createDefaultData: () => TData;
}

const uploadNodeDefinition: CanvasNodeDefinition<UploadImageNodeData> = {
  type: CANVAS_NODE_TYPES.upload,
  menuLabelKey: 'node.menu.uploadImage',
  menuIcon: 'upload',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: false,
    connectMenu: {
      fromSource: false,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.upload],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: '1:1',
    isSizeManuallyAdjusted: false,
    sourceFileName: null,
  }),
};

const imageEditNodeDefinition: CanvasNodeDefinition<ImageEditNodeData> = {
  type: CANVAS_NODE_TYPES.imageEdit,
  menuLabelKey: 'node.menu.aiImageGeneration',
  menuIcon: 'sparkles',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.imageEdit],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isSizeManuallyAdjusted: false,
    requestAspectRatio: AUTO_REQUEST_ASPECT_RATIO,
    prompt: '',
    model: DEFAULT_IMAGE_MODEL_ID,
    size: '2K' as ImageSize,
    extraParams: {},
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
    selectedFunctionChip: null,
    selectedPromptPresetId: null,
  }),
};

const aiVideoNodeDefinition: CanvasNodeDefinition<AiVideoNodeData> = {
  type: CANVAS_NODE_TYPES.aiVideo,
  menuLabelKey: 'node.menu.aiVideoGeneration',
  menuIcon: 'video',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    selectionToolbar: 'full',
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.aiVideo],
    prompt: '',
    modelConfig: undefined,
    extraParams: {},
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 15 * 60 * 1000,
    selectedPromptPresetId: null,
  }),
};

const aiTextNodeDefinition: CanvasNodeDefinition<AiTextNodeData> = {
  type: CANVAS_NODE_TYPES.aiText,
  menuLabelKey: 'node.menu.aiTextGeneration',
  menuIcon: 'sparkles',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    selectionToolbar: 'deleteOnly',
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.aiText],
    prompt: '',
    providerId: null,
    model: '',
    agentId: null,
    isToolbarCollapsed: false,
    resultNodeId: null,
    lastRunInputHash: null,
    lastPreparedPayload: null,
    lastOutputType: null,
    lastError: null,
  }),
};

const aiAudioNodeDefinition: CanvasNodeDefinition<AiAudioNodeData> = {
  type: CANVAS_NODE_TYPES.aiAudio,
  menuLabelKey: 'node.menu.aiAudioGeneration',
  menuIcon: 'audio',
  visibleInMenu: true,
  defaultSize: {
    width: 640,
    height: 340,
  },
  capabilities: {
    toolbar: true,
    selectionToolbar: 'deleteOnly',
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.aiAudio],
    prompt: '',
    modelId: null,
    voiceId: null,
    resultNodeId: null,
    lastRunInputHash: null,
    lastError: null,
  }),
};

const exportImageNodeDefinition: CanvasNodeDefinition<ExportImageNodeData> = {
  type: CANVAS_NODE_TYPES.exportImage,
  menuLabelKey: 'node.menu.uploadImage',
  menuIcon: 'upload',
  visibleInMenu: false,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.exportImage],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isSizeManuallyAdjusted: false,
    resultKind: 'generic',
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
    generationJobId: null,
    generationProviderId: null,
    generationClientSessionId: null,
    generationError: null,
    generationErrorDetails: null,
    generationRetryResultUrl: null,
  }),
};

const videoNodeDefinition: CanvasNodeDefinition<VideoNodeData> = {
  type: CANVAS_NODE_TYPES.video,
  menuLabelKey: 'node.menu.aiVideoGeneration',
  menuIcon: 'video',
  visibleInMenu: false,
  capabilities: {
    toolbar: true,
    selectionToolbar: 'full',
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.video],
    videoUrl: null,
    localVideoUrl: null,
    thumbnailUrl: null,
    aspectRatio: '16:9',
    durationSeconds: null,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 15 * 60 * 1000,
    generationJobId: null,
    generationProviderId: null,
    generationClientSessionId: null,
    generationError: null,
    generationErrorDetails: null,
    generationRetryResultUrl: null,
  }),
};

const audioNodeDefinition: CanvasNodeDefinition<AudioNodeData> = {
  type: CANVAS_NODE_TYPES.audio,
  menuLabelKey: 'node.menu.audio',
  menuIcon: 'audio',
  visibleInMenu: true,
  defaultSize: {
    width: 360,
    height: 160,
  },
  capabilities: {
    toolbar: true,
    selectionToolbar: 'full',
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.audio],
    audioUrl: null,
    localAudioUrl: null,
    sourceFileName: null,
    durationSeconds: null,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 180000,
    generationElapsedMs: null,
    generationError: null,
    generationErrorDetails: null,
    sourcePrompt: '',
    sourceTextLength: 0,
    sourceVoiceId: null,
    sourceModelId: null,
  }),
};

const groupNodeDefinition: CanvasNodeDefinition<GroupNodeData> = {
  type: CANVAS_NODE_TYPES.group,
  menuLabelKey: 'node.menu.storyboard',
  menuIcon: 'layout',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: false,
    targetHandle: false,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.group],
    label: '分组',
  }),
};

const textAnnotationNodeDefinition: CanvasNodeDefinition<TextAnnotationNodeData> = {
  type: CANVAS_NODE_TYPES.textAnnotation,
  menuLabelKey: 'node.menu.textAnnotation',
  menuIcon: 'text',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    selectionToolbar: 'deleteOnly',
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.textAnnotation],
    content: '',
    isGenerating: false,
    generationStartedAt: null,
    generationElapsedMs: null,
    sourceAiNodeId: null,
    sourceAgentId: null,
  }),
};

const jsonCardNodeDefinition: CanvasNodeDefinition<JsonCardNodeData> = {
  type: CANVAS_NODE_TYPES.jsonCard,
  menuLabelKey: 'node.menu.jsonCard',
  menuIcon: 'text',
  visibleInMenu: true,
  defaultSize: {
    width: 760,
    height: 420,
  },
  capabilities: {
    toolbar: true,
    selectionToolbar: 'deleteOnly',
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.jsonCard],
    rawContent: '',
    parsedJson: null,
    parseError: null,
    displayFields: [],
    isStreaming: false,
    isGenerating: false,
    generationStartedAt: null,
    generationElapsedMs: null,
    sourceAiNodeId: null,
    sourceAgentId: null,
  }),
};

const storyboardSplitDefinition: CanvasNodeDefinition<StoryboardSplitNodeData> = {
  type: CANVAS_NODE_TYPES.storyboardSplit,
  menuLabelKey: 'node.menu.storyboard',
  menuIcon: 'layout',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.storyboardSplit],
    aspectRatio: DEFAULT_ASPECT_RATIO,
    frameAspectRatio: DEFAULT_ASPECT_RATIO,
    gridRows: 2,
    gridCols: 2,
    frames: [],
    exportOptions: {
      showFrameIndex: false,
      showFrameNote: false,
      notePlacement: 'overlay',
      imageFit: 'cover',
      frameIndexPrefix: 'S',
      cellGap: 8,
      outerPadding: 0,
      fontSize: 4,
      backgroundColor: '#0f1115',
      textColor: '#f8fafc',
    },
  }),
};

const storyboardGenNodeDefinition: CanvasNodeDefinition<StoryboardGenNodeData> = {
  type: CANVAS_NODE_TYPES.storyboardGen,
  menuLabelKey: 'node.menu.storyboardGen',
  menuIcon: 'sparkles',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.storyboardGen],
    gridRows: 2,
    gridCols: 2,
    frames: [],
    ratioControlMode: 'cell',
    model: DEFAULT_IMAGE_MODEL_ID,
    size: '2K' as ImageSize,
    requestAspectRatio: AUTO_REQUEST_ASPECT_RATIO,
    extraParams: {},
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
  }),
};

const panoramaNodeDefinition: CanvasNodeDefinition<PanoramaNodeData> = {
  type: CANVAS_NODE_TYPES.panorama,
  menuLabelKey: 'node.menu.panorama',
  menuIcon: 'sparkles',
  visibleInMenu: true,
  capabilities: {
    toolbar: false,
    selectionToolbar: 'deleteOnly',
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.panorama],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: '2:1',
    sourceMode: 'text',
    sourcePrompt: '',
    sourceImageUrl: null,
    initialYaw: 0,
    initialPitch: 0,
    initialFov: 50,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
    generationJobId: null,
    generationProviderId: null,
    generationClientSessionId: null,
    generationError: null,
    generationErrorDetails: null,
    generationRetryResultUrl: null,
  }),
};

const blueprintNodeDefinition: CanvasNodeDefinition<BlueprintNodeData> = {
  type: CANVAS_NODE_TYPES.blueprint,
  menuLabelKey: 'node.menu.blueprint',
  menuIcon: 'layout',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    selectionToolbar: 'deleteOnly',
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.blueprint],
    mode: 'flat',
    backgroundImageUrl: null,
    backgroundPanoramaUrl: null,
    items: [],
    referenceImages: [],
    basePrompt: '',
    aspectRatio: '16:9',
    aspectFrame: '16:9',
    screenshotResolution: '1080p',
    camera: {
      fov: 39.6,
      lensDistance: 8,
      activePreset: 'standard',
    },
    lighting: {
      enabled: true,
      mainIntensity: 0.65,
      mainYaw: 35,
      mainPitch: 50,
      mainColor: '#ffffff',
      ambientIntensity: 0.55,
      ambientColor: '#ffffff',
    },
    grid: {
      visible: true,
      height: 0,
    },
    viewSettings: {
      wheelZoomEnabled: true,
      reverseWheelZoom: false,
      showAdvancedPedestrianTags: false,
    },
    directorStudioShortcuts: {},
    snapshotUrl: null,
    snapshotHistory: [],
    directorStudioProjects: [],
    activeDirectorStudioProjectId: null,
  }),
};

export const canvasNodeDefinitions: Record<CanvasNodeType, CanvasNodeDefinition> = {
  [CANVAS_NODE_TYPES.upload]: uploadNodeDefinition,
  [CANVAS_NODE_TYPES.imageEdit]: imageEditNodeDefinition,
  [CANVAS_NODE_TYPES.aiVideo]: aiVideoNodeDefinition,
  [CANVAS_NODE_TYPES.aiText]: aiTextNodeDefinition,
  [CANVAS_NODE_TYPES.aiAudio]: aiAudioNodeDefinition,
  [CANVAS_NODE_TYPES.exportImage]: exportImageNodeDefinition,
  [CANVAS_NODE_TYPES.video]: videoNodeDefinition,
  [CANVAS_NODE_TYPES.audio]: audioNodeDefinition,
  [CANVAS_NODE_TYPES.textAnnotation]: textAnnotationNodeDefinition,
  [CANVAS_NODE_TYPES.jsonCard]: jsonCardNodeDefinition,
  [CANVAS_NODE_TYPES.group]: groupNodeDefinition,
  [CANVAS_NODE_TYPES.storyboardSplit]: storyboardSplitDefinition,
  [CANVAS_NODE_TYPES.storyboardGen]: storyboardGenNodeDefinition,
  [CANVAS_NODE_TYPES.panorama]: panoramaNodeDefinition,
  [CANVAS_NODE_TYPES.blueprint]: blueprintNodeDefinition,
};

export function getNodeDefinition(type: CanvasNodeType): CanvasNodeDefinition {
  return canvasNodeDefinitions[type];
}

export function getMenuNodeDefinitions(): CanvasNodeDefinition[] {
  return Object.values(canvasNodeDefinitions).filter((definition) => definition.visibleInMenu);
}

export function getNodeSelectionToolbarMode(type: CanvasNodeType): CanvasNodeSelectionToolbarMode {
  const capabilities = canvasNodeDefinitions[type].capabilities;
  return capabilities.selectionToolbar ?? (capabilities.toolbar ? 'full' : 'none');
}

export function nodeHasSourceHandle(type: CanvasNodeType): boolean {
  return canvasNodeDefinitions[type].connectivity.sourceHandle;
}

export function nodeHasTargetHandle(type: CanvasNodeType): boolean {
  return canvasNodeDefinitions[type].connectivity.targetHandle;
}

export function getConnectMenuNodeTypes(handleType: 'source' | 'target'): CanvasNodeType[] {
  const fromSource = handleType === 'source';
  return Object.values(canvasNodeDefinitions)
    .filter((definition) => (fromSource
      ? definition.connectivity.connectMenu.fromSource
      : definition.connectivity.connectMenu.fromTarget))
    .filter((definition) => (fromSource
      ? definition.connectivity.targetHandle
      : definition.connectivity.sourceHandle))
    .map((definition) => definition.type);
}
