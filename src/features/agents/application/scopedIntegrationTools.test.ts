import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RunContext } from '@openai/agents';
import { useCustomProvidersStore, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { secretStore, secretToken } from '@/features/secrets/secretStore';
import { DEFAULT_IMAGE_HOST_SETTINGS } from '@/features/settings/imageHostSettings';
import { getScopedAgentTools, inspectScopedAgentTool } from './scopedAgentTools';
import { createScopedSdkTools } from './scopedAgentSdkTools';
import { prepareCanvasAgentToolApproval } from '@/features/canvas/agent/application/canvasAgentController';
import { canvasAgentApprovalStore } from '@/features/canvas/agent/application/agentApproval';
import { decideAgentAutoApproval } from '@/features/canvas/agent/application/agentAutoApprovalPolicy';
import { readComfyUIWorkflows } from '@/features/channels/application/comfyWorkflows';

const context = { projectId: 'integration-test', runId: 'run-config' };
const token = secretToken({ namespace: 'provider', id: 'fixture' });
const workflow = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'PRIVATE PROMPT', api_key: token } },
  '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: '/private/filename' } } };
const comfySuggestion = { bindings: { prompt: { nodeId: '1', input: 'text' } }, outputNodeIds: ['2'], explanation: 'Use text and save nodes.' };
const hostSuggestion = { uploadUrl: 'https://uploads.example/upload', fileField: 'file', responseUrlPath: 'data.url', headerNames: ['Authorization'], explanation: 'Documented multipart upload.' };
const provider = (): CustomProviderConfig => ({ id: 'fixture', label: 'Comfy fixture', apiStyle: 'comfyui', apiKey: token, baseUrl: 'http://127.0.0.1:8188', supportsWebSearch: false, models: ['saved'],
  extraHeaders: { 'X-Custom': token }, extraParams: { auth: { mode: 'bearer' }, comfyui: { workflow, outputNodeIds: ['2'] } } });
async function execute(name: string, input: unknown, scope: 'home' | 'stage' | 'canvas' = 'home', run = context) {
  const tool = getScopedAgentTools(scope).find((item) => item.name === name);
  if (!tool) throw new Error('Tool missing');
  return tool.execute(input, run);
}
const draftId = (result: unknown) => z.object({ draftId: z.string() }).parse(result).draftId;
beforeEach(() => {
  useCustomProvidersStore.setState({ providers: [provider()] });
  useSettingsStore.setState({ imageHostSettings: { ...DEFAULT_IMAGE_HOST_SETTINGS, enabled: true, uploadUrl: 'https://old.example/upload?token=PRIVATE_QUERY', extraHeaders: { Authorization: token } } });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); useCustomProvidersStore.setState({ providers: [] }); useSettingsStore.setState({ imageHostSettings: { ...DEFAULT_IMAGE_HOST_SETTINGS, extraHeaders: {} } }); });

