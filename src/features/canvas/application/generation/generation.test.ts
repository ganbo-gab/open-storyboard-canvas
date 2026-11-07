import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { CANVAS_NODE_TYPES } from '../../domain/canvasNodes';
import type { GenerateImagePayload, GenerateVideoPayload } from '../ports';
import { submitNodeGeneration, previewNodeGenerationRequest, cancelNodeGeneration, retryGenerationWithHostedReference } from './index';
import { showErrorDialog } from '../errorDialog';
import { ReferenceNeedsPublicUrlError } from '@/features/channels/domain/referenceErrors';
import legacyAssemblers from './__fixtures__/legacyNodeAssemblers.json';
import { stripTypeScriptTypes } from 'node:module';
import { t } from 'i18next';
import { isImageEditNode, isAiVideoNode } from '../../domain/canvasNodes';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { collectInputReferences, buildReferenceContextPrompt, normalizeReferenceTokensForSubmission } from '../graphReferenceResolver';
import { getImageModel, resolveImageModelResolution } from '../../models';
import { getLocalDateStamp, resolveNextGeneratedMediaSequence } from '../generatedMediaNaming';
import { normalizeImageRequestGeometry } from '../imageRequestGeometry';
import { appendGenerationParameterConstraints } from '../generationPromptConstraints';
import { DEFAULT_VIDEO_INPUT_SCHEMA, normalizeVideoInputSchema, getVideoReferenceOverflow } from '../videoInputSchema';
import type * as CanvasServices from '../canvasServices';
import type * as ImageVariantUtilities from './imageVariants';
import { useChannelStore } from '@/features/channels/store/channelStore';
import { openAIStandardProfile } from '@/features/channels/presets/openai';
import type * as ChannelExecution from '@/features/channels/runtime/channelExecution';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
import { CanvasGenerationFacade } from '../canvasGenerationFacade';

class ProviderFailure extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
  }
}

/** Original callbacks captured before the component cutover; execute behavior, not source wiring assertions. */
function captureNodeAssembler(file: keyof typeof legacyAssemblers, environment: Record<string, unknown>) {
  const compiled = stripTypeScriptTypes(`const assemble = ${legacyAssemblers[file].callback};`);
  const run = new Function(...Object.keys(environment), `${compiled}\nreturn assemble();`);
  return run(...Object.values(environment));
}

const mocks = vi.hoisted(() => ({
  image: vi.fn(), video: vi.fn(), stream: vi.fn(), text: vi.fn(), imageModel: vi.fn(), videoCatalog: vi.fn(), chatCatalog: vi.fn(), channelSubmit: vi.fn(), channelPoll: vi.fn(), hostUpload: vi.fn(),
}));
vi.mock('../canvasServices', async importOriginal => {
  const original = await importOriginal<typeof CanvasServices>();
  return { ...original,
    canvasAiGateway: { ...original.canvasAiGateway, submitGenerateImageJob: mocks.image },
    canvasVideoGateway: { ...original.canvasVideoGateway, submitGenerateVideoJob: mocks.video },
    buildImageGenerationDebugPreview: async (payload: GenerateImagePayload) => ({ gatewayRequest: payload, route: 'test', providerRequest: payload }),
    buildVideoGenerationDebugPreview: async (payload: GenerateVideoPayload) => ({ gatewayRequest: payload, route: 'test', providerRequest: payload }),
  };
});
vi.mock('../resolveActiveModelForPanel', () => ({ resolveActiveModelForPanel: mocks.imageModel }));
vi.mock('../videoModelCatalog', () => ({ buildVideoModelCatalog: mocks.videoCatalog, resolveVideoModelConfig: (_catalog: unknown, config: unknown) => config }));
vi.mock('../chatModelCatalog', () => ({ buildChatModelCatalog: mocks.chatCatalog }));
vi.mock('../errorDialog', () => ({ resolveErrorContent: (error: unknown) => ({message: error instanceof Error ? error.message : String(error)}), showErrorDialog: vi.fn() }));
vi.mock('@/features/channels/runtime/channelChat', () => ({
  buildCustomChatCompletionRequestDebugPreview: (_id: string, payload: unknown) => payload,
  streamCustomChatCompletion: mocks.stream,
  submitCustomChatCompletion: mocks.text,
}));
vi.mock('./imageVariants', async original => ({ ...await original<typeof ImageVariantUtilities>(), generateGridImageDataUrl: () => 'data:image/png;base64,GRID' }));
vi.mock('../panoramaNormalize', () => ({ createWhite2x1DataUrl: () => 'data:image/png;base64,WHITE', selectPanoramaRequestRatio: () => '2:1', prepareLocalPanoramaSource: async () => ({imageUrl: '/panorama.png', aspectRatio: '2:1'}) }));
vi.mock('@/features/channels/runtime/channelExecution', async (importOriginal) => ({
  ...await importOriginal<typeof ChannelExecution>(), submitChannelJob: mocks.channelSubmit, getChannelJobAsync: mocks.channelPoll,
}));
vi.mock('../imageHosting', () => ({ uploadImageToConfiguredHost: mocks.hostUpload }));

