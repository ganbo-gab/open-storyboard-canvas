import { describe, expect, it } from 'vitest';
import { CANVAS_REGISTERED_COMMAND_TYPES } from '@/features/canvas/application/canvasCommandRegistry';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { CANVAS_AGENT_DIRECT_CREATE_NODE_TYPES } from '@/features/canvas/domain/canvasCapabilities';
import {
  assertExternalCanvasToolAllowed,
  buildExternalCanvasMcpManifest,
} from './externalAgentToolManifest';

describe('external Canvas MCP manifest', () => {
  it('exposes each registered command directly without a generic envelope or privileged tools', () => {
    const manifest = buildExternalCanvasMcpManifest(['canvas', 'asset-read', 'diagnostics', 'config']);

    expect(manifest.tools.map((tool) => tool.name)).toEqual([
      ...CANVAS_REGISTERED_COMMAND_TYPES,
      'diagnostics',
      'config_patch',
      'asset_read',
    ]);
    expect(manifest.tools.some((tool) => String(tool.name) === 'canvas_command')).toBe(false);
    expect(JSON.stringify(manifest)).not.toMatch(/\b(shell|bash|filesystem|child_process|fetch|credential|apiKey)\b/i);
    expect(manifest.tools.every((tool) => tool.annotations.openWorldHint === false)).toBe(true);

    for (const definition of canvasCommandRegistry.list()) {
      const tool = assertExternalCanvasToolAllowed(manifest, definition.type);
      expect(tool.inputSchema).toEqual(definition.schema.input);
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.inputSchema.properties).not.toHaveProperty('input');
      expect(tool.inputSchema.properties).not.toHaveProperty('version');
    }
  });

  it('preserves command-specific fields, required keys, nested constraints, and enums', () => {
    const manifest = buildExternalCanvasMcpManifest(['canvas']);
    const create = assertExternalCanvasToolAllowed(manifest, 'node.create').inputSchema;
    expect(create.required).toEqual(['nodeType', 'position']);
    expect(create.properties).toMatchObject({
      nodeType: { type: 'string', enum: CANVAS_AGENT_DIRECT_CREATE_NODE_TYPES },
      position: {
        type: 'object',
        required: ['x', 'y'],
        additionalProperties: false,
        properties: { x: { type: 'number' }, y: { type: 'number' } },
      },
      dimensions: {
        required: ['width', 'height'],
        additionalProperties: false,
        properties: { width: { type: 'number' }, height: { type: 'number' } },
      },
      configuration: {
        additionalProperties: false,
        properties: {
          prompt: { type: 'string' },
          modelId: { type: 'string' },
          aspectRatio: { type: 'string' },
          resolution: { type: 'string' },
          directorStudioMode: { enum: ['flat', 'panorama'] },
        },
      },
    });
    expect(assertExternalCanvasToolAllowed(manifest, 'canvas.query').inputSchema).toMatchObject({
      required: ['scope'],
      properties: { scope: { enum: ['graph', 'nodes', 'edges', 'selection'] }, limit: { type: 'number' } },
    });
    expect(assertExternalCanvasToolAllowed(manifest, 'edge.connect').inputSchema).toMatchObject({
      required: ['sourceNodeId', 'targetNodeId'],
      properties: { sourceNodeId: { type: 'string' }, targetNodeId: { type: 'string' } },
    });
    expect(assertExternalCanvasToolAllowed(manifest, 'generation.recover').inputSchema).toMatchObject({
      required: ['jobId'],
      properties: { jobId: { type: 'string' }, nodeIds: { type: 'array' } },
    });
  });

  it('maps registry effects conservatively without weakening application approval', () => {
    const manifest = buildExternalCanvasMcpManifest(['canvas']);
    for (const definition of canvasCommandRegistry.list()) {
      const tool = assertExternalCanvasToolAllowed(manifest, definition.type);
      expect(tool.annotations).toEqual({
        readOnlyHint: definition.effect === 'read',
        destructiveHint: definition.effect === 'graph' || definition.effect === 'generation',
        idempotentHint: definition.effect === 'read',
        openWorldHint: false,
      });
      expect(tool.description).toMatch(/requires application approval/i);
    }
    for (const name of ['node.delete', 'edge.disconnect', 'group.ungroup', 'generation.submit']) {
      expect(assertExternalCanvasToolAllowed(manifest, name).annotations.destructiveHint).toBe(true);
    }
  });

  it('retains bounded auxiliary schemas and their risk annotations', () => {
    const manifest = buildExternalCanvasMcpManifest(['diagnostics', 'config', 'asset-read']);
    expect(manifest.tools.map((tool) => tool.name)).toEqual(['diagnostics', 'config_patch', 'asset_read']);
    expect(assertExternalCanvasToolAllowed(manifest, 'diagnostics')).toMatchObject({
      inputSchema: {
        required: ['operation'],
        additionalProperties: false,
        properties: {
          operation: { enum: expect.arrayContaining(['application-logs']) },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          nodeIds: { maxItems: 50 },
          reproductionSteps: { maxItems: 20 },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(assertExternalCanvasToolAllowed(manifest, 'config_patch')).toMatchObject({
      inputSchema: { required: ['action'], properties: { action: { enum: ['preview', 'apply', 'rollback'] } } },
      annotations: { readOnlyHint: false, destructiveHint: true },
    });
    expect(assertExternalCanvasToolAllowed(manifest, 'asset_read')).toMatchObject({
      inputSchema: { required: ['assetId'], properties: { assetId: { type: 'string', minLength: 1 } } },
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
  });

  it('only exposes selected tool kinds, deduplicates kinds, and fails closed', () => {
    const manifest = buildExternalCanvasMcpManifest(['canvas', 'canvas']);
    expect(manifest.tools.map((tool) => tool.name)).toEqual(CANVAS_REGISTERED_COMMAND_TYPES);
    expect(buildExternalCanvasMcpManifest([]).tools).toEqual([]);
    for (const name of ['diagnostics', 'shell', 'node.unknown', 'canvas_command']) {
      expect(() => assertExternalCanvasToolAllowed(manifest, name)).toThrow(/not allowed/i);
    }
    expect(() => assertExternalCanvasToolAllowed(buildExternalCanvasMcpManifest(['diagnostics']), 'node.create'))
      .toThrow(/not allowed/i);
  });
});
