import type { XYPosition } from '@xyflow/react';

import type { CanvasNode, CanvasNodeData, CanvasNodeType } from '../domain/canvasNodes';
import type { IdGenerator, NodeCatalog, NodeFactory } from './ports';

export class CanvasNodeFactory implements NodeFactory {
  constructor(
    private readonly idGenerator: IdGenerator,
    private readonly nodeCatalog: NodeCatalog
  ) {}

  createNode(
    type: CanvasNodeType,
    position: XYPosition,
    data: Partial<CanvasNodeData> = {}
  ): CanvasNode {
    const definition = this.nodeCatalog.getDefinition(type);
    const nodeData = {
      ...definition.createDefaultData(),
      ...data,
    } as CanvasNodeData;

    const node: CanvasNode = {
      id: this.idGenerator.next(),
      type,
      position,
      data: nodeData,
    };

    if (definition.defaultSize) {
      node.style = {
        width: definition.defaultSize.width,
        height: definition.defaultSize.height,
      };
    }

    return node;
  }
}
