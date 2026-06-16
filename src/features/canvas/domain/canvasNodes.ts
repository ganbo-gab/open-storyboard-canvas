import type { Edge, Node, XYPosition } from '@xyflow/react';

export const CANVAS_NODE_TYPES = {
  upload: 'uploadNode',
  imageEdit: 'imageNode',
  aiVideo: 'aiVideoNode',
  aiText: 'aiTextNode',
  aiAudio: 'aiAudioNode',
  exportImage: 'exportImageNode',
  video: 'videoNode',
  audio: 'audioNode',
  textAnnotation: 'textAnnotationNode',
  jsonCard: 'jsonCardNode',
  group: 'groupNode',
  storyboardSplit: 'storyboardNode',
  storyboardGen: 'storyboardGenNode',
  panorama: 'panoramaNode',
  blueprint: 'blueprintNode',
} as const;

export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[keyof typeof CANVAS_NODE_TYPES];

export const DEFAULT_ASPECT_RATIO = '1:1';
export const AUTO_REQUEST_ASPECT_RATIO = 'auto';
export const DEFAULT_NODE_WIDTH = 220;
export const EXPORT_RESULT_NODE_DEFAULT_WIDTH = 384;
export const EXPORT_RESULT_NODE_LAYOUT_HEIGHT = 288;
export const EXPORT_RESULT_NODE_MIN_WIDTH = 168;
export const EXPORT_RESULT_NODE_MIN_HEIGHT = 168;

export const IMAGE_SIZES = ['0.5K', '1K', '2K', '4K'] as const;
export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '21:9',
] as const;

export type ImageSize = (typeof IMAGE_SIZES)[number];

export interface NodeDisplayData {
  displayName?: string;
  [key: string]: unknown;
}

export interface NodeImageData extends NodeDisplayData {
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  isSizeManuallyAdjusted?: boolean;
  [key: string]: unknown;
}

export interface UploadImageNodeData extends NodeImageData {
  sourceFileName?: string | null;
}

export type ExportImageNodeResultKind =
  | 'generic'
  | 'storyboardGenOutput'
  | 'storyboardSplitExport'
  | 'storyboardFrameEdit';

export interface ExportImageNodeData extends NodeImageData {
  resultKind?: ExportImageNodeResultKind;
  generatedFileName?: string | null;
  generatedNamingMode?: 'default' | 'custom';
  generatedSequence?: number | null;
  generatedDateStamp?: string | null;
  sourcePrompt?: string;
  batchId?: string;
  batchIndex?: number;
  batchTotal?: number;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  generationElapsedMs?: number | null;
  generationJobId?: string | null;
  generationProviderId?: string | null;
  generationClientSessionId?: string | null;
  generationError?: string | null;
  generationErrorDetails?: string | null;
  generationDebugContext?: unknown;
  generationRetryResultUrl?: string | null;
}

export interface GroupNodeData extends NodeDisplayData {
  label: string;
  [key: string]: unknown;
}

export interface TextAnnotationNodeData extends NodeDisplayData {
  content: string;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationElapsedMs?: number | null;
  sourceAiNodeId?: string | null;
  sourceAgentId?: string | null;
  [key: string]: unknown;
}

export interface JsonCardDisplayField {
  path: string;
  label: string;
  value: string;
}

export interface JsonCardNodeData extends NodeDisplayData {
  rawContent: string;
  parsedJson: unknown | null;
  parseError?: string | null;
  displayFields?: JsonCardDisplayField[];
  structuredColumnWidths?: Record<string, number>;
  isStreaming?: boolean;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationElapsedMs?: number | null;
  sourceAiNodeId?: string | null;
  sourceAgentId?: string | null;
  [key: string]: unknown;
}

