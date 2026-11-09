import type { Edge, Node, XYPosition } from '@xyflow/react';
import type { DepthRelief } from '@/features/stage/domain/depthRelief';
import type { ProjectMediaReference } from './projectMedia';

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
  tag: 'tagNode',
  tagGroup: 'tagGroupNode',
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

export type CanvasGenerationJobState =
  | 'queued'
  | 'submitting'
  | 'running'
  | 'recoverable_wait'
  | 'materializing'
  | 'succeeded'
  | 'failed'
  | 'not_found'
  | 'unknown'
  | 'canceled';

export interface NodeDisplayData {
  displayName?: string;
  /** Missing means enabled; disabled nodes never submit generation or toolbox work. */
  enabled?: boolean;
  /** Sibling result stack; hidden members remain in the canonical graph. */
  batchPrimary?: boolean;
  batchCollapsed?: boolean;
  assetId?: string;
  /** Stable per-field asset ids; missing entries preserve the original URL and recovery reason. */
  mediaReferences?: Record<string, ProjectMediaReference>;
  [key: string]: unknown;
}

export interface NodeImageData extends NodeDisplayData {
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  /** Non-fatal provider diagnostic kept alongside a successful image result. */
  generationWarning?: string | null;
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

/**
 * The submit was rejected before any upstream call because a reference slot needs a public URL.
 * Drives the explicit "host and retry" action on the failed result node.
 */
export interface GenerationReferenceFailure {
  sourceNodeId: string;
  slotKey: string;
  /** Missing when the thrown error did not carry it; such failures offer no upload. */
  slotKind?: 'image' | 'video' | 'audio';
}

/** Structural read of a node's `generationReferenceFailure`; persisted data is untrusted. */
export function readGenerationReferenceFailure(data: unknown): GenerationReferenceFailure | null {
  if (!data || typeof data !== 'object' || !('generationReferenceFailure' in data)) return null;
  const value = data.generationReferenceFailure;
  if (!value || typeof value !== 'object' || !('sourceNodeId' in value) || typeof value.sourceNodeId !== 'string' || !('slotKey' in value) || typeof value.slotKey !== 'string') return null;
  const slotKind = 'slotKind' in value && (value.slotKind === 'image' || value.slotKind === 'video' || value.slotKind === 'audio') ? value.slotKind : undefined;
  return { sourceNodeId: value.sourceNodeId, slotKey: value.slotKey, ...(slotKind ? { slotKind } : {}) };
}

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
  generationLastJobId?: string | null;
  generationJobState?: CanvasGenerationJobState;
  generationJobPhase?: string | null;
  generationNetworkRoute?: 'system' | 'direct' | 'custom-proxy' | null;
  generationSafeRecoveryAvailable?: boolean;
  generationJobUpdatedAt?: number | null;
  generationProviderId?: string | null;
  generationClientSessionId?: string | null;
  generationError?: string | null;
  generationErrorDetails?: string | null;
  generationReferenceFailure?: GenerationReferenceFailure | null;
  generationDebugContext?: unknown;
  generationRetryResultUrl?: string | null;
}

export interface GroupNodeData extends NodeDisplayData {
  label: string;
  [key: string]: unknown;
}

export const TAG_COLORS = ['neutral', 'amber', 'cyan', 'violet', 'rose'] as const;
export type TagColor = (typeof TAG_COLORS)[number];
export const TAG_GROUP_SHAPES = ['rectangle', 'rounded', 'frame'] as const;
export type TagGroupShape = (typeof TAG_GROUP_SHAPES)[number];
export type TagGroupMemberKind = 'image' | 'video' | 'text';

export interface TagNodeData extends NodeDisplayData {
  label: string;
  enabled: boolean;
  color: TagColor;
  [key: string]: unknown;
}

export interface TagGroupNodeData extends NodeDisplayData {
  schemaVersion: 2;
  label: string;
  enabled: boolean;
  color: TagColor;
  shape: TagGroupShape;
  memberNodeIds: string[];
  /** Legacy ids that could not be resolved deterministically at load time. */
  unresolvedMemberIds?: string[];
  /** Compatibility link for legacy tag-mediated groups. */
  legacyMemberTagIds?: string[];
  /** Read-only compatibility field; V2 writers must use memberNodeIds. */
  memberTagIds?: string[];
  [key: string]: unknown;
}

const TAG_GROUP_IMAGE_MEMBER_TYPES = new Set<CanvasNodeType>([
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.exportImage,
  CANVAS_NODE_TYPES.storyboardSplit,
  CANVAS_NODE_TYPES.storyboardGen,
  CANVAS_NODE_TYPES.panorama,
]);

