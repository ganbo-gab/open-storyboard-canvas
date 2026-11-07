import type { CanvasNodeData, CanvasNodeType } from '../../domain/canvasNodes';
import type { GenerateImagePayload } from '../ports';
import type { ResolvedPanelModel } from '../resolveActiveModelForPanel';

export interface ImageGenerationPlan {
  resolved: ResolvedPanelModel;
  sourceType: 'imageEdit' | 'storyboardGen';
  resultType: CanvasNodeType;
  resultPatch: Partial<CanvasNodeData>;
  gatewayPayload: GenerateImagePayload;
  gridPreview?: string;
}

export interface LocalPanoramaPlan {
  localPanorama: {
    imageUrl: string;
    aspectRatio: string;
    sourceImageUrl: string;
    projection: 'spherical' | 'cylindrical';
    sourcePrompt: string;
  };
}

export type GenerationKind = 'image' | 'video' | 'text' | 'audio';

export interface GenerationRequestOptions {
  count?: number;
  historySurface?: 'canvas' | 'agent';
  /** Captured Agent provenance; never changes ordinary undo-group boundaries. */
  agentTurnId?: string;
  /** Panel prompt and persisted configuration, without any dependency on a mounted panel. */
  tool?: { id: string; prompt?: string; params?: Record<string, unknown> };
}

export type GenerationSubmitOutcome =
  | { ok: true; nodeId: string; resultNodeIds: string[]; jobIds: string[] }
  | { ok: false; nodeId: string; reason: 'unsupported' | 'disabled' | 'busy' | 'missing-model' | 'missing-credentials' | 'empty-prompt' | 'invalid-input' | 'failed'; message: string };

export class GenerationInputError extends Error {
  constructor(public readonly reason: Extract<GenerationSubmitOutcome, { ok: false }>['reason'], message: string) {
    super(message);
  }
}