export interface ImageEditNodeData extends NodeImageData {
  prompt: string;
  model: string;
  size: ImageSize;
  requestAspectRatio?: string;
  modelConfig?: {
    entryId: string;
    ratio: string;
    extraParams?: Record<string, unknown>;
  };
  extraParams?: Record<string, unknown>;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  generationJobId?: string;
  batchId?: string;
  batchIndex?: number;
  batchTotal?: number;
  cameraControl?: CameraControlOptions;
  /** Case B (empty AI image node) shows multi-function sub-items directly as
   *  toolbar chips. At most one is selected at a time; the chip's prompt
   *  template is prepended to the user prompt on submit. Null/undefined = no
   *  module selected (normal text-to-image path). */
  selectedFunctionChip?: string | null;
  /** Optional settings prompt preset selected from the node toolbar. Mutually
   *  exclusive with selectedFunctionChip and resolved by id at submit time. */
  selectedPromptPresetId?: string | null;
}

export interface AiVideoNodeData extends NodeDisplayData {
  prompt: string;
  modelConfig?: {
    entryId: string;
    duration: string;
    resolution: string;
    aspectRatio?: string;
    extraParams?: Record<string, unknown>;
  };
  extraParams?: Record<string, unknown>;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  generationJobId?: string;
  cameraControl?: CameraControlOptions;
  selectedPromptPresetId?: string | null;
}

export interface AiTextNodeData extends NodeDisplayData {
  prompt: string;
  providerId?: string | null;
  model: string;
  agentId?: string | null;
  isToolbarCollapsed?: boolean;
  resultNodeId?: string | null;
  lastRunInputHash?: string | null;
  lastPreparedPayload?: unknown;
  lastOutputType?: 'markdown' | 'json' | null;
  lastError?: string | null;
  [key: string]: unknown;
}

export interface AiAudioNodeData extends NodeDisplayData {
  prompt: string;
  modelId?: string | null;
  voiceId?: string | null;
  controlInstruction?: string | null;
  usePromptText?: boolean | null;
  promptTextValue?: string | null;
  audioGenerationParams?: Record<string, unknown>;
  resultNodeId?: string | null;
  lastRunInputHash?: string | null;
  lastError?: string | null;
  [key: string]: unknown;
}

export interface VideoNodeData extends NodeDisplayData {
  videoUrl: string | null;
  localVideoUrl?: string | null;
  thumbnailUrl?: string | null;
  generatedFileName?: string | null;
  generatedNamingMode?: 'default' | 'custom';
  generatedSequence?: number | null;
  generatedDateStamp?: string | null;
  aspectRatio: string;
  durationSeconds?: number | null;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  generationElapsedMs?: number | null;
  generationJobId?: string | null;
  generationProviderId?: string | null;
  generationClientSessionId?: string | null;
  generationError?: string | null;
  generationErrorDetails?: string | null;
  generationDebugContext?: unknown;
  generationRetryResultUrl?: string | null;
  generationRetryRequestedAt?: number | null;
  sourcePrompt?: string;
  sourceReferenceCount?: number;
  [key: string]: unknown;
}

export interface AudioNodeData extends NodeDisplayData {
  audioUrl: string | null;
  localAudioUrl?: string | null;
  sourceFileName?: string | null;
  durationSeconds?: number | null;
  isAudioTrimMode?: boolean | null;
  audioTrimStartSeconds?: number | null;
  audioTrimEndSeconds?: number | null;
  generatedFileName?: string | null;
  generatedNamingMode?: 'default' | 'custom';
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  generationElapsedMs?: number | null;
  generationError?: string | null;
  generationErrorDetails?: string | null;
  sourcePrompt?: string;
  sourceTextLength?: number;
  sourceVoiceId?: string | null;
  sourceModelId?: string | null;
  sourceControlInstruction?: string | null;
  sourcePromptTextValue?: string | null;
  sourceAudioMode?: string | null;
  sourceReferenceCount?: number;
  sourceReferenceAudioId?: string | null;
  sourceReferenceAudioTitle?: string | null;
  [key: string]: unknown;
}

export interface CameraControlOptions {
  enabled: boolean;
  camera: string;
  lens: string;
  focalLength: number;
  aperture: number;
}

export interface StoryboardFrameItem {
  id: string;
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio?: string;
  note: string;
  order: number;
}