const TAG_GROUP_VIDEO_MEMBER_TYPES = new Set<CanvasNodeType>([
  CANVAS_NODE_TYPES.video,
]);

const TAG_GROUP_TEXT_MEMBER_TYPES = new Set<CanvasNodeType>([
  CANVAS_NODE_TYPES.aiText,
  CANVAS_NODE_TYPES.textAnnotation,
  CANVAS_NODE_TYPES.jsonCard,
]);

export function getTagGroupMemberKind(type: CanvasNodeType): TagGroupMemberKind | null {
  if (TAG_GROUP_IMAGE_MEMBER_TYPES.has(type)) return 'image';
  if (TAG_GROUP_VIDEO_MEMBER_TYPES.has(type)) return 'video';
  if (TAG_GROUP_TEXT_MEMBER_TYPES.has(type)) return 'text';
  return null;
}

export function isEligibleTagGroupMember(node: CanvasNode | null | undefined): boolean {
  return Boolean(node && getTagGroupMemberKind(node.type));
}

export function isTagGroupShape(value: unknown): value is TagGroupShape {
  return typeof value === 'string' && (TAG_GROUP_SHAPES as readonly string[]).includes(value);
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
  generationFinishReason?: string | null;
  generationWarning?: string | null;
  streamPreview?: string | null;
  streamReceivedCharacters?: number | null;
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
  /** Legacy selection only. New generators use modelConfig; absence means no legacy selection. */
  model?: string;
  size?: ImageSize;
  requestAspectRatio?: string;
  channelModeId?: string;
  referenceSlots?: Record<string, string[]>;
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
  channelModeId?: string;
  referenceSlots?: Record<string, string[]>;
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
  lastPayloadDiagnostics?: unknown;
  lastOutputType?: 'markdown' | 'json' | null;
  lastError?: string | null;
  [key: string]: unknown;
}

export interface AiAudioNodeData extends NodeDisplayData {
  prompt: string;
  modelId?: string | null;
  channelModeId?: string;
  referenceSlots?: Record<string, string[]>;
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
  sourceFileName?: string | null;
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
  generationLastJobId?: string | null;
  generationJobState?: CanvasGenerationJobState;
  generationJobPhase?: string | null;
  generationNetworkRoute?: 'system' | 'direct' | 'custom-proxy' | null;
  generationSafeRecoveryAvailable?: boolean;
  generationJobUpdatedAt?: number | null;
  generationProviderId?: string | null;
  generationClientSessionId?: string | null;
  generationError?: string | null;
  generationErrorDetails?: string | null;
  generationReferenceFailure?: GenerationReferenceFailure | null;
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
  generationReferenceFailure?: GenerationReferenceFailure | null;
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
  sourceNodeId?: string;
  sourceAssetId?: string;
  sourceMetadata?: {
    displayName?: string;
    sourceFileName?: string;
    modelId?: string;
    providerId?: string;
    requestModel?: string;
    resolution?: string;
    width?: number;
    height?: number;
    generationJobId?: string;
  };
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
  /** Legacy boards may still carry `referenceIndex`; references live in `description` as `@图N`. */
}

