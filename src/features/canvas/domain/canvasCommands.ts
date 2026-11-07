import type { XYPosition } from '@xyflow/react';
import type { MediaEditOperation } from '../application/media';

import type {
  BlueprintActionPose,
  BlueprintItem,
  CanvasEdge,
  CanvasNode,
  CanvasNodeType,
  DirectorMotionProjectV1,
  DirectorStudioAspectFrame,
  DirectorStudioCameraSettings,
  DirectorStudioGridSettings,
  DirectorStudioLightingSettings,
  DirectorStudioScreenshotResolution,
  DirectorStudioShortcutBindings,
  DirectorStudioViewSettings,
  NodeToolType,
  PanoramaProjection,
  PanoramaSourceMode,
  StoryboardExportOptions,
  TagColor,
  TagGroupShape,
} from './canvasNodes';

export const CANVAS_COMMAND_VERSION = 1 as const;

export const CANVAS_COMMAND_TYPES = [
  'canvas.query',
  'node.create',
  'node.delete',
  'node.rename',
  'node.setPrompt',
  'node.setModelConfig',
  'node.move',
  'node.layout',
  'node.setEnabled',
  'node.duplicate',
  'batch.setPrimary',
  'batch.setCollapsed',
  'batch.split',
  'node.media.edit',
  'node.tool.run',
  'storyboard.update',
  'storyboard.merge',
  'panorama.update',
  'director.update',
  'director.open',
  'director.record',
  'tag.setColor',
  'tagGroup.setMembers',
  'tagGroup.setAppearance',
  'edge.connect',
  'edge.disconnect',
  'selection.connect',
  'group.create',
  'group.ungroup',
  'selection.set',
  'viewport.focus',
  'asset.list',
  'asset.locate',
  'generation.submit',
  'generation.recover',
  'generation.status',
  'generation.locateResult',
] as const;

export type CanvasCommandType = (typeof CANVAS_COMMAND_TYPES)[number];
export type CanvasCommandEffect = 'read' | 'graph' | 'navigation' | 'generation';
export type CanvasCommandOrigin = 'ui' | 'agent' | 'system';

export interface CanvasCommandExecutionOptions {
  /** Cancels local media editing only; accepted provider work is not interrupted. */
  signal?: AbortSignal;
}

export interface CanvasCommandBase<TType extends CanvasCommandType, TInput> {
  type: TType;
  version: typeof CANVAS_COMMAND_VERSION;
  input: TInput;
}

export interface CanvasNodeCreateConfiguration {
  displayName?: string;
  /** Durable source for image/upload nodes; never a temporary blob URL. */
  imageUrl?: string;
  prompt?: string;
  content?: string;
  modelId?: string;
  providerId?: string | null;
  aspectRatio?: string;
  resolution?: string;
  duration?: string;
  extraParams?: Record<string, unknown>;
  modeId?: string;
  referenceSlots?: Record<string, string[]>;
  openDirectorStudio?: boolean;
  directorStudioMode?: 'flat' | 'panorama';
  /** Workspace the studio opens in when `openDirectorStudio` is set; default director. */
  directorStudioWorkspace?: 'director' | 'previs';
  enabled?: boolean;
  tagColor?: TagColor;
  memberNodeIds?: string[];
  tagGroupColor?: TagColor;
  tagGroupShape?: TagGroupShape;
}

export type CanvasQueryCommand = CanvasCommandBase<'canvas.query', {
  scope: 'graph' | 'nodes' | 'edges' | 'selection';
  nodeIds?: string[];
  limit?: number;
}>;

export type CreateNodeCommand = CanvasCommandBase<'node.create', {
  nodeType: CanvasNodeType;
  position: XYPosition;
  nodeId?: string;
  dimensions?: { width: number; height: number };
  configuration?: CanvasNodeCreateConfiguration;
}>;

export type DeleteNodeCommand = CanvasCommandBase<'node.delete', {
  nodeIds: string[];
}>;

export type RenameNodeCommand = CanvasCommandBase<'node.rename', {
  nodeId: string;
  displayName: string;
}>;