export interface StoryboardExportOptions {
  showFrameIndex: boolean;
  showFrameNote: boolean;
  notePlacement: 'overlay' | 'bottom';
  imageFit: 'cover' | 'contain';
  frameIndexPrefix: string;
  cellGap: number;
  outerPadding: number;
  fontSize: number;
  backgroundColor: string;
  textColor: string;
}

export interface StoryboardSplitNodeData {
  displayName?: string;
  aspectRatio: string;
  frameAspectRatio?: string;
  gridRows: number;
  gridCols: number;
  frames: StoryboardFrameItem[];
  exportOptions?: StoryboardExportOptions;
  [key: string]: unknown;
}

export interface StoryboardGenFrameItem {
  id: string;
  description: string;
  referenceIndex: number | null;
}

export type StoryboardRatioControlMode = 'overall' | 'cell';

export interface StoryboardGenNodeData {
  displayName?: string;
  gridRows: number;
  gridCols: number;
  frames: StoryboardGenFrameItem[];
  ratioControlMode?: StoryboardRatioControlMode;
  model: string;
  size: ImageSize;
  requestAspectRatio: string;
  modelConfig?: {
    entryId: string;
    ratio: string;
    extraParams?: Record<string, unknown>;
  };
  extraParams?: Record<string, unknown>;
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  [key: string]: unknown;
}

export type PanoramaSourceMode = 'text' | 'image';
export type PanoramaProjection = 'spherical' | 'cylindrical';

export interface PanoramaNodeData extends NodeDisplayData {
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  sourceMode: PanoramaSourceMode;
  sourcePrompt: string;
  sourceImageUrl?: string | null;
  projection?: PanoramaProjection;
  initialYaw?: number;
  initialPitch?: number;
  initialFov?: number;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  generationJobId?: string | null;
  generationProviderId?: string | null;
  generationClientSessionId?: string | null;
  generationError?: string | null;
  generationErrorDetails?: string | null;
  generationDebugContext?: unknown;
  generationRetryResultUrl?: string | null;
  [key: string]: unknown;
}

export interface BlueprintItem {
  id: string;
  label: string;
  x: number;
  y: number;
  color: string;
  showLabel?: boolean;
  refImageUrl?: string | null;
  refImageName?: string | null;
  note?: string;
  // Optional 3D position in world units (meters). If present, the 3D editor uses
  // these as the source of truth; legacy x/y are kept for back-compat rendering.
  pos3d?: { x: number; y: number; z: number };
  // Optional whole-item transform in radians / scalar multipliers. Missing values
  // default to zero rotation and unit scale so older projects render unchanged.
  rotation3d?: { x: number; y: number; z: number };
  scale3d?: { x: number; y: number; z: number };
  // Category (人/事物/场景) decides how the 3D editor renders the item and how
  // the submit prompt describes it. `scene` items are environment/set elements
  // and can still render as procedural placeholders in the Director Studio.
  category?: 'person' | 'object' | 'scene';
  /** Optional built-in preset id (man / woman / box / table / ...). When set,
   *  the 3D editor renders a detailed SVG sprite instead of the generic
   *  capsule/box. See `ui/blueprintPresets.ts` for the registry. */
  presetId?: string;
  // Freeform text capturing the relation to other items (@image tokens allowed).
  relation?: string;
  // Optional pose/action instruction for person items.
  action?: string;
  // Director Studio-only marker for procedurally generated background people.
  // Labels can be renamed, so this keeps advanced pedestrian ID tags stable.
  directorStudioRole?: 'pedestrian';
  directorStudioNumber?: number;
  // Optional per-person body controls authored in Director Studio. Missing
  // fields default to the preset's procedural body proportions.
  bodyControls?: BlueprintBodyControls;
}

export type BlueprintBodyStyle = 'preset' | 'slim' | 'strong' | 'heavy' | 'childlike';