/** Frames in grid order, padded with empty shots or trimmed to `count`. */
export function fitStoryboardFrames(frames: readonly StoryboardGenFrameItem[], count: number): StoryboardGenFrameItem[] {
  return Array.from({ length: count }, (_, index) => frames[index] ?? {
    id: `frame-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    description: '',
  });
}

export type StoryboardRatioControlMode = 'overall' | 'cell';

export interface StoryboardGenNodeData {
  displayName?: string;
  gridRows: number;
  gridCols: number;
  frames: StoryboardGenFrameItem[];
  ratioControlMode?: StoryboardRatioControlMode;
  /** Legacy selection, absent on newly created generators. */
  model?: string;
  size?: ImageSize;
  requestAspectRatio: string;
  channelModeId?: string;
  referenceSlots?: Record<string, string[]>;
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
  smartBase?: boolean;
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
  generationReferenceFailure?: GenerationReferenceFailure | null;
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
  /** Missing in legacy projects means visible. Renderer integration is separate. */
  hidden?: boolean;
  /** Missing means editable; application mutations require an explicit unlock. */
  locked?: boolean;
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
  /** Persistent My Models asset; takes precedence over the built-in preset mesh. */
  importedModelId?: string;
  /** Image-driven 2.5D backdrop; valid only for category 'scene'. */
  relief?: DepthRelief;
  // Freeform text capturing the relation to other items (@image tokens allowed).
  relation?: string;
  // Optional pose/action label for person items: a built-in pose id, a
  // saved custom pose name, or legacy free text such as "坐".
  action?: string;
  // Explicit joint pose authored on this person. Takes precedence over
  // `action` when rendering the static (director) pose.
  pose?: BlueprintActionPose;
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

export interface BlueprintPoseRotation {
  x?: number;
  y?: number;
  z?: number;
}

export interface BlueprintPoseHinge {
  x?: number;
}

/** Finger shape. Every value is 0..1 and interpolates linearly. */
export interface BlueprintHandPose {
  /** Curl of all fingers: 0 = flat open hand, 1 = closed fist. */
  curl?: number;
  /** Index-finger curl override (point = curl 1 + index 0). Defaults to `curl`. */
  index?: number;
  /** Thumb fold across the palm. */
  thumb?: number;
  /** Finger fan. */
  spread?: number;
}

/**
 * Person pose: joint rotations in radians on top of the natural standing
 * pose. Every field is optional and missing values are 0. Side names are
 * anatomical (the figure's own left/right; the figure faces +Z so its left
 * is +X) and limb values are mirror symmetric: the same numbers on `left*`
 * and `right*` give a symmetric pose.
 *
 * - spine / chest / neck / head: `x > 0` bends forward or looks down,
 *   `y > 0` turns toward the figure's left, `z > 0` leans toward its right.
 * - clavicle: `x > 0` shrugs up, `y > 0` rolls the shoulder forward.
 * - upperArm / thigh: `x > 0` swings forward, `z > 0` lifts sideways away
 *   from the body, `y > 0` twists inward.
 * - forearm / shin: `x > 0` bends the elbow / knee.
 * - wrist: `x > 0` bends the hand toward the palm, `z > 0` toward the thumb,
 *   `y > 0` turns the palm backward. foot: `x > 0` points the toes down,
 *   `y > 0` turns the toes inward, `z > 0` rolls the sole inward.
 *   toes: `x > 0` bends the toes up.
 * - fingers: 0..1 shape values (see `BlueprintHandPose`).
 * - Whole body: the renderer keeps the lowest body point on the floor.
 *   `groupY > 0` lifts above it (jumps); `groupRotX` pitches the body
 *   (−π/2 lies on its back, +π/2 face down); `groupRotZ` rolls it;
 *   `scaleY` squashes vertically.
 *
 * Poses saved before the anatomical rig (keys `torso`, `leftShoulder`,
 * `leftElbow`, `leftHip`, `leftKnee` and right counterparts) are converted
 * by `normalizePersonPose` in `personPose.ts`.
 */
export interface BlueprintActionPose {
  spine?: BlueprintPoseRotation;
  chest?: BlueprintPoseRotation;
  neck?: BlueprintPoseRotation;
  head?: BlueprintPoseRotation;
  leftClavicle?: BlueprintPoseRotation;
  rightClavicle?: BlueprintPoseRotation;
  leftUpperArm?: BlueprintPoseRotation;
  rightUpperArm?: BlueprintPoseRotation;
  leftForearm?: BlueprintPoseHinge;
  rightForearm?: BlueprintPoseHinge;
  leftWrist?: BlueprintPoseRotation;
  rightWrist?: BlueprintPoseRotation;
  leftFingers?: BlueprintHandPose;
  rightFingers?: BlueprintHandPose;
  leftThigh?: BlueprintPoseRotation;
  rightThigh?: BlueprintPoseRotation;
  leftShin?: BlueprintPoseHinge;
  rightShin?: BlueprintPoseHinge;
  leftFoot?: BlueprintPoseRotation;
  rightFoot?: BlueprintPoseRotation;
  leftToes?: BlueprintPoseHinge;
  rightToes?: BlueprintPoseHinge;
  scaleY?: number;
  groupY?: number;
  groupRotX?: number;
  groupRotZ?: number;
}

export interface DirectorMotionVector3 {
  x: number;
  y: number;
  z: number;
}

export type DirectorMotionEasing = 'linear' | 'smooth' | 'hold';

export interface DirectorMotionKeyframeBase {
  id: string;
  time: number;
  easing: DirectorMotionEasing;
  /** Restricted easing interval, retained when splitting an interpolated segment. */
  easingRange?: [number, number];
}

export interface DirectorCameraKeyframe extends DirectorMotionKeyframeBase {
  position: DirectorMotionVector3;
  target: DirectorMotionVector3;
  fov: number;
  trackTargetId?: string | null;
  trackTargetBodyPart?: string | null;
  /** Explicit free orientation; absent retains legacy target/track-target behavior. */
  freeRotation?: DirectorMotionVector3;
}

export interface DirectorObjectKeyframe extends DirectorMotionKeyframeBase {
  position: DirectorMotionVector3;
  rotation: DirectorMotionVector3;
  scale: DirectorMotionVector3;
  /** Person routes can blend toward their path tangent while moving. */
  orientToPath?: boolean;
}

export interface DirectorActionState {
  poseId?: string | null;
  actionId?: string | null;
  clipId?: string | null;
  /** Phase offset used when splitting an action or a nested custom clip. */
  actionOffsetSeconds?: number;
  pose?: BlueprintActionPose;
  bodyControls?: BlueprintBodyControls;
}

export interface DirectorActionKeyframe extends DirectorMotionKeyframeBase, DirectorActionState {}

export interface DirectorActionClipKeyframe extends DirectorActionState {
  id: string;
  time: number;
  easing: DirectorMotionEasing;
  easingRange?: [number, number];
}

export interface DirectorActionClip {
  id: string;
  name: string;
  durationSeconds: number;
  loop: boolean;
  keyframes: DirectorActionClipKeyframe[];
}

export type DirectorCameraRigKind = 'follow' | 'closeup';
export type DirectorCameraRigBodyPart = 'head' | 'torso' | 'feet';

/**
 * Live camera rig (spec 05 §4.5 相对跟随 / 特写跟踪). While active it drives the camera from its
 * subject's sampled motion instead of camera keyframes, so later route edits are followed automatically.
 */
export interface DirectorCameraRig {
  id: string;
  kind: DirectorCameraRigKind;
  targetId: string;
  bodyPart: DirectorCameraRigBodyPart;
  /** Absolute scene seconds. */
  start: number;
  end: number;
  /** Horizontal distance from the aim point, metres. */
  distance: number;
  /** Camera height above the aim point, metres. */
  height: number;
  /** Horizontal angle around the subject in degrees: 0 behind, 180 in front. */
  azimuthDeg: number;
  /** Aim tilt in degrees; positive looks above the aim point. */
  pitchDeg: number;
  fov: number;
  /** Camera position lag: 0 rigid … 0.95 heavy. */
  damping: number;
  /** The azimuth turns with the subject's heading (relative position) instead of staying world-fixed. */
  relative: boolean;
  /** The camera keeps its start height instead of following the subject up and down. */
  lockHorizon: boolean;
  /**
   * Explicit evaluation layer where rigs overlap (set by "bring to front"); higher wins.
   * Absent = 0; equal layers fall back to the latest start, then the later rig.
   */
  priority?: number;
}

export interface DirectorMotionProjectV1 {
  schemaVersion: 1;
  durationSeconds: number;
  loop: boolean;
  cameraTrack: DirectorCameraKeyframe[];
  objectTracks: Record<string, DirectorObjectKeyframe[]>;
  actionTracks: Record<string, DirectorActionKeyframe[]>;
  customClips: DirectorActionClip[];
  /** Live follow / close-up rigs; inside a rig's interval it overrides `cameraTrack`. */
  cameraRigs: DirectorCameraRig[];
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
  | 'selectTool'
  | 'orbitTool'
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
  | 'advancedPedestrianTags'
  | 'poseEdit';

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
  motionProject?: DirectorMotionProjectV1;
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
  /** Optional V1 Director Studio timeline. Missing means a legacy static scene. */
  motionProject?: DirectorMotionProjectV1;
  directorStudioProjects?: DirectorStudioProjectRecord[];
  activeDirectorStudioProjectId?: string | null;
  /** One-shot UI flag used by Director Studio shortcuts (`'previs'` opens straight into the
   *  timeline workspace). Cleared after the fullscreen shell opens so saved projects do not
   *  auto-open on reload. */
  openDirectorStudioOnCreate?: boolean | 'previs';
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
  | TagNodeData
  | TagGroupNodeData
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

export function isTagNode(
  node: CanvasNode | null | undefined
): node is Node<TagNodeData, typeof CANVAS_NODE_TYPES.tag> {
  return node?.type === CANVAS_NODE_TYPES.tag;
}

export function isTagGroupNode(
  node: CanvasNode | null | undefined
): node is Node<TagGroupNodeData, typeof CANVAS_NODE_TYPES.tagGroup> {
  return node?.type === CANVAS_NODE_TYPES.tagGroup;
}

export function isTagColor(value: unknown): value is TagColor {
  return typeof value === 'string' && (TAG_COLORS as readonly string[]).includes(value);
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