export type SetNodePromptCommand = CanvasCommandBase<'node.setPrompt', {
  nodeId: string;
  prompt: string;
}>;

export type SetNodeModelConfigCommand = CanvasCommandBase<'node.setModelConfig', {
  nodeId: string;
  modelId: string;
  providerId?: string | null;
  aspectRatio?: string;
  resolution?: string;
  duration?: string;
  extraParams?: Record<string, unknown>;
  modeId?: string;
  referenceSlots?: Record<string, string[]>;
}>;

export type MoveNodeCommand = CanvasCommandBase<'node.move', {
  positions: Array<{ nodeId: string; position: XYPosition }>;
}>;

export type LayoutNodeCommand = CanvasCommandBase<'node.layout', {
  nodeIds: string[];
  direction: 'horizontal' | 'vertical' | 'grid';
  origin?: XYPosition;
  gap?: number;
  columns?: number;
}>;

export type SetNodeEnabledCommand = CanvasCommandBase<'node.setEnabled', {
  nodeIds: string[];
  enabled: boolean;
}>;

export type SetBatchPrimaryCommand = CanvasCommandBase<'batch.setPrimary', { batchId: string; nodeId: string }>;
export type SetBatchCollapsedCommand = CanvasCommandBase<'batch.setCollapsed', { batchId: string; collapsed: boolean }>;
export type SplitBatchCommand = CanvasCommandBase<'batch.split', { batchId: string }>;
export type EditNodeMediaCommand = CanvasCommandBase<'node.media.edit', { nodeId: string; operation: MediaEditOperation }>;

export interface DuplicateNodeInput {
  sourceNodeId: string;
  nodeId?: string;
  position?: XYPosition;
}

export type DuplicateNodeCommand = CanvasCommandBase<'node.duplicate', {
  copies: DuplicateNodeInput[];
}>;

export type RunNodeToolCommand = CanvasCommandBase<'node.tool.run', {
  nodeId: string;
  toolType: NodeToolType;
  options?: Record<string, unknown>;
}>;

export type UpdateStoryboardCommand = CanvasCommandBase<'storyboard.update', {
  nodeId: string;
  frames?: Array<{
    frameId: string;
    note?: string;
    order?: number;
  }>;
  exportOptions?: Partial<StoryboardExportOptions>;
}>;

/** Creates a storyboard in explicit nodeIds order without removing or reparenting the sources. */
export type MergeStoryboardCommand = CanvasCommandBase<'storyboard.merge', {
  nodeIds: string[];
  nodeId?: string;
  displayName?: string;
  columns?: number;
}>;

export type UpdatePanoramaCommand = CanvasCommandBase<'panorama.update', {
  nodeId: string;
  sourceMode?: PanoramaSourceMode;
  sourceAssetId?: string | null;
  sourcePrompt?: string;
  projection?: PanoramaProjection;
  smartBase?: boolean;
  initialYaw?: number;
  initialPitch?: number;
  initialFov?: number;
}>;

export type CanvasDirectorItemInput = Omit<BlueprintItem, 'refImageUrl' | 'refImageName'> & {
  referenceAssetId?: string | null;
};

export type UpdateDirectorCommand = CanvasCommandBase<'director.update', {
  nodeId: string;
  mode?: 'flat' | 'panorama';
  basePrompt?: string;
  aspectRatio?: string;
  aspectFrame?: DirectorStudioAspectFrame;
  screenshotResolution?: DirectorStudioScreenshotResolution;
  themeColor?: string;
  backgroundAssetId?: string | null;
  backgroundPanoramaAssetId?: string | null;
  referenceAssetIds?: string[];
  items?: CanvasDirectorItemInput[];
  customActionPresets?: string[];
  customActionPoses?: Record<string, BlueprintActionPose>;
  camera?: DirectorStudioCameraSettings;
  lighting?: DirectorStudioLightingSettings;
  grid?: DirectorStudioGridSettings;
  viewSettings?: DirectorStudioViewSettings;
  shortcuts?: DirectorStudioShortcutBindings;
  motionProject?: DirectorMotionProjectV1 | null;
}>;