export interface BlueprintBodyControls {
  style?: BlueprintBodyStyle;
  showControls?: boolean;
  core?: {
    height?: number;
    torsoWidth?: number;
    headScale?: number;
    torsoLeanDeg?: number;
  };
  arms?: {
    length?: number;
    thickness?: number;
    spreadDeg?: number;
  };
  legs?: {
    length?: number;
    thickness?: number;
    spreadDeg?: number;
  };
}

export interface BlueprintReferenceImageItem {
  id: string;
  url: string;
  label: string;
  color?: string;
}

/**
 * Per-bone rotation (radians) used by custom person-action poses. Every
 * field is optional and missing axes default to 0. Composed with the
 * keyword-driven preset mapping in `blueprintMeshFactory`'s
 * `applyPersonActionTransform` — when an item's `action` matches a custom
 * pose name in `BlueprintNodeData.customActionPoses`, that pose's bone
 * rotations override the keyword mapping for the same name.
 */
export interface BlueprintActionPose {
  leftShoulder?: { x?: number; y?: number; z?: number };
  rightShoulder?: { x?: number; y?: number; z?: number };
  leftElbow?: { x?: number };
  rightElbow?: { x?: number };
  leftHip?: { x?: number; y?: number; z?: number };
  rightHip?: { x?: number; y?: number; z?: number };
  leftKnee?: { x?: number };
  rightKnee?: { x?: number };
  head?: { x?: number; y?: number; z?: number };
  torso?: { x?: number };
  /** Whole-figure scale Y (lets squats / stretches survive even custom poses). */
  scaleY?: number;
  /** Vertical offset on the whole figure (sit / jump / lie). */
  groupY?: number;
  /** Whole-figure X rotation in radians (lie poses). */
  groupRotX?: number;
}

export interface DirectorStudioCameraSettings {
  fov: number;
  lensDistance: number;
  activePreset?: string | null;
}

export interface DirectorStudioLightingSettings {
  enabled: boolean;
  mainIntensity: number;
  mainYaw: number;
  mainPitch: number;
  mainColor: string;
  ambientIntensity: number;
  ambientColor: string;
}

export interface DirectorStudioGridSettings {
  visible: boolean;
  height: number;
}

export interface DirectorStudioViewSettings {
  wheelZoomEnabled: boolean;
  reverseWheelZoom: boolean;
  showAdvancedPedestrianTags: boolean;
}

export type DirectorStudioTransformMode = 'move' | 'rotate' | 'scale';

export type DirectorStudioShortcutId =
  | 'transformMove'
  | 'transformRotate'
  | 'transformScale'
  | 'focus'
  | 'fit'
  | 'reset'
  | 'screenshot'
  | 'model'
  | 'lighting'
  | 'grid'
  | 'prompt'
  | 'shortcuts'
  | 'save'
  | 'delete'
  | 'copy'
  | 'paste'
  | 'undo'
  | 'redo'
  | 'advancedPedestrianTags';

export type DirectorStudioShortcutBindings = Partial<Record<DirectorStudioShortcutId, string>>;

export type DirectorStudioAspectFrame =
  | 'panorama'
  | '1:1'
  | '4:3'
  | '3:4'
  | '16:9'
  | '9:16'
  | '3:2'
  | '2:3'
  | '21:9';

export type DirectorStudioScreenshotResolution = '1080p' | '1440p' | '4k';

export interface DirectorStudioProjectSnapshot {
  mode: 'flat' | 'panorama';
  backgroundImageUrl?: string | null;
  backgroundPanoramaUrl?: string | null;
  items: BlueprintItem[];
  referenceImages: BlueprintReferenceImageItem[];
  customActionPresets?: string[];
  customActionPoses?: Record<string, BlueprintActionPose>;
  basePrompt?: string;
  aspectRatio: string;
  camera?: DirectorStudioCameraSettings;
  lighting?: DirectorStudioLightingSettings;
  grid?: DirectorStudioGridSettings;
  viewSettings?: DirectorStudioViewSettings;
  directorStudioShortcuts?: DirectorStudioShortcutBindings;
  aspectFrame?: DirectorStudioAspectFrame;
  screenshotResolution?: DirectorStudioScreenshotResolution;
  themeColor?: string;
  snapshotUrl?: string | null;
  snapshotHistory?: string[];
}

