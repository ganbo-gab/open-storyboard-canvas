import { z } from 'zod';
import { useCustomProvidersStore, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { readComfyUIWorkflows, withComfyUIWorkflows } from '@/features/channels/application/comfyWorkflows';
import { comfyConfigurationSuggestionSchema, comfyStructureForAssistant, validateComfyConfigurationSuggestion, type ComfyConfigurationSuggestion } from '@/features/channels/application/comfyConfigurationAssistant';
import { detectComfyUIBindings } from '@/features/channels/adapters/comfyui/bindings';
import { applyImageHostSuggestion, imageHostSuggestionSchema, validateImageHostSuggestion, type ImageHostConfigurationSuggestion } from '@/features/settings/imageHostConfigurationAssistant';
import type { ImageHostSettings } from '@/features/settings/imageHostSettings';
import { defineScopedAgentTool, type ScopedAgentTool, type ScopedAgentToolContext } from './scopedAgentToolDefinition';

const text = z.string().trim().min(1).max(300);
const identity = z.strictObject({ providerId: text, workflowId: text });
const applySchema = z.strictObject({ draftId: text });
interface DraftOwner { projectId: string; runId: string; expiresAt: number }
type IntegrationDraft = DraftOwner & ({ kind: 'comfy'; provider: CustomProviderConfig; workflowId: string; suggestion: ComfyConfigurationSuggestion }
  | { kind: 'image-host'; settings: ImageHostSettings; suggestion: ImageHostConfigurationSuggestion });
const drafts = new Map<string, IntegrationDraft>();
const ttl = 30 * 60_000;
function remember(draft: IntegrationDraft): string {
  for (const [id, value] of drafts) if (value.expiresAt <= Date.now()) drafts.delete(id);
  if (drafts.size >= 64) drafts.delete(drafts.keys().next().value!);
  const id = crypto.randomUUID(); drafts.set(id, draft); return id;
}
function owner(context: ScopedAgentToolContext): DraftOwner {
  context.signal?.throwIfAborted();
  return { projectId: context.projectId, runId: context.runId, expiresAt: Date.now() + ttl };
}
function readDraft(id: string, context: ScopedAgentToolContext): IntegrationDraft {
  context.signal?.throwIfAborted();
  const draft = drafts.get(id);
  if (!draft || draft.expiresAt <= Date.now() || draft.projectId !== context.projectId || draft.runId !== context.runId) throw new Error('配置草稿已失效或不属于当前回合，请重新预览。');
  return draft;
}
function comfyProvider(id: string): CustomProviderConfig {
  const provider = useCustomProvidersStore.getState().providers.find((entry) => entry.id === id && entry.apiStyle === 'comfyui');
  if (!provider) throw new Error('ComfyUI 连接不存在，请先在设置中导入 API 工作流。');
  return provider;
}
function endpointMetadata(value: string): string {
  try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return ''; }
}
function safeHeaderNames(settings: ImageHostSettings): string[] { return Object.keys(settings.extraHeaders); }
function imageHostMetadata(settings: ImageHostSettings) {
  return { enabled: settings.enabled, uploadUrl: endpointMetadata(settings.uploadUrl), fileField: settings.fileField,
    responseUrlPath: settings.responseUrlPath, headerNames: safeHeaderNames(settings) };
}
function preview(draft: IntegrationDraft) {
  if (draft.kind === 'image-host') return { kind: draft.kind, before: imageHostMetadata(draft.settings), after: {
    enabled: false, uploadUrl: draft.suggestion.uploadUrl, fileField: draft.suggestion.fileField, responseUrlPath: draft.suggestion.responseUrlPath,
    headerNames: [...new Set([...safeHeaderNames(draft.settings), ...draft.suggestion.headerNames])],
  }, explanation: draft.suggestion.explanation };
  const workflow = readComfyUIWorkflows(draft.provider).workflows.find((entry) => entry.id === draft.workflowId)!;
  return { kind: draft.kind, providerId: draft.provider.id, workflowId: draft.workflowId,
    before: { bindings: workflow.config.bindings ?? {}, outputNodeIds: workflow.config.outputNodeIds ?? [] },
    after: { bindings: draft.suggestion.bindings, outputNodeIds: draft.suggestion.outputNodeIds }, explanation: draft.suggestion.explanation };
}

/** Approval cards render our retained validated preview, never an Agent-supplied summary. */
export function integrationDraftApprovalSummary(id: string): string | undefined {
  const draft = drafts.get(id);
  if (!draft || draft.expiresAt <= Date.now()) return undefined;
  return JSON.stringify(preview(draft));
}