describe('scoped integration configuration', () => {
  it.each(['home', 'stage', 'canvas'] as const)('exposes useful secret-free metadata and preview in %s', async (scope) => {
    const get = vi.spyOn(secretStore, 'get');
    const metadata = JSON.stringify(await execute('integration_list', {}, scope));
    const detail = JSON.stringify(await execute('integration_comfy_read', { providerId: 'fixture', workflowId: 'saved' }, scope));
    expect(metadata + detail).not.toMatch(/PRIVATE|__SC_SECRET_|private\/filename/);
    expect(detail).toContain('CLIPTextEncode'); expect(detail).toContain('nodeId'); expect(get).not.toHaveBeenCalled();
    const preview = await execute('integration_comfy_preview', { providerId: 'fixture', workflowId: 'saved', suggestion: comfySuggestion }, scope);
    expect(draftId(preview)).toBeTruthy();
    expect(readComfyUIWorkflows(useCustomProvidersStore.getState().providers[0]).workflows[0].config).toEqual({ workflow, outputNodeIds: ['2'] });
  });
  it('changes only existing workflow bindings and outputs, retaining all prompt and credential values', async () => {
    const get = vi.spyOn(secretStore, 'get'); const set = vi.spyOn(secretStore, 'set');
    const original = useCustomProvidersStore.getState().providers[0];
    const id = draftId(await execute('integration_comfy_preview', { providerId: 'fixture', workflowId: 'saved', suggestion: comfySuggestion }));
    await execute('integration_comfy_apply', { draftId: id });
    const saved = useCustomProvidersStore.getState().providers[0];
    expect(readComfyUIWorkflows(saved).workflows[0].config).toMatchObject({ workflow, bindings: comfySuggestion.bindings, outputNodeIds: comfySuggestion.outputNodeIds });
    expect(saved.apiKey).toBe(original.apiKey); expect(saved.extraHeaders).toEqual(original.extraHeaders); expect(saved.baseUrl).toBe(original.baseUrl);
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
    await expect(execute('integration_comfy_apply', { draftId: id })).rejects.toThrow(/失效/);
  });
  it('rejects forged nodes, credential inputs and Agent-supplied secret fields', async () => {
    for (const input of ['api_key', 'missing']) await expect(execute('integration_comfy_preview', { providerId: 'fixture', workflowId: 'saved',
      suggestion: { ...comfySuggestion, bindings: { prompt: { nodeId: '1', input } } } })).rejects.toThrow();
    expect(() => inspectScopedAgentTool('home', 'integration_image_host_preview', { suggestion: { ...hostSuggestion, extraHeaders: { Authorization: 'private' } } })).toThrow();
    expect(() => inspectScopedAgentTool('home', 'integration_comfy_apply', { draftId: 'x', workflow: {} })).toThrow();
  });
  it('rejects drafts from another run, expired drafts and configuration changes since preview', async () => {
    const first = draftId(await execute('integration_image_host_preview', { suggestion: hostSuggestion }));
    await expect(execute('integration_image_host_apply', { draftId: first }, 'home', { ...context, runId: 'foreign' })).rejects.toThrow(/不属于/);
    useSettingsStore.setState({ imageHostSettings: { ...useSettingsStore.getState().imageHostSettings, fileField: 'user-edit' } });
    await expect(execute('integration_image_host_apply', { draftId: first })).rejects.toThrow(/已变更/);
    vi.useFakeTimers(); const second = draftId(await execute('integration_image_host_preview', { suggestion: hostSuggestion }));
    vi.advanceTimersByTime(31 * 60_000);
    await expect(execute('integration_image_host_apply', { draftId: second })).rejects.toThrow(/失效/);
  });
  it('rejects a Comfy draft after the actual workflow changes without overwriting the user edit', async () => {
    const id = draftId(await execute('integration_comfy_preview', { providerId: 'fixture', workflowId: 'saved', suggestion: comfySuggestion }));
    const current = useCustomProvidersStore.getState().providers[0];
    const collection = readComfyUIWorkflows(current); collection.workflows[0].name = 'User renamed';
    useCustomProvidersStore.setState({ providers: [{ ...current, comfyWorkflows: collection }] });
    await expect(execute('integration_comfy_apply', { draftId: id })).rejects.toThrow(/已变更/);
    expect(readComfyUIWorkflows(useCustomProvidersStore.getState().providers[0]).workflows[0].name).toBe('User renamed');
  });
  it.each(['home', 'stage', 'canvas'] as const)('keeps Comfy configuration writes explicitly approved in %s auto mode', async (scope) => {
    const id = draftId(await execute('integration_comfy_preview', { providerId: 'fixture', workflowId: 'saved', suggestion: comfySuggestion }, scope));
    const approval = await prepareCanvasAgentToolApproval({ ...context, scope, callId: `comfy-${scope}`, toolName: 'integration_comfy_apply', arguments: { draftId: id }, persist: false });
    expect(decideAgentAutoApproval(approval).allowed).toBe(false);
    expect(approval.record.impact.summary).toContain('outputNodeIds');
    expect(approval.record.impact.summary).not.toMatch(/PRIVATE PROMPT|__SC_SECRET_/);
  });
  it('requires explicit approval in auto mode and applies via the canvas SDK bridge without a canvas checkpoint', async () => {
    const id = draftId(await execute('integration_image_host_preview', { suggestion: hostSuggestion }, 'canvas'));
    const args = { draftId: id }; const name = 'integration_image_host_apply'; const callId = 'apply-image-host';
    const approval = await prepareCanvasAgentToolApproval({ ...context, scope: 'canvas', callId, toolName: name, arguments: args, persist: false });
    expect(decideAgentAutoApproval(approval).allowed).toBe(false);
    expect(approval.record.impact.summary).toContain('https://uploads.example/upload');
    expect(approval.record.impact.summary).not.toContain(token);
    canvasAgentApprovalStore.put(approval.record);
    const checkpoint = vi.fn(); const sdkContext = { ...context, getActiveProjectId: () => context.projectId, persistCanvasCheckpoint: checkpoint };
    const tool = createScopedSdkTools('canvas', sdkContext, false).find((item) => item.name === name)!;
    const details = { toolCall: { type: 'function_call' as const, callId, name, arguments: JSON.stringify(args) } };
    await tool.invoke(new RunContext(sdkContext), JSON.stringify(args), details);
    expect(useSettingsStore.getState().imageHostSettings.enabled).toBe(true);
    canvasAgentApprovalStore.update(approval.record.id, { status: 'approved' });
    await tool.invoke(new RunContext(sdkContext), JSON.stringify(args), details);
    expect(useSettingsStore.getState().imageHostSettings).toMatchObject({ enabled: false, uploadUrl: hostSuggestion.uploadUrl, extraHeaders: { Authorization: token } });
    expect(checkpoint).not.toHaveBeenCalled();
  });
});