export interface DirectorStudioProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  coverUrl?: string | null;
  snapshot: DirectorStudioProjectSnapshot;
}

export interface BlueprintNodeData extends NodeDisplayData {
  mode: 'flat' | 'panorama';
  backgroundImageUrl?: string | null;
  backgroundPanoramaUrl?: string | null;
  items: BlueprintItem[];
  referenceImages: BlueprintReferenceImageItem[];
  customActionPresets?: string[];
  /** Map of custom action name → bone-rotation pose authored in the
   *  blueprint custom action modal. Only entries created by the user via
   *  the pose editor live here; built-in keyword poses stay in code. */
  customActionPoses?: Record<string, BlueprintActionPose>;
  basePrompt?: string;
  aspectRatio: string;
  camera?: DirectorStudioCameraSettings;
  lighting?: DirectorStudioLightingSettings;
  grid?: DirectorStudioGridSettings;
  viewSettings?: DirectorStudioViewSettings;
  directorStudioShortcuts?: DirectorStudioShortcutBindings;
  aspectFrame?: DirectorStudioAspectFrame;
  screenshotResolution?: DirectorStudioScreenshotResolution;
  themeColor?: string;
  /** PNG dataURL of the latest user-triggered 3D snapshot, used as a reference
   *  image at generation submit time. */
  snapshotUrl?: string | null;
  /** Recent Director Studio screenshots, stored oldest to newest. */
  snapshotHistory?: string[];
  directorStudioProjects?: DirectorStudioProjectRecord[];
  activeDirectorStudioProjectId?: string | null;
  /** One-shot UI flag used by Director Studio shortcuts. Cleared after the
   *  fullscreen shell opens so saved projects do not auto-open on reload. */
  openDirectorStudioOnCreate?: boolean;
  [key: string]: unknown;
}

export type CanvasNodeData =
  | UploadImageNodeData
  | ExportImageNodeData
  | VideoNodeData
  | AudioNodeData
  | TextAnnotationNodeData
  | JsonCardNodeData
  | GroupNodeData
  | ImageEditNodeData
  | AiVideoNodeData
  | AiTextNodeData
  | AiAudioNodeData
  | StoryboardSplitNodeData
  | StoryboardGenNodeData
  | PanoramaNodeData
  | BlueprintNodeData;

export type CanvasNode = Node<CanvasNodeData, CanvasNodeType>;
export type CanvasEdge = Edge;

export interface NodeCreationDto {
  type: CanvasNodeType;
  position: XYPosition;
  data?: Partial<CanvasNodeData>;
}

export interface StoryboardNodeCreationDto {
  position: XYPosition;
  rows: number;
  cols: number;
  frames: StoryboardFrameItem[];
}

export const NODE_TOOL_TYPES = {
  crop: 'crop',
  annotate: 'annotate',
  splitStoryboard: 'split-storyboard',
  // Edit-family tools — these open a NodeToolDialog with a mask/form editor
  // and submit via the AI gateway. The current build registers them as
  // 'confirm'-kind plugins that copy the active node's image + prompt; mask
  // brushwork for inpaint/erase is a follow-up.
  hd: 'hd',
  outpainting: 'outpainting',
  inpainting: 'inpainting',
  erase: 'erase',
  matting: 'matting',
} as const;

export type NodeToolType = (typeof NODE_TOOL_TYPES)[keyof typeof NODE_TOOL_TYPES];

export interface ActiveToolDialog {
  nodeId: string;
  toolType: NodeToolType;
  /** Optional overrides for the tool's initial options. Used by GridSplitPanel
   *  to pass the user's selected rows/cols so the split dialog opens with
   *  the chosen grid size instead of the tool plugin's default (3x3). */
  initialOptionsOverride?: Record<string, unknown>;
}

export function isUploadNode(
  node: CanvasNode | null | undefined
): node is Node<UploadImageNodeData, typeof CANVAS_NODE_TYPES.upload> {
  return node?.type === CANVAS_NODE_TYPES.upload;
}

