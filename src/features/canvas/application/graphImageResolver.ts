import {
  type CanvasEdge,
  type CanvasNode,
} from '../domain/canvasNodes';
import { collectInputImageUrls } from './graphReferenceResolver';
import type { GraphImageResolver } from './ports';

export class DefaultGraphImageResolver implements GraphImageResolver {
  collectInputImages(nodeId: string, nodes: CanvasNode[], edges: CanvasEdge[]): string[] {
    return collectInputImageUrls(nodeId, nodes, edges);
  }
}

export const graphImageResolver = new DefaultGraphImageResolver();