export type OpenDirectorCommand = CanvasCommandBase<'director.open', {
  nodeId: string;
  focus?: boolean;
}>;

export type RecordDirectorCommand = CanvasCommandBase<'director.record', {
  nodeId: string;
  resolution: '720p' | '1080p';
  fps: 24 | 30;
  addToCanvas?: boolean;
}>;

export type SetTagColorCommand = CanvasCommandBase<'tag.setColor', {
  tagId: string;
  color: TagColor;
}>;

export type SetTagGroupMembersCommand = CanvasCommandBase<'tagGroup.setMembers', {
  groupId: string;
  memberNodeIds: string[];
}>;

export type SetTagGroupAppearanceCommand = CanvasCommandBase<'tagGroup.setAppearance', {
  groupId: string;
  color?: TagColor;
  shape?: TagGroupShape;
}>;

export type ConnectEdgeCommand = CanvasCommandBase<'edge.connect', {
  sourceNodeId: string;
  targetNodeId: string;
  edgeId?: string;
}>;

export type DisconnectEdgeCommand = CanvasCommandBase<'edge.disconnect', {
  edgeIds: string[];
}>;

/** Connects every explicit source to one target, or leaves the entire graph unchanged. */
export type ConnectSelectionCommand = CanvasCommandBase<'selection.connect', {
  sourceNodeIds: string[];
  targetNodeId: string;
}>;

export type CreateGroupCommand = CanvasCommandBase<'group.create', {
  nodeIds: string[];
  groupId?: string;
  displayName?: string;
}>;

export type UngroupCommand = CanvasCommandBase<'group.ungroup', {
  groupIds: string[];
}>;

export type SetSelectionCommand = CanvasCommandBase<'selection.set', {
  nodeIds: string[];
}>;

export type FocusViewportCommand = CanvasCommandBase<'viewport.focus', {
  nodeIds: string[];
  padding?: number;
  select?: boolean;
}>;

export type ListAssetsCommand = CanvasCommandBase<'asset.list', {
  kind?: 'image' | 'video' | 'audio';
  query?: string;
  nodeIds?: string[];
  relatedToNodeIds?: string[];
  selectedOnly?: boolean;
  region?: { x: number; y: number; width: number; height: number };
  limit?: number;
}>;

export type LocateAssetCommand = CanvasCommandBase<'asset.locate', {
  assetId: string;
  select?: boolean;
}>;

export type SubmitGenerationCommand = CanvasCommandBase<'generation.submit', {
  nodeIds: string[];
}>;

export type RecoverGenerationCommand = CanvasCommandBase<'generation.recover', {
  jobId: string;
  nodeIds?: string[];
}>;

export type GetGenerationStatusCommand = CanvasCommandBase<'generation.status', {
  nodeId?: string;
  jobId?: string;
}>;

export type LocateGenerationResultCommand = CanvasCommandBase<'generation.locateResult', {
  nodeId?: string;
  jobId?: string;
  select?: boolean;
}>;

export type CanvasCommand =
  | CanvasQueryCommand
  | CreateNodeCommand
  | DeleteNodeCommand
  | RenameNodeCommand
  | SetNodePromptCommand
  | SetNodeModelConfigCommand
  | MoveNodeCommand
  | LayoutNodeCommand
  | SetNodeEnabledCommand
  | DuplicateNodeCommand
  | SetBatchPrimaryCommand
  | SetBatchCollapsedCommand
  | SplitBatchCommand
  | EditNodeMediaCommand
  | RunNodeToolCommand
  | UpdateStoryboardCommand
  | MergeStoryboardCommand
  | UpdatePanoramaCommand
  | UpdateDirectorCommand
  | OpenDirectorCommand
  | RecordDirectorCommand
  | SetTagColorCommand
  | SetTagGroupMembersCommand
  | SetTagGroupAppearanceCommand
  | ConnectEdgeCommand
  | DisconnectEdgeCommand
  | ConnectSelectionCommand
  | CreateGroupCommand
  | UngroupCommand
  | SetSelectionCommand
  | FocusViewportCommand
  | ListAssetsCommand
  | LocateAssetCommand
  | SubmitGenerationCommand
  | RecoverGenerationCommand
  | GetGenerationStatusCommand
  | LocateGenerationResultCommand;

