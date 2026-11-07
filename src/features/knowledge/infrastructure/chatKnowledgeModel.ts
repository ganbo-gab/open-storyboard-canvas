import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import { buildChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import { getChannelCatalogProviders } from '@/features/channels/application/channelCatalog';
import { submitCustomChatCompletion } from '@/features/channels/runtime/channelChat';
import { KnowledgeError } from '../domain/types';
import type { KnowledgeModelPort } from '../domain/organize';

/** Uses exactly the user's turn selection. No default model, transport retry, or undeclared parameters. */
export function createKnowledgeModelPort(model: ChatCatalogEntry): KnowledgeModelPort {
  return async (request) => {
    const selected = buildChatModelCatalog(getChannelCatalogProviders()).find((entry) => entry.id === model.id);
    if (!model.usable || !selected?.usable) throw new KnowledgeError('MODEL_UNAVAILABLE', 'The selected turn model is unavailable; select an available model');
    const result = await submitCustomChatCompletion(model.id, {
      messages: [
        { role: 'system', content: `${request.system}\nJSON Schema: ${JSON.stringify(request.jsonSchema)}` },
        { role: 'user', content: request.prompt },
      ],
    });
    const trimmed = result.text.trim();
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
    return fenced ? fenced[1].trim() : trimmed;
  };
}