export function isImageEditNode(
  node: CanvasNode | null | undefined
): node is Node<ImageEditNodeData, typeof CANVAS_NODE_TYPES.imageEdit> {
  return node?.type === CANVAS_NODE_TYPES.imageEdit;
}

export function isAiVideoNode(
  node: CanvasNode | null | undefined
): node is Node<AiVideoNodeData, typeof CANVAS_NODE_TYPES.aiVideo> {
  return node?.type === CANVAS_NODE_TYPES.aiVideo;
}

export function isAiTextNode(
  node: CanvasNode | null | undefined
): node is Node<AiTextNodeData, typeof CANVAS_NODE_TYPES.aiText> {
  return node?.type === CANVAS_NODE_TYPES.aiText;
}

export function isAiAudioNode(
  node: CanvasNode | null | undefined
): node is Node<AiAudioNodeData, typeof CANVAS_NODE_TYPES.aiAudio> {
  return node?.type === CANVAS_NODE_TYPES.aiAudio;
}

export function isExportImageNode(
  node: CanvasNode | null | undefined
): node is Node<ExportImageNodeData, typeof CANVAS_NODE_TYPES.exportImage> {
  return node?.type === CANVAS_NODE_TYPES.exportImage;
}

export function isVideoNode(
  node: CanvasNode | null | undefined
): node is Node<VideoNodeData, typeof CANVAS_NODE_TYPES.video> {
  return node?.type === CANVAS_NODE_TYPES.video;
}

export function isAudioNode(
  node: CanvasNode | null | undefined
): node is Node<AudioNodeData, typeof CANVAS_NODE_TYPES.audio> {
  return node?.type === CANVAS_NODE_TYPES.audio;
}

export function isGroupNode(
  node: CanvasNode | null | undefined
): node is Node<GroupNodeData, typeof CANVAS_NODE_TYPES.group> {
  return node?.type === CANVAS_NODE_TYPES.group;
}

export function isTextAnnotationNode(
  node: CanvasNode | null | undefined
): node is Node<TextAnnotationNodeData, typeof CANVAS_NODE_TYPES.textAnnotation> {
  return node?.type === CANVAS_NODE_TYPES.textAnnotation;
}

export function isJsonCardNode(
  node: CanvasNode | null | undefined
): node is Node<JsonCardNodeData, typeof CANVAS_NODE_TYPES.jsonCard> {
  return node?.type === CANVAS_NODE_TYPES.jsonCard;
}

export function isStoryboardSplitNode(
  node: CanvasNode | null | undefined
): node is Node<StoryboardSplitNodeData, typeof CANVAS_NODE_TYPES.storyboardSplit> {
  return node?.type === CANVAS_NODE_TYPES.storyboardSplit;
}

export function isStoryboardGenNode(
  node: CanvasNode | null | undefined
): node is Node<StoryboardGenNodeData, typeof CANVAS_NODE_TYPES.storyboardGen> {
  return node?.type === CANVAS_NODE_TYPES.storyboardGen;
}

export function isPanoramaNode(
  node: CanvasNode | null | undefined
): node is Node<PanoramaNodeData, typeof CANVAS_NODE_TYPES.panorama> {
  return node?.type === CANVAS_NODE_TYPES.panorama;
}

export function isBlueprintNode(
  node: CanvasNode | null | undefined
): node is Node<BlueprintNodeData, typeof CANVAS_NODE_TYPES.blueprint> {
  return node?.type === CANVAS_NODE_TYPES.blueprint;
}

export function nodeHasImage(node: CanvasNode | null | undefined): boolean {
  if (!node) {
    return false;
  }

  if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
    return Boolean(node.data.imageUrl);
  }

  if (isStoryboardSplitNode(node)) {
    return node.data.frames.some((frame) => Boolean(frame.imageUrl));
  }

  if (isStoryboardGenNode(node)) {
    return Boolean(node.data.imageUrl);
  }

  return false;
}