export type CanvasCommandOfType<TType extends CanvasCommandType> = Extract<
  CanvasCommand,
  { type: TType }
>;

export interface CanvasJsonSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: readonly (string | number)[];
  properties?: Record<string, CanvasJsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  items?: CanvasJsonSchemaProperty;
  oneOf?: CanvasJsonSchemaProperty[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
}

export interface CanvasJsonSchema {
  type: 'object';
  additionalProperties: false;
  required: string[];
  properties: Record<string, CanvasJsonSchemaProperty>;
}

export interface CanvasCommandSchema {
  commandType: CanvasCommandType;
  version: typeof CANVAS_COMMAND_VERSION;
  input: CanvasJsonSchema;
}

export interface CanvasGraphSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeId: string | null;
  revision: number;
}

export interface CanvasCommandImpact {
  effect: CanvasCommandEffect;
  summary: string;
  affectedNodeIds: string[];
  affectedEdgeIds: string[];
  creates: { nodes: number; edges: number; groups: number };
  deletes: { nodes: number; edges: number; groups: number };
  requiresExternalSideEffect: boolean;
}

export interface CanvasResourceReferences {
  nodeId?: string;
  nodeIds?: string[];
  edgeId?: string;
  edgeIds?: string[];
  assetId?: string;
  assetIds?: string[];
  jobId?: string;
  jobIds?: string[];
}

export interface CanvasCommandOutput {
  references: CanvasResourceReferences;
  value?: unknown;
}

export type CanvasCommandErrorCode =
  | 'invalid_command'
  | 'unsupported_command'
  | 'not_found'
  | 'conflict'
  | 'revision_conflict'
  | 'not_atomic'
  | 'execution_failed';

export interface CanvasCommandError {
  code: CanvasCommandErrorCode;
  message: string;
  commandIndex?: number;
  commandType?: CanvasCommandType;
  details?: Record<string, unknown>;
}

export interface CanvasCommandExecutionSuccess {
  ok: true;
  commandType: CanvasCommandType;
  revisionBefore: number;
  revisionAfter: number;
  impact: CanvasCommandImpact;
  output: CanvasCommandOutput;
}

export interface CanvasCommandExecutionFailure {
  ok: false;
  commandType?: CanvasCommandType;
  revisionBefore: number;
  revisionAfter: number;
  error: CanvasCommandError;
  retryPreview?: CanvasTransactionPreview;
}

export type CanvasCommandExecutionResult =
  | CanvasCommandExecutionSuccess
  | CanvasCommandExecutionFailure;

export interface CanvasTransaction {
  id: string;
  origin: CanvasCommandOrigin;
  expectedRevision: number;
  commands: CanvasCommand[];
}

export interface CanvasTransactionPreview {
  transactionId: string;
  baseRevision: number;
  valid: boolean;
  impacts: CanvasCommandImpact[];
  references: CanvasResourceReferences;
  errors: CanvasCommandError[];
}

export interface CanvasTransactionSuccess {
  ok: true;
  transactionId: string;
  revisionBefore: number;
  revisionAfter: number;
  impacts: CanvasCommandImpact[];
  outputs: CanvasCommandOutput[];
  references: CanvasResourceReferences;
}

export interface CanvasTransactionFailure {
  ok: false;
  transactionId: string;
  revisionBefore: number;
  revisionAfter: number;
  error: CanvasCommandError;
  retryPreview?: CanvasTransactionPreview;
}

export type CanvasTransactionResult = CanvasTransactionSuccess | CanvasTransactionFailure;

export function createCanvasCommand<T extends CanvasCommand>(
  type: T['type'],
  input: T['input'],
): T {
  return { type, version: CANVAS_COMMAND_VERSION, input } as T;
}