function source(type: typeof CANVAS_NODE_TYPES[keyof typeof CANVAS_NODE_TYPES], data = {}) {
  return useCanvasStore.getState().addNode(type, { x: -10000, y: -10000 }, data);
}

beforeEach(() => {
  vi.clearAllMocks();
  useCanvasStore.setState({ nodes: [], edges: [], revision: 0, selectedNodeId: null, history: { past: [], future: [] }, dragHistorySnapshot: null });
  useSettingsStore.setState({ appendParameterConstraintsToPrompt: false, enableAiTextStreaming: true });
  useChannelStore.setState({ channels: [] });
  mocks.image.mockResolvedValue('image-job');
  mocks.video.mockResolvedValue('video-job');
  mocks.channelSubmit.mockResolvedValue('custom-local-channel-job-audio');
  mocks.channelPoll.mockResolvedValue({ job_id: 'custom-local-channel-job-audio', media_type: 'audio', status: 'succeeded',
    results: [{ kind: 'audio', source: '/first.wav' }, { kind: 'audio', source: '/second.wav' }, { kind: 'text', source: 'Transcript' }] });
  mocks.imageModel.mockReturnValue({ entryId: 'custom:test:image', modelForGateway: 'custom:test:image', providerId: 'test', providerLabel: 'Test', ratio: '16:9', builtinModel: null, apiKey: 'key', requiresApiKey: true, usable: true, resolvedByFallback: false, extraParams: { resolutionType: '2K' }, supportedRatios: ['16:9', '1:1'] });
  mocks.videoCatalog.mockReturnValue([{ id: 'custom:test:video', modelId: 'video', providerId: 'test', usable: true, inputSchema: { images: { enabled: true, min: 0, max: 9 }, video: { enabled: true, min: 0, max: 3 }, audio: { enabled: true, min: 0, max: 3 } } }]);
  mocks.chatCatalog.mockReturnValue([{ id: 'custom:test:text', providerId: 'test', providerLabel: 'Test', modelId: 'text', modelLabel: 'Text', supportsMultimodal: true, usable: true }]);
});

