import type {
  CanvasCommand,
  CanvasCommandError,
  CanvasCommandOrigin,
} from '../domain/canvasCommands';
import {
  canvasNodeCapabilityManifest,
  type CanvasNodeCapabilityDeclaration,
} from '../domain/canvasCapabilities';
import type { CanvasGraphDraft } from './canvasTransactionCoordinator';

export function isCanvasCommandOrigin(value: unknown): value is CanvasCommandOrigin {
  return value === 'ui' || value === 'agent' || value === 'system';
}

export function getCanvasGraphCommandOriginError(
  command: CanvasCommand,
  draft: CanvasGraphDraft,
  origin: CanvasCommandOrigin,
): CanvasCommandError | null {
  const restrictedNodeId = findOriginRestrictedNodeId(command, draft, origin);
  if (!restrictedNodeId) {
    return null;
  }
  const node = draft.nodes.find((candidate) => candidate.id === restrictedNodeId);
  const capability: CanvasNodeCapabilityDeclaration | null = node
    ? canvasNodeCapabilityManifest[node.type]
    : null;
  return {
    code: 'invalid_command',
    message: capability?.reason
      ?? `Node ${restrictedNodeId} can only be edited by UI-origin commands.`,
  };
}

function findOriginRestrictedNodeId(
  command: CanvasCommand,
  draft: CanvasGraphDraft,
  origin: CanvasCommandOrigin,
): string | null {
  if (origin === 'ui' || command.type === 'node.create') {
    return null;
  }

  const seedIds = new Set<string>();
  switch (command.type) {
    case 'node.delete':
    case 'node.layout':
    case 'group.create':
    case 'node.setEnabled':
    case 'storyboard.merge':
      command.input.nodeIds.forEach((nodeId) => seedIds.add(nodeId));
      break;
    case 'batch.setPrimary':
    case 'batch.setCollapsed':
    case 'batch.split':
      draft.nodes.forEach((node) => { if (node.data.batchId === command.input.batchId) seedIds.add(node.id); });
      break;
    case 'node.duplicate':
      command.input.copies.forEach(({ sourceNodeId }) => seedIds.add(sourceNodeId));
      break;
    case 'tag.setColor':
      seedIds.add(command.input.tagId);
      break;
    case 'tagGroup.setMembers':
      seedIds.add(command.input.groupId);
      command.input.memberNodeIds.forEach((nodeId) => seedIds.add(nodeId));
      break;
    case 'tagGroup.setAppearance':
      seedIds.add(command.input.groupId);
      break;
    case 'node.rename':
    case 'node.setPrompt':
    case 'node.setModelConfig':
      seedIds.add(command.input.nodeId);
      break;
    case 'storyboard.update':
    case 'panorama.update':
    case 'director.update':
      seedIds.add(command.input.nodeId);
      break;
    case 'node.move':
      command.input.positions.forEach(({ nodeId }) => seedIds.add(nodeId));
      break;
    case 'edge.connect':
      seedIds.add(command.input.sourceNodeId);
      seedIds.add(command.input.targetNodeId);
      break;
    case 'selection.connect':
      command.input.sourceNodeIds.forEach((nodeId) => seedIds.add(nodeId));
      seedIds.add(command.input.targetNodeId);
      break;
    case 'edge.disconnect': {
      const edgeIds = new Set(command.input.edgeIds);
      draft.edges.forEach((edge) => {
        if (edgeIds.has(edge.id)) {
          seedIds.add(edge.source);
          seedIds.add(edge.target);
        }
      });
      break;
    }
    case 'group.ungroup':
      command.input.groupIds.forEach((groupId) => seedIds.add(groupId));
      break;
    default:
      return null;
  }

  let addedDescendant = true;
  while (addedDescendant) {
    addedDescendant = false;
    draft.nodes.forEach((node) => {
      if (node.parentId && seedIds.has(node.parentId) && !seedIds.has(node.id)) {
        seedIds.add(node.id);
        addedDescendant = true;
      }
    });
  }

  return draft.nodes.find((node) => (
    seedIds.has(node.id)
    && canvasNodeCapabilityManifest[node.type].status !== 'supported'
  ))?.id ?? null;
}
