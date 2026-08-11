import type { ExternalAgentAttachment } from '@/commands/externalAgent';
import { imageUrlToDataUrl } from '@/features/canvas/application/imageData';
import type { AgentTurnMediaInput } from '../domain/agentModel';
import {
  MAX_AGENT_MEDIA_FILE_BYTES,
  validateAgentTurnMediaInputs,
} from './agentMediaResolver';

const EXTERNAL_MIME_TYPES = new Set<ExternalAgentAttachment['mimeType']>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

function nextReferenceId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `attachment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeTitle(value: string): string {
  const title = value
    .replace(/[\\/\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return title || 'Canvas image';
}

function parseImageDataUrl(value: string): {
  mimeType: ExternalAgentAttachment['mimeType'];
  bytesBase64: string;
} {
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new Error('External Agent attachments must resolve to a base64 image payload.');
  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  if (!EXTERNAL_MIME_TYPES.has(mimeType as ExternalAgentAttachment['mimeType'])) {
    throw new Error('External Agent attachments support PNG, JPEG, WebP, and GIF images.');
  }
  const bytesBase64 = match[2].replace(/\s+/g, '');
  const padding = bytesBase64.endsWith('==') ? 2 : bytesBase64.endsWith('=') ? 1 : 0;
  const byteLength = Math.max(0, Math.floor(bytesBase64.length * 3 / 4) - padding);
  if (byteLength <= 0 || byteLength > MAX_AGENT_MEDIA_FILE_BYTES) {
    throw new Error('An external Agent image attachment must be between 1 byte and 10 MB.');
  }
  return {
    mimeType: mimeType as ExternalAgentAttachment['mimeType'],
    bytesBase64,
  };
}

export async function buildExternalAgentAttachments(
  inputs: AgentTurnMediaInput[],
): Promise<ExternalAgentAttachment[]> {
  const validated = validateAgentTurnMediaInputs(inputs);
  return Promise.all(validated.map(async (input) => {
    const dataUrl = await imageUrlToDataUrl(input.source);
    const payload = parseImageDataUrl(dataUrl);
    return {
      referenceId: nextReferenceId(),
      title: safeTitle(input.title),
      ...payload,
    };
  }));
}
