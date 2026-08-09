import type { ChatCatalogEntry } from '../../application/chatModelCatalog';
import type { AgentModelReference } from '../domain/agentModel';

export function resolveAgentModelReference(entry: ChatCatalogEntry): AgentModelReference {
  const tools = entry.supportsTools === true;
  const usable = entry.usable && tools;
  return {
    catalogId: entry.id,
    providerId: entry.providerId,
    modelId: entry.modelId,
    label: `${entry.providerLabel} / ${entry.modelLabel}`,
    usable,
    notReadyReason: !entry.usable
      ? entry.notReadyReason
      : tools
        ? undefined
        : '该模型未声明工具调用能力，不能用作画布 Agent。',
    capabilities: {
      protocol: entry.agentProtocol,
      tools,
      stream: entry.supportsStreaming === true,
      vision: entry.supportsMultimodal === true,
      reasoningSummary: entry.supportsReasoningSummary === true,
      toolSearch: entry.supportsToolSearch === true,
    },
  };
}

export function listUsableAgentModels(entries: readonly ChatCatalogEntry[]): AgentModelReference[] {
  return entries.map(resolveAgentModelReference).filter((entry) => entry.usable);
}
