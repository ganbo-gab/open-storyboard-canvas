import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import type { CanvasCommandType } from '@/features/canvas/domain/canvasCommands';
import type { ExternalAgentToolAnnotations } from '@/commands/externalAgent';
import type { AgentToolKind } from './agentSkills';

export const EXTERNAL_CANVAS_MCP_NAMESPACE = 'storyboard_canvas' as const;
export const EXTERNAL_CANVAS_MCP_VERSION = 1 as const;

export interface ExternalCanvasMcpTool {
  name: CanvasCommandType | 'diagnostics' | 'config_patch' | 'asset_read';
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ExternalAgentToolAnnotations;
}

export interface ExternalCanvasMcpManifestV1 {
  version: typeof EXTERNAL_CANVAS_MCP_VERSION;
  namespace: typeof EXTERNAL_CANVAS_MCP_NAMESPACE;
  tools: ExternalCanvasMcpTool[];
}

const diagnosticsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['operation'],
  properties: {
    operation: {
      type: 'string',
      enum: ['health', 'provider-config', 'generation-jobs', 'application-logs', 'preflight', 'classify-error', 'bundle-preview'],
    },
    error: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' },
    aspectRatio: { type: 'string' },
    resolution: { type: 'string' },
    maxPixels: { type: 'number' },
    nodeIds: { type: 'array', items: { type: 'string' }, maxItems: 50 },
    requiresVision: { type: 'boolean' },
    supportsVision: { type: 'boolean' },
    requiresTools: { type: 'boolean' },
    supportsTools: { type: 'boolean' },
    accessState: { type: 'string', enum: ['configured', 'missing'] },
    endpointValid: { type: 'boolean' },
    reproductionSteps: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    jobId: { type: 'string' },
    severity: { type: 'string', enum: ['debug', 'info', 'warning', 'error'] },
    source: { type: 'string', maxLength: 200 },
    query: { type: 'string', maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
};

const configPatchSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['preview', 'apply', 'rollback'] },
    providerId: { type: 'string' },
    settingsTarget: { type: 'string', enum: ['generation-network'] },
    networkRoute: { type: 'string', enum: ['system', 'direct', 'custom-proxy'] },
    baseRevision: { type: 'string' },
    rollbackToken: { type: 'string' },
    baseUrl: { type: 'string' },
    endpointPath: { type: 'string' },
    apiStyle: { type: 'string' },
    modelId: { type: 'string' },
    supportsTools: { type: 'boolean' },
    supportsMultimodal: { type: 'boolean' },
    supportsStreaming: { type: 'boolean' },
    supportsReasoningSummary: { type: 'boolean' },
    supportsToolSearch: { type: 'boolean' },
    agentProtocol: {
      type: 'string',
      enum: ['openai-responses', 'openai-chat-completions', 'anthropic-messages', 'google-gemini'],
    },
  },
};

const assetReadSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['assetId'],
  properties: { assetId: { type: 'string', minLength: 1 } },
};

function canvasCommandTools(): ExternalCanvasMcpTool[] {
  return canvasCommandRegistry.list().map((definition) => {
    const readOnly = definition.effect === 'read';
    return {
      name: definition.type,
      title: definition.type,
      description: `Execute the registered ${definition.type} canvas command (${definition.effect}). Every call requires application approval.`,
      inputSchema: { ...definition.schema.input },
      annotations: {
        readOnlyHint: readOnly,
        // Graph edits can replace or remove existing data, and generation can
        // incur external side effects. Neither is safe to advertise otherwise.
        destructiveHint: definition.effect === 'graph' || definition.effect === 'generation',
        idempotentHint: readOnly,
        openWorldHint: false,
      },
    };
  });
}

const toolsByKind: Record<Exclude<AgentToolKind, 'canvas'>, ExternalCanvasMcpTool> = {
  diagnostics: {
    name: 'diagnostics',
    title: 'Canvas diagnostics',
    description: 'Inspect bounded, redacted runtime and provider evidence after application approval.',
    inputSchema: diagnosticsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  config: {
    name: 'config_patch',
    title: 'Configuration patch',
    description: 'Preview, apply, or roll back an allowlisted non-secret configuration patch after application approval.',
    inputSchema: configPatchSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  'asset-read': {
    name: 'asset_read',
    title: 'Canvas image read',
    description: 'Read one stable canvas image asset after explicit application approval.',
    inputSchema: assetReadSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
};

export function buildExternalCanvasMcpManifest(toolKinds: readonly AgentToolKind[]): ExternalCanvasMcpManifestV1 {
  const kinds = new Set(toolKinds);
  const tools = [
    ...(kinds.has('canvas') ? canvasCommandTools() : []),
    ...(['diagnostics', 'config', 'asset-read'] as const).flatMap((kind) => (
      kinds.has(kind) ? [toolsByKind[kind]] : []
    )),
  ];
  // The manifest is application-owned static metadata. Dynamic arguments and
  // results are redacted at the bridge boundary; value redaction here would
  // truncate deeply nested JSON Schema enums.
  return {
    version: EXTERNAL_CANVAS_MCP_VERSION,
    namespace: EXTERNAL_CANVAS_MCP_NAMESPACE,
    tools,
  };
}

export function assertExternalCanvasToolAllowed(
  manifest: ExternalCanvasMcpManifestV1,
  toolName: string,
): ExternalCanvasMcpTool {
  const tool = manifest.tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`External Agent tool ${toolName} is not allowed for this turn.`);
  return tool;
}
