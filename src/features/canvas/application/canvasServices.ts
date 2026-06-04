import { InMemoryCanvasEventBus } from './eventBus';
import { nodeCatalog } from './nodeCatalog';
import { CanvasNodeFactory } from './nodeFactory';
import { CanvasToolProcessor } from './toolProcessor';
import { uuidGenerator } from '../infrastructure/idGenerator';
import {
  buildGenerateImageDebugPreview,
  buildGenerateVideoDebugPreview,
  tauriAiGateway,
} from '../infrastructure/tauriAiGateway';
import { tauriImageSplitGateway } from '../infrastructure/tauriImageSplitGateway';

export const canvasEventBus = new InMemoryCanvasEventBus();
export const canvasNodeFactory = new CanvasNodeFactory(uuidGenerator, nodeCatalog);
export const canvasToolProcessor = new CanvasToolProcessor(tauriImageSplitGateway, uuidGenerator, tauriAiGateway);
export const canvasAiGateway = tauriAiGateway;
export const canvasVideoGateway = tauriAiGateway;
export const buildImageGenerationDebugPreview = buildGenerateImageDebugPreview;
export const buildVideoGenerationDebugPreview = buildGenerateVideoDebugPreview;

export { graphImageResolver } from './graphImageResolver';