const homeTools: ScopedAgentTool[] = [
  defineScopedAgentTool({ name: 'integration_list', scope: 'home', risk: 'read', schema: z.strictObject({}),
    description: 'List real ComfyUI connections/workflow ids and image-host metadata. No credentials, header values, workflow prompt bodies, network tests or generation.',
    async execute() { return { comfy: useCustomProvidersStore.getState().providers.filter((entry) => entry.apiStyle === 'comfyui').map((provider) => {
      try { return { providerId: provider.id, name: provider.label, workflows: readComfyUIWorkflows(provider).workflows.map(({ id, name, mediaType }) => ({ id, name, mediaType })) }; }
      catch { return { providerId: provider.id, name: provider.label, workflows: [], needsRepair: true }; }
    }), imageHost: imageHostMetadata(useSettingsStore.getState().imageHostSettings) }; },
  }),
  defineScopedAgentTool({ name: 'integration_comfy_read', scope: 'home', risk: 'read', schema: identity,
    description: 'Read graph node types, input types/links and bindings for an existing saved ComfyUI workflow. No input values, prompts, filenames, credentials or execution. Use this structure to reason directly; do not invoke another model.',
    async execute(input) {
      const workflow = readComfyUIWorkflows(comfyProvider(input.providerId)).workflows.find((entry) => entry.id === input.workflowId);
      if (!workflow) throw new Error('指定工作流不存在。');
      return { providerId: input.providerId, workflowId: input.workflowId, structure: comfyStructureForAssistant(workflow.config.workflow),
        bindings: workflow.config.bindings ?? {}, outputNodeIds: workflow.config.outputNodeIds ?? [],
        outputCandidates: detectComfyUIBindings(workflow.config.workflow).output.candidates.map(({ nodeId, classType }) => ({ nodeId, classType })) };
    },
  }),
  defineScopedAgentTool({ name: 'integration_comfy_preview', scope: 'home', risk: 'read',
    schema: identity.extend({ suggestion: comfyConfigurationSuggestionSchema }).strict(),
    description: 'Validate new bindings/output selections against a real saved workflow and retain an opaque draftId with before/after preview. The Agent reasons itself; no nested model, workflow edits, execution or credential inputs. Apply only using returned draftId.',
    async execute(input, context) {
      const provider = comfyProvider(input.providerId);
      const workflow = readComfyUIWorkflows(provider).workflows.find((entry) => entry.id === input.workflowId);
      if (!workflow) throw new Error('指定工作流不存在。');
      const suggestion = validateComfyConfigurationSuggestion(input.suggestion, workflow.config.workflow);
      const draft: IntegrationDraft = { ...owner(context), kind: 'comfy', provider, workflowId: input.workflowId, suggestion };
      return { draftId: remember(draft), ...preview(draft) };
    },
  }),
  defineScopedAgentTool({ name: 'integration_comfy_apply', scope: 'home', risk: 'edit', schema: applySchema,
    description: 'After explicit approval, apply only the exact previously previewed bindings/output selections. Refuses stale or foreign drafts. Preserves workflow inputs, prompt text, connection and all credentials. Never executes/installs anything.',
    async execute(input, context) {
      const draft = readDraft(input.draftId, context);
      if (draft.kind !== 'comfy') throw new Error('草稿类型不匹配。');
      const provider = comfyProvider(draft.provider.id);
      if (provider !== draft.provider) throw new Error('ComfyUI 配置已变更，请重新读取并预览。');
      const collection = readComfyUIWorkflows(provider);
      const workflow = collection.workflows.find((entry) => entry.id === draft.workflowId)!;
      const checked = validateComfyConfigurationSuggestion(draft.suggestion, workflow.config.workflow);
      workflow.config = { ...workflow.config, bindings: checked.bindings, outputNodeIds: checked.outputNodeIds };
      drafts.delete(input.draftId);
      const next = withComfyUIWorkflows(provider, collection);
      // The complete original credential-bearing object stays local and unchanged.
      // Commit metadata synchronously, so no awaited vault migration can overwrite a newer edit.
      useCustomProvidersStore.setState((state) => {
        if (state.providers.find((entry) => entry.id === provider.id) !== provider) throw new Error('ComfyUI 配置已变更，请重新预览。');
        return { providers: state.providers.map((entry) => entry.id === provider.id ? next : entry) };
      });
      return { ok: true, providerId: provider.id, workflowId: workflow.id, changed: ['bindings', 'outputNodeIds'] };
    },
  }),
  defineScopedAgentTool({ name: 'integration_image_host_read', scope: 'home', risk: 'read', schema: z.strictObject({}),
    description: 'Read current image-host public endpoint/field names and enabled state, never header values, credential refs or URL queries. No upload or network call.',
    async execute() { return imageHostMetadata(useSettingsStore.getState().imageHostSettings); },
  }),
  defineScopedAgentTool({ name: 'integration_image_host_preview', scope: 'home', risk: 'read', schema: z.strictObject({ suggestion: imageHostSuggestionSchema }),
    description: 'Reason directly from user-provided public upload docs and preview a strict single POST multipart image-host draft. Only endpoint, file field, JSON result path and header names; never header values, secrets, enablement or extra model calls. Retains opaque draftId.',
    async execute(input, context) {
      const draft: IntegrationDraft = { ...owner(context), kind: 'image-host', settings: useSettingsStore.getState().imageHostSettings,
        suggestion: validateImageHostSuggestion(input.suggestion) };
      applyImageHostSuggestion(draft.settings, draft.suggestion);
      return { draftId: remember(draft), ...preview(draft) };
    },
  }),
  defineScopedAgentTool({ name: 'integration_image_host_apply', scope: 'home', risk: 'edit', schema: applySchema,
    description: 'After explicit approval, apply the exact retained image-host draft as DISABLED. Preserves old header values, adds only empty requested header names. Refuses stale/foreign drafts. Never uploads, enables, accepts credential values or calls another model.',
    async execute(input, context) {
      const draft = readDraft(input.draftId, context);
      if (draft.kind !== 'image-host') throw new Error('草稿类型不匹配。');
      const current = useSettingsStore.getState().imageHostSettings;
      if (current !== draft.settings) throw new Error('图床配置已变更，请重新读取并预览。');
      const next = applyImageHostSuggestion(current, draft.suggestion);
      drafts.delete(input.draftId);
      useSettingsStore.setState((state) => {
        if (state.imageHostSettings !== current) throw new Error('图床配置已变更，请重新预览。');
        return { imageHostSettings: next };
      });
      return { ok: true, ...imageHostMetadata(useSettingsStore.getState().imageHostSettings) };
    },
  }),
];
export const scopedIntegrationTools: ScopedAgentTool[] = (['home', 'stage', 'canvas'] as const).flatMap((scope) => homeTools.map((tool) => ({ ...tool, scope })));
