import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type NodeToolType,
  type StoryboardFrameItem,
} from '../domain/canvasNodes';
import { prepareNodeImage } from './imageData';
import type { ToolProcessor } from './ports';
import { getToolPlugin } from '../tools';
import type { ToolOptions, ToolOptionPrimitive } from '../tools/types';

const AGENT_DETERMINISTIC_TOOL_TYPES = new Set<string>([
  'crop',
  'annotate',
  'split-storyboard',
]);

export function isAgentCanvasToolType(toolType: unknown): toolType is NodeToolType {
  return typeof toolType === 'string' && AGENT_DETERMINISTIC_TOOL_TYPES.has(toolType);
}

export interface CanvasToolWorkflowStorePort {
  getNodes: () => CanvasNode[];
  addDerivedExportNode: (
    sourceNodeId: string,
    imageUrl: string,
    aspectRatio: string,
    previewImageUrl?: string,
    options?: {
      defaultTitle?: string;
      resultKind?: 'generic';
      aspectRatioStrategy?: 'provided';
      sizeStrategy?: 'autoMinEdge';
    },
  ) => string | null;
  addStoryboardSplitNode: (
    sourceNodeId: string,
    rows: number,
    cols: number,
    frames: StoryboardFrameItem[],
    frameAspectRatio?: string,
  ) => string | null;
  addEdge: (sourceNodeId: string, targetNodeId: string) => string | null;
}

export interface CanvasToolWorkflowResult {
  sourceNodeId: string;
  resultNodeId: string;
  edgeId: string | null;
  toolType: NodeToolType;
}

function sourceImageUrl(node: CanvasNode): string | null {
  if (
    node.type !== CANVAS_NODE_TYPES.upload
    && node.type !== CANVAS_NODE_TYPES.imageEdit
    && node.type !== CANVAS_NODE_TYPES.exportImage
  ) {
    return null;
  }
  return typeof node.data.imageUrl === 'string' && node.data.imageUrl.trim()
    ? node.data.imageUrl
    : null;
}

function normalizeToolOptions(value: Record<string, unknown> | undefined): ToolOptions {
  return Object.fromEntries(Object.entries(value ?? {}).filter(
    (entry): entry is [string, ToolOptionPrimitive] => (
      typeof entry[1] === 'string'
      || typeof entry[1] === 'number'
      || typeof entry[1] === 'boolean'
    ),
  ));
}

export class CanvasToolWorkflowFacade {
  constructor(
    private readonly store: CanvasToolWorkflowStorePort,
    private readonly processor: ToolProcessor,
  ) {}

  supports(node: CanvasNode, toolType: NodeToolType): boolean {
    const plugin = getToolPlugin(toolType);
    return Boolean(isAgentCanvasToolType(toolType) && plugin && plugin.supportsNode(node) && sourceImageUrl(node));
  }

  async run(input: {
    nodeId: string;
    toolType: NodeToolType;
    options?: Record<string, unknown>;
  }): Promise<CanvasToolWorkflowResult> {
    const node = this.store.getNodes().find((candidate) => candidate.id === input.nodeId);
    if (!node) {
      throw new Error(`Node ${input.nodeId} does not exist.`);
    }
    const plugin = getToolPlugin(input.toolType);
    const imageUrl = sourceImageUrl(node);
    if (!isAgentCanvasToolType(input.toolType) || !plugin || !imageUrl || !plugin.supportsNode(node)) {
      throw new Error(`Node ${input.nodeId} does not support tool ${input.toolType}.`);
    }

    const options = {
      ...plugin.createInitialOptions(node),
      ...normalizeToolOptions(input.options),
    };
    const result = await plugin.execute(imageUrl, options, {
      processTool: (toolType, source, toolOptions) => (
        this.processor.process(toolType, source, toolOptions)
      ),
    });

    let resultNodeId: string | null = null;
    if (result.storyboardFrames && result.rows && result.cols) {
      resultNodeId = this.store.addStoryboardSplitNode(
        node.id,
        result.rows,
        result.cols,
        result.storyboardFrames,
        result.frameAspectRatio,
      );
    } else if (result.outputImageUrl) {
      const prepared = await prepareNodeImage(result.outputImageUrl);
      resultNodeId = this.store.addDerivedExportNode(
        node.id,
        prepared.imageUrl,
        prepared.aspectRatio,
        prepared.previewImageUrl,
        {
          defaultTitle: `${plugin.label}结果`,
          resultKind: 'generic',
          aspectRatioStrategy: 'provided',
          sizeStrategy: 'autoMinEdge',
        },
      );
    }

    if (!resultNodeId) {
      throw new Error(`Tool ${input.toolType} completed without a canvas result.`);
    }
    const edgeId = this.store.addEdge(node.id, resultNodeId);
    return {
      sourceNodeId: node.id,
      resultNodeId,
      edgeId,
      toolType: input.toolType,
    };
  }
}
