import type { XYPosition } from '@xyflow/react';

import type {
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  NodeToolType,
  StoryboardFrameItem,
} from '../domain/canvasNodes';
import type { CanvasNodeDefinition } from '../domain/nodeRegistry';

export interface IdGenerator {
  next: () => string;
}

export interface NodeCatalog {
  getDefinition: (type: CanvasNodeType) => CanvasNodeDefinition;
  getMenuDefinitions: () => CanvasNodeDefinition[];
}

export interface NodeFactory {
  createNode: (
    type: CanvasNodeType,
    position: XYPosition,
    data?: Partial<CanvasNodeData>
  ) => CanvasNode;
}

export interface GraphImageResolver {
  collectInputImages: (nodeId: string, nodes: CanvasNode[], edges: CanvasEdge[]) => string[];
}

export interface GenerateImagePayload {
  prompt: string;
  model: string;
  size: string;
  aspectRatio: string;
  referenceImages?: string[];
  extraParams?: Record<string, unknown>;
}

export interface GenerateVideoPayload {
  prompt: string;
  model: string;
  size: string;
  aspectRatio?: string;
  seconds?: number;
  inputReference?: string;
  referenceImages?: string[];
  referenceVideos?: string[];
  referenceAudios?: string[];
  extraParams?: Record<string, unknown>;
}

export interface GenerationJobPollStatus {
  job_id: string;
  status:
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
  result?: string | null;
  error?: string | null;
  warning?: string | null;
  phase?: string;
  external_task_id?: string | null;
  result_url?: string | null;
  error_category?: string | null;
  network_route?: 'system' | 'direct' | 'custom-proxy';
  resumable?: boolean;
  created_at?: number;
  updated_at?: number;
}

export interface AiGateway {
  setApiKey: (provider: string, apiKey: string) => Promise<void>;
  generateImage: (payload: GenerateImagePayload) => Promise<string>;
  submitGenerateImageJob: (payload: GenerateImagePayload) => Promise<string>;
  getGenerateImageJob: (jobId: string) => Promise<GenerationJobPollStatus>;
  submitGenerateVideoJob: (payload: GenerateVideoPayload) => Promise<string>;
  getGenerateVideoJob: (jobId: string) => Promise<GenerationJobPollStatus>;
  retryGenerationJob?: (jobId: string) => Promise<boolean>;
  retryGenerateVideoJob?: (jobId: string) => Promise<boolean>;
}

export interface ImageSplitGateway {
  split: (
    imageSource: string,
    rows: number,
    cols: number,
    lineThickness: number
  ) => Promise<string[]>;
}

export interface ToolProcessorResult {
  outputImageUrl?: string;
  storyboardFrames?: StoryboardFrameItem[];
  rows?: number;
  cols?: number;
  frameAspectRatio?: string;
}

export interface ToolProcessor {
  process: (
    toolType: NodeToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>
  ) => Promise<ToolProcessorResult>;
}

export interface CanvasEventMap {
  'tool-dialog/open': {
    nodeId: string;
    toolType: NodeToolType;
  };
  'tool-dialog/close': undefined;
  'upload-node/reupload': {
    nodeId: string;
  };
  'upload-node/paste-material': {
    nodeId: string;
    file: File;
  };
  'generation-node/trigger': {
    nodeId: string;
  };
  'director-studio/open': {
    nodeId: string;
  };
  'director-studio/record': {
    nodeId: string;
    resolution: '720p' | '1080p';
    fps: 24 | 30;
    addToCanvas: boolean;
    requestId: string;
  };
  'director-studio/record-result': {
    requestId: string;
    nodeId: string;
    resultNodeId?: string;
    error?: string;
  };
}

export interface CanvasEventBus {
  publish: <TType extends keyof CanvasEventMap>(
    type: TType,
    payload: CanvasEventMap[TType]
  ) => void;
  subscribe: <TType extends keyof CanvasEventMap>(
    type: TType,
    handler: (payload: CanvasEventMap[TType]) => void
  ) => () => void;
}
