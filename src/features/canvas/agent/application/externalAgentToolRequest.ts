import { CANVAS_REGISTERED_COMMAND_TYPES } from '@/features/canvas/application/canvasCommandRegistry';
import { CANVAS_COMMAND_VERSION } from '@/features/canvas/domain/canvasCommands';
import type { ExternalAgentToolRequest } from '../domain/agentModel';

export type ExternalAgentToolRequestInput = Omit<ExternalAgentToolRequest, 'toolName'> & { toolName: string };

/** All external entrypoints share the same command-to-approval envelope. */
export function normalizeExternalAgentToolRequest(request: ExternalAgentToolRequestInput): ExternalAgentToolRequest {
  const commandType = CANVAS_REGISTERED_COMMAND_TYPES.find((type) => type === request.toolName);
  if (commandType) {
    return { ...request, toolName: 'canvas_command', arguments: {
      type: commandType, version: CANVAS_COMMAND_VERSION, input: request.arguments,
    } };
  }
  if (request.toolName === 'canvas_command' || request.toolName === 'diagnostics'
    || request.toolName === 'config_patch' || request.toolName === 'asset_read') {
    return { ...request, toolName: request.toolName };
  }
  throw new Error(`External Agent requested unknown tool ${request.toolName}.`);
}