describe('render-independent canvas generation', () => {
  it('refuses disabled generation and tool sources before allocating results or contacting providers', async () => {
    const id = source(CANVAS_NODE_TYPES.imageEdit, { enabled: false, prompt: 'Do not submit' });
    const before = useCanvasStore.getState();
    expect(await submitNodeGeneration(id)).toMatchObject({ ok: false, nodeId: id, reason: 'disabled' });
    expect(await submitNodeGeneration(id, { tool: { id: 'crop' } })).toMatchObject({ ok: false, reason: 'disabled' });
    expect(useCanvasStore.getState().nodes).toBe(before.nodes);
    expect(useCanvasStore.getState().edges).toBe(before.edges);
    expect(mocks.image).not.toHaveBeenCalled();
    expect(mocks.video).not.toHaveBeenCalled();
    expect(mocks.channelSubmit).not.toHaveBeenCalled();
  });
  it('submits an off-screen image batch without mounting a component and connects three results', async () => {
    const id = source(CANVAS_NODE_TYPES.imageEdit, { prompt: 'A crane at sunset', modelConfig: {entryId: 'custom:test:image', ratio: '16:9'} });
    const result = await submitNodeGeneration(id, {count: 3});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.resultNodeIds).toHaveLength(3);
    expect(mocks.image).toHaveBeenCalledTimes(3);
    const state = useCanvasStore.getState();
    expect(state.edges.filter(edge => edge.source === id).map(edge => edge.target)).toEqual(result.resultNodeIds);
    const results = state.nodes.filter(node => result.resultNodeIds.includes(node.id));
    expect(results.map(node => node.data.batchIndex)).toEqual([0, 1, 2]);
    expect(new Set(results.map(node => node.data.batchId)).size).toBe(1);
    expect(results.every(node => node.data.batchTotal === 3 && node.data.generationJobId === 'image-job')).toBe(true);
    expect(mocks.image.mock.calls[0][0]).toEqual({ prompt: 'A crane at sunset', model: 'custom:test:image', size: '2K', aspectRatio: '16:9', referenceImages: [], extraParams: {resolutionType: '2K'} });
  });
  it('submits one native-count job and connects an indexed placeholder for every requested output', async () => {
    useChannelStore.setState({ channels: [{ origin: 'native', profile: openAIStandardProfile, migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
    mocks.imageModel.mockReturnValue({ ...mocks.imageModel(), entryId: 'custom:openai-standard:gpt-image-1', modelForGateway: 'custom:openai-standard:gpt-image-1', providerId: 'openai-standard', extraParams: { n: 2 } });
    const id = source(CANVAS_NODE_TYPES.imageEdit, { prompt: 'A crane', modelConfig: { entryId: 'custom:openai-standard:gpt-image-1', ratio: '1:1' } });
    const preview = await previewNodeGenerationRequest(id, { count: 3 });
    const result = await submitNodeGeneration(id, { count: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.jobIds).toEqual(['image-job']);
    expect(result.resultNodeIds).toHaveLength(3);
    expect(mocks.image).toHaveBeenCalledOnce();
    expect(mocks.image.mock.calls[0][0]).toMatchObject({ extraParams: { n: 3 } });
    expect(preview).toMatchObject({ gatewayRequest: { extraParams: { n: 3 } } });
    const nodes = useCanvasStore.getState().nodes.filter((node) => result.resultNodeIds.includes(node.id));
    expect(nodes.map((node) => node.data.batchIndex)).toEqual([0, 1, 2]);
    expect(nodes.every((node) => node.data.generationJobId === 'image-job')).toBe(true);
  });
  it.each([{ configured: 2, expected: 2 }, { configured: undefined, expected: 3 }])('uses native configured/default count $expected when no outer count is supplied', async ({ configured, expected }) => {
    const profile = { ...openAIStandardProfile, models: openAIStandardProfile.models.map((model) => ({ ...model,
      params: model.params.map((param) => param.key === 'n' ? { ...param, default: 3 } : param) })) };
    useChannelStore.setState({ channels: [{ origin: 'native', profile, migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
    mocks.imageModel.mockReturnValue({ ...mocks.imageModel(), entryId: 'custom:openai-standard:gpt-image-1',
      modelForGateway: 'custom:openai-standard:gpt-image-1', providerId: 'openai-standard', extraParams: configured === undefined ? {} : { n: configured } });
    const id = source(CANVAS_NODE_TYPES.imageEdit, { prompt: 'A crane' });
    const preview = await previewNodeGenerationRequest(id);
    const result = await submitNodeGeneration(id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.resultNodeIds).toHaveLength(expected);
    expect(mocks.image).toHaveBeenCalledOnce();
    expect(mocks.image.mock.calls[0][0]).toMatchObject({ extraParams: { n: expected } });
    expect(preview).toMatchObject({ gatewayRequest: { extraParams: { n: expected } } });
  });

  it('returns busy for both stored generation state and overlapping submit calls', async () => {
    const busy = source(CANVAS_NODE_TYPES.aiVideo, {isGenerating: true});
    expect(await submitNodeGeneration(busy)).toMatchObject({ok: false, reason: 'busy'});
    let finish!: (id: string) => void;
    mocks.image.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
    const id = source(CANVAS_NODE_TYPES.imageEdit, {prompt: 'Crane'});
    const first = submitNodeGeneration(id);
    expect(await submitNodeGeneration(id)).toMatchObject({ok: false, reason: 'busy'});
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish('job');
    expect((await first).ok).toBe(true);
  });

  it('returns missing-model before creating any result', async () => {
    mocks.chatCatalog.mockReturnValue([]);
    const id = source(CANVAS_NODE_TYPES.aiText, {prompt: 'Hello'});
    expect(await submitNodeGeneration(id)).toMatchObject({ok: false, reason: 'missing-model'});
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });

  it('creates a video result carrying the submitted job and identical preview payload', async () => {
    const id = source(CANVAS_NODE_TYPES.aiVideo, {prompt: 'Slow dolly', modelConfig: {entryId: 'custom:test:video', resolution: '1280x720', duration: '5', aspectRatio: '16:9', extraParams: {seed: 7}}});
    const preview = await previewNodeGenerationRequest(id);
    const result = await submitNodeGeneration(id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const output = useCanvasStore.getState().nodes.find(node => node.id === result.resultNodeIds[0]);
    expect(output).toMatchObject({type: CANVAS_NODE_TYPES.video, data: {generationJobId: 'video-job', aspectRatio: '16:9', durationSeconds: 5, sourcePrompt: 'Slow dolly'}});
    expect(preview).toMatchObject({gatewayRequest: mocks.video.mock.calls[0][0]});
    expect(mocks.video.mock.calls[0][0]).toMatchObject({prompt: 'Slow dolly', model: 'custom:test:video', size: '1280x720', seconds: 5, aspectRatio: '16:9', referenceImages: [], referenceVideos: [], referenceAudios: [], extraParams: {seed: 7}});
  });

  it.each([CANVAS_NODE_TYPES.imageEdit, CANVAS_NODE_TYPES.aiVideo])('normalizes persisted mode fields and uses them for %s preview and submission', async (type) => {
    const id = source(type, { prompt: 'Frames', channelModeId: 'frames',
      referenceSlots: { first_frame: ['/first.png', 4, null, ''], last_frame: ['/last.png'], empty: [], invalid: false },
      modelConfig: type === CANVAS_NODE_TYPES.aiVideo
        ? { entryId: 'custom:test:video', resolution: '1280x720', duration: '5', aspectRatio: '16:9' }
        : { entryId: 'custom:test:image', ratio: '16:9' } });
    const state = useCanvasStore.getState();
    state.setCanvasData(state.nodes, state.edges);
    const referenceSlots = { first_frame: ['/first.png'], last_frame: ['/last.png'] };
    expect(useCanvasStore.getState().nodes.find((node) => node.id === id)?.data).toMatchObject({ channelModeId: 'frames', referenceSlots });
    const preview = await previewNodeGenerationRequest(id);
    expect(await submitNodeGeneration(id)).toMatchObject({ ok: true });
    const payload = (type === CANVAS_NODE_TYPES.aiVideo ? mocks.video : mocks.image).mock.calls[0][0];
    expect(payload).toMatchObject({ channelModeId: 'frames', referenceSlots });
    expect(preview).toMatchObject({ gatewayRequest: payload });
  });

  it('streams text into a connected JSON result and retains diagnostics', async () => {
    mocks.stream.mockImplementation(async (_id, _payload, options) => {
      options.onTextDelta('{"shot":', '{"shot":');
      const output = useCanvasStore.getState().nodes.find(node => node.type === CANVAS_NODE_TYPES.jsonCard);
      expect(output?.data).toMatchObject({isStreaming: true, streamReceivedCharacters: 8});
      return {text: '{"shot":"wide"}', finishReason: 'stop', status: 200};
    });
    const id = source(CANVAS_NODE_TYPES.aiText, {prompt: 'Return a shot'});
    const result = await submitNodeGeneration(id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const output = useCanvasStore.getState().nodes.find(node => node.id === result.resultNodeIds[0]);
    expect(output?.data).toMatchObject({rawContent: '{"shot":"wide"}', parsedJson: {shot: 'wide'}, isGenerating: false, isStreaming: false});
    expect(mocks.text).not.toHaveBeenCalled();
  });

  it('does not retry an ambiguous interrupted stream', async () => {
    mocks.stream.mockRejectedValue(new Error('Connection closed after send'));
    const id = source(CANVAS_NODE_TYPES.aiText, {prompt: 'Hello'});
    expect(await submitNodeGeneration(id)).toMatchObject({ok: false, reason: 'failed'});
    expect(mocks.text).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes.find(node => node.type === CANVAS_NODE_TYPES.jsonCard)?.data.isGenerating).toBe(false);
  });

  it.each(['input_moderation', 'output_moderation'] as const)('persists %s on a rejected result without resubmitting', async (category) => {
    mocks.image.mockRejectedValue(new ProviderFailure('Provider rejected the request',
      { failure_reason: category, retryable: true }));
    const id = source(CANVAS_NODE_TYPES.imageEdit, { prompt: 'Original shot' });
    expect(await submitNodeGeneration(id)).toMatchObject({ ok: false, reason: 'failed' });
    const state = useCanvasStore.getState();
    const output = state.nodes.find((node) => node.type === CANVAS_NODE_TYPES.exportImage);
    expect(output?.data).toMatchObject({ isGenerating: false, generationJobId: null,
      generationFailure: { category, retryable: false, moderation: true } });
    expect(new CanvasGenerationFacade().getStatus(state.nodes, state.edges, { nodeId: id }))
      .toMatchObject({ status: 'failed', failure: { category, retryable: false, moderation: true } });
    expect(mocks.image).toHaveBeenCalledOnce();
  });

  it('uses the exact image preview request for send', async () => {
    const id = source(CANVAS_NODE_TYPES.imageEdit, {prompt: 'A paper boat'});
    const preview = await previewNodeGenerationRequest(id);
    await submitNodeGeneration(id);
    expect(preview).toMatchObject({gatewayRequest: mocks.image.mock.calls[0][0], providerRequest: mocks.image.mock.calls[0][0]});
  });

  it('executes a selected v2 audio catalog model without local settings and publishes every typed output', async () => {
    const profile: ChannelProfileV2 = { version: 2, id: 'voice-channel', name: 'Voice', baseUrl: 'https://voice.test', auth: { type: 'none' },
      operations: { 'audio.generate': { method: 'POST', path: '/audio', body: 'json', template: { text: '{{prompt}}', voice: '{{param.voice}}' },
        response: { mode: 'sync', outputs: [{ path: 'url', as: 'url', kind: 'audio' }] } } },
      models: [{ id: 'speaker', operations: [], params: [{ key: 'voice', label: 'Voice', type: 'text', default: 'calm' }],
        modes: [{ id: 'speech', label: 'Speech', operation: 'audio.generate', slots: [] }] }] };
    useChannelStore.setState({ channels: [{ origin: 'native', profile, migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
    const retired = source(CANVAS_NODE_TYPES.aiAudio, { prompt: 'Keep my old result', modelId: 'local-doubao-tts', resultNodeId: 'previous-audio' });
    const originalNodes = useCanvasStore.getState().nodes.length;
    expect(await submitNodeGeneration(retired)).toMatchObject({ ok: false, reason: 'missing-model' });
    expect(mocks.channelSubmit).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes).toHaveLength(originalNodes);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === retired)?.data).toMatchObject({ modelId: 'local-doubao-tts', resultNodeId: 'previous-audio' });
    const id = source(CANVAS_NODE_TYPES.aiAudio, { prompt: 'Hello', modelId: 'custom:channel-voice-channel-audio:speaker', channelModeId: 'speech' });
    const preview = await previewNodeGenerationRequest(id);
    expect(preview).toMatchObject({ body: { json: { text: 'Hello', voice: 'calm' } } });
    const result = await submitNodeGeneration(id);
    expect(result).toMatchObject({ ok: true, jobIds: ['custom-local-channel-job-audio'] });
    if (!result.ok) throw new Error(result.message);
    expect(result.resultNodeIds).toHaveLength(3);
    expect(mocks.channelSubmit).toHaveBeenCalledWith(profile, expect.objectContaining({ operation: 'audio.generate', modeId: 'speech', params: { voice: 'calm' } }));
    const outputs = result.resultNodeIds.map((nodeId) => useCanvasStore.getState().nodes.find((node) => node.id === nodeId));
    expect(outputs.map((node) => node?.type)).toEqual([CANVAS_NODE_TYPES.audio, CANVAS_NODE_TYPES.audio, CANVAS_NODE_TYPES.jsonCard]);
    expect(outputs[0]?.data).toMatchObject({ audioUrl: '/first.wav', isGenerating: false });
    expect(outputs[1]?.data.audioUrl).toBe('/second.wav');
    expect(outputs[2]?.data.rawContent).toBe('Transcript');
  });
  it('uses the audio operation for a multi-operation channel model without explicit modes', async () => {
    const operation = { method: 'POST' as const, path: '/audio', body: 'json' as const, template: { text: '{{prompt}}' },
      response: { mode: 'sync' as const, outputs: [{ path: 'url', as: 'url' as const, kind: 'audio' as const }] } };
    const profile: ChannelProfileV2 = { version: 2, id: 'mixed-channel', name: 'Mixed', baseUrl: 'https://voice.test', auth: { type: 'none' },
      operations: { chat: operation, 'audio.generate': operation },
      models: [{ id: 'speaker', operations: ['chat', 'audio.generate'], params: [] }] };
    useChannelStore.setState({ channels: [{ origin: 'native', profile, migrationIssues: [], createdAt: 1, updatedAt: 1 }] });
    const id = source(CANVAS_NODE_TYPES.aiAudio, { prompt: 'Hello', modelId: 'custom:channel-mixed-channel-audio:speaker' });
    expect(await submitNodeGeneration(id)).toMatchObject({ ok: true });
    expect(mocks.channelSubmit).toHaveBeenCalledWith(profile, expect.objectContaining({ operation: 'audio.generate' }));
  });

  it('captures the original mounted-node image and video assemblers for payload parity', async () => {
    const id = source(CANVAS_NODE_TYPES.imageEdit, {prompt: 'A crane at sunset', modelConfig: {entryId: 'custom:test:image', ratio: '16:9'}});
    const imageNode = useCanvasStore.getState().nodes.find(node => node.id === id)!;
    const common = { useCanvasStore, useSettingsStore, useCustomProvidersStore, collectInputReferences, buildReferenceContextPrompt, normalizeReferenceTokensForSubmission, t, setError: vi.fn(), showErrorDialog: vi.fn(), flushPromptDraft: vi.fn(), normalizeImageRequestGeometry, appendGenerationParameterConstraints };
    const capturedImage = await captureNodeAssembler('ImageEditNode.tsx', {
      ...common, id, data: imageNode.data, promptDraftRef: {current: 'A crane at sunset'}, isImageEditNode, effectiveExtraParams: {}, selectedResolution: resolveImageModelResolution(getImageModel(''), undefined), nodeModelConfig: null,
      resolveActiveModelForPanel: mocks.imageModel, customCount: '', generateCount: 3, getLocalDateStamp, resolveNextGeneratedMediaSequence, setShowCountPicker: vi.fn(),
    });
    await submitNodeGeneration(id, {count: 3});
    expect(mocks.image.mock.calls[0][0]).toEqual(capturedImage.gatewayPayload);
    const videoId = source(CANVAS_NODE_TYPES.aiVideo, {prompt: 'Slow dolly', modelConfig: {entryId: 'custom:test:video', resolution: '1280x720', duration: '5', aspectRatio: '16:9', extraParams: {seed: 7}}});
    const capturedVideo = await captureNodeAssembler('AiVideoNode.tsx', {
      ...common, id: videoId, data: useCanvasStore.getState().nodes.find(node => node.id === videoId)!.data, promptDraftRef: {current: 'Slow dolly'}, isAiVideoNode,
      buildVideoModelCatalog: mocks.videoCatalog, resolveVideoModelConfig: (_catalog: unknown, config: unknown) => config, resolvedModelConfig: null,
      resolveConfigEntry: (catalog: Array<{id: string}>, config: {entryId: string}) => catalog.find(entry => entry.id === config.entryId),
      resolveEntryInputSchema: (entry: {inputSchema: unknown}) => normalizeVideoInputSchema(entry.inputSchema, DEFAULT_VIDEO_INPUT_SCHEMA), getVideoReferenceOverflow,
      aspectRatioFromPixelResolution: () => '16:9',
    });
    await submitNodeGeneration(videoId);
    expect(mocks.video.mock.calls[0][0]).toEqual(capturedVideo.gatewayPayload);
  });

  it('stops local waiting without clearing the recoverable job id or contacting upstream', async () => {
    const id = source(CANVAS_NODE_TYPES.imageEdit, {prompt: 'Boat'});
    const result = await submitNodeGeneration(id);
    if (!result.ok) throw new Error(result.message);
    cancelNodeGeneration(id);
    expect(useCanvasStore.getState().nodes.find(node => node.id === result.resultNodeIds[0])?.data).toMatchObject({isGenerating: false, generationJobId: 'image-job'});
  });

  it('creates storyboard output with grid reference and recovery metadata', async () => {
    useSettingsStore.setState({storyboardGenKeepStyleConsistent: true, storyboardGenDisableTextInImage: true, storyboardGenAutoInferEmptyFrame: true});
    const id = source(CANVAS_NODE_TYPES.storyboardGen, {gridRows: 1, gridCols: 2, frames: [{id: 'frame-1', description: '开场远景'}, {id: 'frame-2', description: ''}], modelConfig: {entryId: 'custom:test:image', ratio: '16:9'}});
    const result = await submitNodeGeneration(id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(mocks.image.mock.calls[0][0]).toMatchObject({referenceImages: ['data:image/png;base64,GRID'], prompt: expect.stringContaining('分镜2：依据之前的内容进行推测')});
    expect(useCanvasStore.getState().nodes.find(node => node.id === result.resultNodeIds[0])?.data).toMatchObject({resultKind: 'storyboardGenOutput', generationSourceType: 'storyboardGen', generationStoryboardMetadata: {gridRows: 1, gridCols: 2, frameNotes: ['开场远景', '']}});
  });

  it('submits text panorama into the existing node and supports local-image conversion without a paid request', async () => {
    const id = source(CANVAS_NODE_TYPES.panorama, {sourcePrompt: 'An empty hall', smartBase: true});
    expect(await submitNodeGeneration(id)).toMatchObject({ok: true, resultNodeIds: [id], jobIds: ['image-job']});
    expect(mocks.image.mock.calls[0][0]).toMatchObject({prompt: 'An empty hall', aspectRatio: '2:1', referenceImages: ['data:image/png;base64,WHITE']});
    const local = source(CANVAS_NODE_TYPES.panorama, {sourceMode: 'image', sourceImageUrl: '/source.png'});
    expect(await submitNodeGeneration(local)).toMatchObject({ok: true, resultNodeIds: [local], jobIds: []});
    expect(useCanvasStore.getState().nodes.find(node => node.id === local)?.data).toMatchObject({imageUrl: '/panorama.png', isGenerating: false});
    expect(mocks.image).toHaveBeenCalledTimes(1);
  });

  it('uses the selected toolbar prompt/model while taking the source image from the current graph', async () => {
    const id = source(CANVAS_NODE_TYPES.upload, {imageUrl: '/source.png', aspectRatio: '3:2'});
    const result = await submitNodeGeneration(id, {tool: {id: 'lighting', prompt: 'Soft key light'}});
    expect(result.ok).toBe(true);
    expect(mocks.imageModel).toHaveBeenCalledWith('lighting', undefined);
    expect(mocks.image.mock.calls[0][0]).toMatchObject({prompt: 'Soft key light', referenceImages: ['/source.png']});
  });

  it('clears every failed batch result and retains diagnostic context without retrying', async () => {
    mocks.image.mockRejectedValue(new Error('Network closed after send'));
    const id = source(CANVAS_NODE_TYPES.imageEdit, {prompt: 'Boat'});
    expect(await submitNodeGeneration(id, {count: 3})).toMatchObject({ok: false, reason: 'failed'});
    expect(mocks.image).toHaveBeenCalledTimes(3);
    const results = useCanvasStore.getState().nodes.filter(node => node.type === CANVAS_NODE_TYPES.exportImage);
    expect(results).toHaveLength(3);
    expect(results.every(node => node.data.isGenerating === false && node.data.generationJobId === null && node.data.generationError === 'Network closed after send')).toBe(true);
  });

  it('keeps a local-slot rejection on the failed result and resubmits only after hosting that slot', async () => {
    mocks.image.mockRejectedValueOnce(new ReferenceNeedsPublicUrlError({ kind: 'image', slot: 'first_frame' }));
    mocks.hostUpload.mockResolvedValue('https://host.test/first.png');
    const id = source(CANVAS_NODE_TYPES.imageEdit, { prompt: 'Frames', channelModeId: 'frames', referenceSlots: { first_frame: ['/first.png'] },
      modelConfig: { entryId: 'custom:test:image', ratio: '16:9' } });
    expect(await submitNodeGeneration(id)).toMatchObject({ ok: false, reason: 'failed' });
    const [failed] = useCanvasStore.getState().nodes.filter(node => node.type === CANVAS_NODE_TYPES.exportImage);
    expect(failed.data.generationReferenceFailure).toEqual({ sourceNodeId: id, slotKey: 'first_frame', slotKind: 'image' });
    expect(showErrorDialog).not.toHaveBeenCalled();
    expect(mocks.hostUpload).not.toHaveBeenCalled();
    expect(await retryGenerationWithHostedReference(failed.id, { confirmed: true })).toMatchObject({ ok: true });
    const state = useCanvasStore.getState();
    expect(state.nodes.find(node => node.id === id)?.data.referenceSlots).toEqual({ first_frame: ['https://host.test/first.png'] });
    expect(state.nodes.some(node => node.id === failed.id)).toBe(false);
    expect(mocks.image).toHaveBeenCalledTimes(2);
    expect(mocks.image).toHaveBeenLastCalledWith(expect.objectContaining({ referenceSlots: { first_frame: ['https://host.test/first.png'] } }));
  });

  it('rejects missing credentials and an empty prompt before paid submission', async () => {
    const id = source(CANVAS_NODE_TYPES.imageEdit, {prompt: ''});
    expect(await submitNodeGeneration(id)).toMatchObject({ok: false, reason: 'empty-prompt'});
    useCanvasStore.getState().updateNodeData(id, {prompt: 'Boat'});
    const resolved = mocks.imageModel();
    mocks.imageModel.mockReturnValue({...resolved, apiKey: '', usable: false});
    expect(await submitNodeGeneration(id)).toMatchObject({ok: false, reason: 'missing-credentials'});
    expect(mocks.image).not.toHaveBeenCalled();
  });
});
