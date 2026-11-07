import { z } from 'zod';
import { buildChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import { getChannelCatalogProviders } from '@/features/channels/application/channelCatalog';
import { createChannel, listChannels, parseProfileImport, previewChannel, updateChannel } from '@/features/channels/application/channelService';
import { generateChannelProfile } from '@/features/channels/application/configurationAssistant';
import { listModelModes, modeParamDefaults, resolveModelModeOrFirst, summarizeModesForAgent } from '@/features/channels/application/modelModes';
import { operationKinds, type ChannelProfileV2 } from '@/features/channels/domain/profile';
import type { JobRef } from '@/features/channels/runtime/types';
import { channelProviderId } from '@/features/channels/store/channelStore';
import { defineScopedAgentTool, type ScopedAgentTool } from './scopedAgentToolDefinition';

const text = z.string().trim().min(1);
const profileJson = text.max(1_048_576).describe('One strict ChannelProfileV2 JSON object. No credentials: the user enters the key separately in Settings.');
const credentialInstruction = 'Enter the API key yourself in Settings → Channels. This tool never accepts, reads, changes, or stores a credential.';

function channelPreview(profile: ChannelProfileV2, input: { modelId?: string; modeId?: string; operation?: typeof operationKinds[number]; prompt?: string }) {
  const model = input.modelId ? profile.models.find((item) => item.id === input.modelId) : profile.models[0];
  if (!model) throw new Error('渠道模型不存在');
  const mode = model.modes?.length ? resolveModelModeOrFirst(model, input.modeId) : null;
  if (input.modeId && mode?.mode.id !== input.modeId) throw new Error('渠道模式不存在');
  const operation = mode?.operation ?? input.operation ?? model.operations[0];
  if (!operation || (!mode && !model.operations.includes(operation))) throw new Error('渠道模型不支持所选操作');
  const mime = { image: 'image/png', video: 'video/mp4', audio: 'audio/mpeg' } as const;
  const refs: JobRef[] = mode ? mode.slots.flatMap((slot) => Array.from({ length: Math.max(slot.min ?? 0, slot.max > 0 ? 1 : 0) }, (_, index) => ({
    kind: slot.kind, slot: slot.key, assetId: `sample-${slot.key}-${index + 1}`,
    path: `https://example.com/sample-${slot.key}-${index + 1}.${slot.kind === 'image' ? 'png' : slot.kind === 'video' ? 'mp4' : 'mp3'}`, mime: mime[slot.kind],
  }))) : [];
  const preview = previewChannel(profile, { jobId: 'preview', channelId: profile.id, modelId: model.id,
    ...(mode ? { modeId: mode.mode.id } : {}), operation, prompt: input.prompt ?? 'A quiet cinematic scene',
    params: mode ? modeParamDefaults(mode) : {}, refs, count: 1 });
  // JSON chunks preserve long templates without the audit redactor's long-string/depth limits.
  const serialized = JSON.stringify(profile);
  const previewText = JSON.stringify(preview);
  return { profileId: profile.id, profileJsonChunks: serialized.match(/[\s\S]{1,4000}/g) ?? [], requestPreviewChunks: previewText.match(/[\s\S]{1,4000}/g) ?? [], credentialInstruction };
}

export const scopedChannelTools: ScopedAgentTool[] = [
  defineScopedAgentTool({ name: 'channel_list', scope: 'home', risk: 'read',
    description: 'List configured channel profile metadata, never API keys or credential references.', schema: z.object({}).strict(),
    async execute() { return listChannels().map(({ profile }) => ({ id: profile.id, name: profile.name, baseUrl: profile.baseUrl, models: profile.models.map(({ id, label, operations }) => ({ id, label, operations })) })); },
  }),
  defineScopedAgentTool({ name: 'channel_models', scope: 'home', risk: 'read',
    description: 'List configured channel models, declared modes and current chat usability. No network request or credential read.',
    schema: z.object({ channelId: text.optional() }).strict(),
    async execute(input) {
      const chat = buildChatModelCatalog(getChannelCatalogProviders());
      return listChannels().filter(({ profile }) => !input.channelId || profile.id === input.channelId).map(({ profile }) => ({ channelId: profile.id,
        models: profile.models.map((model) => ({ id: model.id, label: model.label, operations: model.operations, modes: summarizeModesForAgent(listModelModes(model)),
          chat: chat.filter((entry) => entry.modelId === model.id && entry.providerId === channelProviderId(profile.id, 'chat')).map(({ id, usable, notReadyReason }) => ({ id, usable, notReadyReason })),
        })),
      }));
    },
  }),
  defineScopedAgentTool({ name: 'channel_preview', scope: 'home', risk: 'read',
    description: 'Validate pasted ChannelProfileV2 JSON and render a local request preview through the same previewChannel path as ChannelRequestPreview. Never saves, tests connectivity, or submits generation. Concatenate profileJsonChunks unchanged to save the complete profile.',
    schema: z.object({ profileJson, modelId: text.optional(), modeId: text.optional(), operation: z.enum(operationKinds).optional(), prompt: text.max(5000).optional() }).strict(),
    async execute(input) { const parsed = parseProfileImport(input.profileJson); return parsed.ok ? { ok: true, ...channelPreview(parsed.profile, input) } : parsed; },
  }),
  defineScopedAgentTool({ name: 'channel_generate_profile', scope: 'home', risk: 'paid',
    description: 'Use only the explicitly selected turn model to compile pasted API documentation into a validated channel profile and local request preview. May charge money, always requires explicit approval; never saves a profile, sends a test request or accepts credentials.',
    schema: z.object({ docsText: text.max(200 * 1024) }).strict(),
    async execute(input, context) {
      const model = context.selectedTurnModel;
      if (!model?.usable || !buildChatModelCatalog(getChannelCatalogProviders()).some((entry) => entry.id === model.id && entry.usable)) throw new Error('Select an available turn model before generating a channel profile');
      const result = await generateChannelProfile({ modelId: model.id, docsText: input.docsText, signal: context.signal });
      return result.ok ? { ok: true, attempts: result.attempts, evidence: result.evidence, ...channelPreview(result.profile, {}) } : { ok: false, errors: result.errors, attempts: result.attempts };
    },
  }),
  defineScopedAgentTool({ name: 'channel_create', scope: 'home', risk: 'edit',
    description: 'Create only a channel profile from validated JSON after explicit approval. Never accepts or stores an API key; the user must enter it in Settings. No connection test or paid submit.',
    schema: z.object({ profileJson }).strict(),
    async execute(input) {
      const parsed = parseProfileImport(input.profileJson); if (!parsed.ok) return parsed;
      const record = await createChannel(parsed.profile);
      return { ok: true, channelId: record.profile.id, credentialInstruction };
    },
  }),
  defineScopedAgentTool({ name: 'channel_update', scope: 'home', risk: 'edit',
    description: 'Update only an existing channel profile after explicit approval. Never accepts, reads, changes or stores credentials; an existing key remains unchanged and the user enters keys in Settings. No network test or paid submit.',
    schema: z.object({ channelId: text, profileJson }).strict(),
    async execute(input) {
      const parsed = parseProfileImport(input.profileJson); if (!parsed.ok) return parsed;
      const record = await updateChannel(input.channelId, parsed.profile);
      return { ok: true, channelId: record.profile.id, credentialInstruction };
    },
  }),
];
