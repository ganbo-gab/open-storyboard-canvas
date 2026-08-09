import { describe, expect, it } from 'vitest';

import {
  inspectCanvasCapabilityCoverage,
} from './canvasCapabilities';
import { canvasNodeDefinitions } from './nodeRegistry';
import { CANVAS_REGISTERED_COMMAND_TYPES } from '../application/canvasCommandRegistry';
import { CANVAS_GENERATION_TRIGGER_NODE_TYPES } from '../application/canvasGenerationTriggers';

describe('canvas capability manifest coverage', () => {
  it('covers every registered node, command action, and generation strategy', () => {
    expect(inspectCanvasCapabilityCoverage({
      nodeTypes: Object.keys(canvasNodeDefinitions),
      actionIds: CANVAS_REGISTERED_COMMAND_TYPES,
      generationNodeTypes: CANVAS_GENERATION_TRIGGER_NODE_TYPES,
    })).toEqual({
      covered: true,
      missingNodeTypes: [],
      staleNodeTypes: [],
      missingActionIds: [],
      staleActionIds: [],
      missingGenerationStrategies: [],
      staleGenerationStrategies: [],
    });
  });

  it('reports newly registered capabilities that have no explicit Agent policy', () => {
    const result = inspectCanvasCapabilityCoverage({
      nodeTypes: [...Object.keys(canvasNodeDefinitions), 'newNodeType'],
      actionIds: [...CANVAS_REGISTERED_COMMAND_TYPES, 'canvas.newAction'],
      generationNodeTypes: [...CANVAS_GENERATION_TRIGGER_NODE_TYPES, 'newGeneratorNode'],
    });
    expect(result).toMatchObject({
      covered: false,
      missingNodeTypes: ['newNodeType'],
      missingActionIds: ['canvas.newAction'],
      missingGenerationStrategies: ['newGeneratorNode'],
    });
  });
});
