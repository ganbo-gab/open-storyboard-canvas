import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, EXPORT_RESULT_NODE_DEFAULT_WIDTH, EXPORT_RESULT_NODE_LAYOUT_HEIGHT, readGenerationReferenceFailure, type CanvasNodeType } from '../../domain/canvasNodes';
import { canvasAiGateway, canvasVideoGateway, buildImageGenerationDebugPreview, buildVideoGenerationDebugPreview } from '../canvasServices';
import { resolveErrorContent, showErrorDialog } from '../errorDialog';
import { acquireGenerationSubmitLock, generationSubmitLockKey } from '../generationSubmitLock';
import { buildGenerationErrorReport, classifyGenerationFailure, CURRENT_RUNTIME_SESSION_ID, createReferenceImagePlaceholders, getRuntimeDiagnostics, type GenerationDebugContext } from '../generationErrorReport';
import { getLocalDateStamp, resolveNextGeneratedMediaSequence, resolveDefaultGeneratedImageDisplayName, resolveDefaultGeneratedImageFileStem, resolveDefaultGeneratedVideoDisplayName, resolveDefaultGeneratedVideoFileStem } from '../generatedMediaNaming';
import { assembleImageRequest } from './imageRequest';
import { assembleVideoRequest } from './videoRequest';
import { assembleStoryboardRequest, assemblePanelRequest } from './imageVariantRequests';
import { assembleTextRequest, executeTextRequest } from './textGeneration';
import { assembleAudioRequest, executeAudioRequest, previewAudioRequest } from './audioGeneration';
import { GenerationInputError, type GenerationRequestOptions, type GenerationSubmitOutcome, type ImageGenerationPlan, type LocalPanoramaPlan } from './types';
export type { GenerationKind, GenerationRequestOptions, GenerationSubmitOutcome } from './types';
import { resolveNativeChannelModel } from '@/features/channels/application/channelService';
import { channelNativeCountParam } from '@/features/channels/application/modelModes';
import { resolveParamValue } from '@/features/channels/domain/template';
import { referenceUrlFailureOf } from '@/features/channels/domain/referenceErrors';
import { hostChannelReferenceSlot } from '@/features/channels/application/referenceHosting';
import { normalizeChannelGenerationFields } from '@/features/channels/application/generationFields';
import type { GenerateImagePayload } from '../ports';
import { captureCanvasGeneration } from '@/features/library/history/canvasHistoryCapture';
import { generationCanvasMutations } from './canvasMutations';
import { mapImageChannelGenerationParameters } from './channelParameters';

/** Node types that generate from their own data (no tool); the canvas, toolbar and Agents all submit through here. */
export const GENERATION_NODE_TYPES = [
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.aiVideo,
  CANVAS_NODE_TYPES.aiText,
  CANVAS_NODE_TYPES.aiAudio,
  CANVAS_NODE_TYPES.storyboardGen,
  CANVAS_NODE_TYPES.panorama,
] as const satisfies readonly CanvasNodeType[];

const GENERATION_NODE_TYPE_SET = new Set<CanvasNodeType>(GENERATION_NODE_TYPES);

export function isGenerationNodeType(type: CanvasNodeType): boolean {
  return GENERATION_NODE_TYPE_SET.has(type);
}

async function imagePlan(nodeId: string, options: GenerationRequestOptions): Promise<ImageGenerationPlan | LocalPanoramaPlan> {
  const node = useCanvasStore.getState().nodes.find(node => node.id === nodeId);
  if (node?.type === CANVAS_NODE_TYPES.storyboardGen) return await assembleStoryboardRequest(nodeId, options);
  if (options.tool || node?.type === CANVAS_NODE_TYPES.panorama) return await assemblePanelRequest(nodeId, options);
  const assembled = await assembleImageRequest(nodeId, options);
  return { resolved: assembled.resolved, sourceType: 'imageEdit', resultType: CANVAS_NODE_TYPES.exportImage, resultPatch: {}, gatewayPayload: assembled.gatewayPayload };
}

function imageBatchPlan(payload: GenerateImagePayload, requestedCount?: number) {
  payload = mapImageChannelGenerationParameters(payload);
  let count = Math.min(10, Math.max(1, Math.floor(requestedCount ?? 1) || 1));
  const native = resolveNativeChannelModel(payload.model);
  const nativeCount = native ? channelNativeCountParam(native.profile, native.model.id, payload.channelModeId) : undefined;
  if (nativeCount) {
    const value = requestedCount === undefined ? payload.extraParams?.[nativeCount.key] ?? nativeCount.default ?? 1 : count;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new GenerationInputError('invalid-input', '生成数量必须为正整数');
    resolveParamValue(nativeCount, value);
    count = value;
  }
  return { count, nativeCount, payload: nativeCount ? { ...payload, extraParams: { ...payload.extraParams, [nativeCount.key]: count } } : payload };
}

function failure(nodeId: string, reason: Extract<GenerationSubmitOutcome, { ok: false }>['reason'], message: string): GenerationSubmitOutcome {
  return { ok: false, nodeId, reason, message };
}

/** Reads the current graph, not a React closure. Preview and submit share the same assembler. */
export async function previewNodeGenerationRequest(nodeId: string, options: GenerationRequestOptions = {}): Promise<unknown> {
  const node = useCanvasStore.getState().nodes.find(node => node.id === nodeId);
  if (!node) throw new GenerationInputError('unsupported', 'Node does not exist');
  if (!options.tool && node.type === CANVAS_NODE_TYPES.aiVideo) {
    return await buildVideoGenerationDebugPreview(assembleVideoRequest(nodeId).gatewayPayload);
  }
  if (!options.tool && node.type === CANVAS_NODE_TYPES.aiText) {
    const { entry: _entry, inputDiagnostics: _diagnostics, inputParts: _parts, ...preview } = await assembleTextRequest(nodeId);
    return preview;
  }
  if (!options.tool && node.type === CANVAS_NODE_TYPES.aiAudio) {
    return previewAudioRequest(assembleAudioRequest(nodeId));
  }
  const plan = await imagePlan(nodeId, options);
  if ('localPanorama' in plan) return plan;
  return await buildImageGenerationDebugPreview(imageBatchPlan(plan.gatewayPayload, options.count).payload);
}

/** A single local submit lock covers every generation surface for a node. Never retries a submission. */
export async function submitNodeGeneration(nodeId: string, options: GenerationRequestOptions = {}): Promise<GenerationSubmitOutcome> {
  const state = useCanvasStore.getState();
  const mutations = generationCanvasMutations(options.agentTurnId);
  const source = state.nodes.find(node => node.id === nodeId);
  if (!source || (!options.tool && !isGenerationNodeType(source.type))) return failure(nodeId, 'unsupported', '该节点不支持生成');
  if (source.data.enabled === false) return failure(nodeId, 'disabled', '该节点已停用');
  if ('isGenerating' in source.data && source.data.isGenerating === true) return failure(nodeId, 'busy', '该节点正在生成');
  const release = acquireGenerationSubmitLock(generationSubmitLockKey(nodeId, 'generation-service'));
  if (!release) return failure(nodeId, 'busy', '该节点正在提交生成任务');
  const resultNodeIds: string[] = [];
  const jobIds: string[] = [];
  const startedAt = Date.now();
  const recordHistory = captureCanvasGeneration(source, state.nodes, state.edges, startedAt, options);
  let context: GenerationDebugContext | undefined;
  try {
    if (!options.tool && source.type === CANVAS_NODE_TYPES.aiText) {
      const assembled = await assembleTextRequest(nodeId);
      const imageCount = assembled.inputParts.filter(part => part.kind === 'image').length;
      context = { sourceType: 'aiText', providerId: assembled.entry.providerId, requestModel: assembled.entry.modelId, prompt: assembled.textPrompt, referenceImageCount: imageCount, referenceImagePlaceholders: createReferenceImagePlaceholders(imageCount), extraParams: { payloadPreview: assembled }, ...await getRuntimeDiagnostics() };
      await executeTextRequest(nodeId, assembled, resultNodeIds, options.agentTurnId);
    } else if (!options.tool && source.type === CANVAS_NODE_TYPES.aiAudio) {
      const assembled = assembleAudioRequest(nodeId);
      context = { sourceType: 'unknown', providerId: assembled.latestModel.id, prompt: assembled.text };
      await executeAudioRequest(nodeId, assembled, resultNodeIds, jobIds, options.agentTurnId);
    } else if (!options.tool && source.type === CANVAS_NODE_TYPES.aiVideo) {
      const assembled = assembleVideoRequest(nodeId);
      const { latestModelConfig: config, latestEntry: entry, gatewayPayload: payload } = assembled;
      const sequence = resolveNextGeneratedMediaSequence('video', useCanvasStore.getState().nodes);
      const date = getLocalDateStamp();
      const resultId = mutations.addNode(CANVAS_NODE_TYPES.video, state.findNodePosition(nodeId, EXPORT_RESULT_NODE_DEFAULT_WIDTH, EXPORT_RESULT_NODE_LAYOUT_HEIGHT), {
        isGenerating: true, generationStartedAt: startedAt, generationDurationMs: 15 * 60 * 1000,
        displayName: resolveDefaultGeneratedVideoDisplayName(sequence, payload.prompt), generatedNamingMode: 'default', generatedSequence: sequence, generatedDateStamp: date,
        generatedFileName: `${resolveDefaultGeneratedVideoFileStem(sequence, date)}.mp4`, aspectRatio: assembled.outputAspectRatio,
        durationSeconds: Number(config.duration) || null, sourcePrompt: payload.prompt, sourceReferenceCount: assembled.latestIncomingImages.length,
      });
      resultNodeIds.push(resultId);
      mutations.addEdge(nodeId, resultId, { provenance: 'generationResult' });
      context = {
        sourceType: 'aiVideo', providerId: entry.providerId, requestModel: entry.modelId, requestSize: config.resolution, prompt: payload.prompt,
        extraParams: { duration: config.duration, resolution: config.resolution, aspectRatio: config.aspectRatio, referenceVideoCount: assembled.latestIncomingVideos.length, referenceAudioCount: assembled.latestIncomingAudios.length, ...config.extraParams },
        referenceImageCount: assembled.latestIncomingImages.length, referenceImagePlaceholders: createReferenceImagePlaceholders(assembled.latestIncomingImages.length), ...await getRuntimeDiagnostics(),
      };
      const jobId = await canvasVideoGateway.submitGenerateVideoJob(payload);
      jobIds.push(jobId);
      mutations.updateNodeData(resultId, { generationJobId: jobId, generationProviderId: entry.providerId, generationClientSessionId: CURRENT_RUNTIME_SESSION_ID, generationDebugContext: context });
    } else {
      const plan = await imagePlan(nodeId, options);
      if ('localPanorama' in plan) {
        const panorama = plan.localPanorama;
        if (!panorama) throw new Error('全景源图片处理失败');
        const patch = { ...panorama, imageUrl: panorama.imageUrl, previewImageUrl: panorama.imageUrl, sourceMode: 'image', isGenerating: false, generationStartedAt: null, generationJobId: null, generationProviderId: null, generationClientSessionId: null, generationError: null, generationFailure: null };
        const resultId = source.type === CANVAS_NODE_TYPES.panorama
          ? nodeId
          : mutations.addNode(CANVAS_NODE_TYPES.panorama, state.findNodePosition(nodeId, 560, 340), {
            ...patch,
            displayName: `全景 · ${panorama.sourcePrompt.trim().slice(0, 20) || '图生全景'}`,
          });
        if (resultId === nodeId) mutations.updateNodeData(nodeId, patch);
        else mutations.addEdge(nodeId, resultId, { provenance: 'generationResult' });
        resultNodeIds.push(resultId);
      } else {
        const { resolved } = plan;
        const { count, nativeCount, payload } = imageBatchPlan(plan.gatewayPayload, options.count);
        if (resolved.builtinModel && resolved.apiKey) await canvasAiGateway.setApiKey(resolved.providerId, resolved.apiKey);
        const batchId = count > 1 ? `batch-${Date.now()}` : undefined;
        const firstSequence = resolveNextGeneratedMediaSequence('image', useCanvasStore.getState().nodes);
        const date = getLocalDateStamp();
        const positions = state.findNodePositions(nodeId, count, EXPORT_RESULT_NODE_DEFAULT_WIDTH, EXPORT_RESULT_NODE_LAYOUT_HEIGHT);
        context = { sourceType: plan.sourceType, providerId: resolved.providerId, requestModel: payload.model, requestSize: payload.size, requestAspectRatio: payload.aspectRatio, channelModeId: payload.channelModeId, prompt: payload.prompt, extraParams: payload.extraParams, referenceImageCount: payload.referenceImages?.length ?? 0, referenceImagePlaceholders: createReferenceImagePlaceholders(payload.referenceImages?.length ?? 0), ...await getRuntimeDiagnostics() };
        for (let index = 0; index < count; index++) {
          const sequence = firstSequence + index;
          const patch = {
            isGenerating: !plan.gridPreview, generationStartedAt: plan.gridPreview ? null : startedAt, generationDurationMs: resolved.builtinModel?.expectedDurationMs ?? 60000,
            resultKind: 'generic' as const, displayName: resolveDefaultGeneratedImageDisplayName(sequence, payload.prompt), sourcePrompt: payload.prompt,
            generatedNamingMode: 'default' as const, generatedSequence: sequence, generatedDateStamp: date, generatedFileName: `${resolveDefaultGeneratedImageFileStem(sequence, date)}.png`,
            batchId, batchIndex: index, batchTotal: count, ...plan.resultPatch,
            ...(plan.gridPreview ? {imageUrl: plan.gridPreview, previewImageUrl: plan.gridPreview} : {}),
          };
          // A panorama node regenerates itself (its own composer, or the `panorama` tool aimed at it); it keeps its name.
          const inPlace = source.type === CANVAS_NODE_TYPES.panorama && (!options.tool || options.tool.id === 'panorama');
          const resultId = inPlace ? nodeId : mutations.addNode(plan.resultType, positions[index] ?? { x: 100, y: 100 }, patch);
          if (inPlace) {
            const { displayName: _keepName, generatedNamingMode: _a, generatedSequence: _b, generatedDateStamp: _c, generatedFileName: _d, ...inPlacePatch } = patch;
            mutations.updateNodeData(nodeId, inPlacePatch);
          } else {
            mutations.addEdge(nodeId, resultId, { provenance: 'generationResult' });
          }
          resultNodeIds.push(resultId);
        }
        const groups = nativeCount ? [resultNodeIds] : resultNodeIds.map((resultId) => [resultId]);
        const submissions = await Promise.allSettled(groups.map(async (resultIds) => {
          if (plan.gridPreview) return;
          try {
            const jobId = await canvasAiGateway.submitGenerateImageJob({ ...payload,
              referenceImages: payload.referenceImages ? [...payload.referenceImages] : undefined,
              extraParams: { ...payload.extraParams } });
            jobIds.push(jobId);
            resultIds.forEach((resultId) => mutations.updateNodeData(resultId, { generationJobId: jobId, generationSourceType: plan.sourceType, generationProviderId: resolved.providerId, generationClientSessionId: CURRENT_RUNTIME_SESSION_ID, generationDebugContext: context }));
          } catch (error) {
            resultIds.forEach((resultId) => markFailed(resultId, error, startedAt, context, nodeId, options.agentTurnId));
            throw error;
          }
        }));
        const rejected = submissions.find(result => result.status === 'rejected');
        if (rejected?.status === 'rejected') {
          const error = resolveErrorContent(rejected.reason, '生成失败');
          // The failed result nodes carry the slot failure and its explicit upload action.
          if (!referenceUrlFailureOf(rejected.reason)) await showErrorDialog(error.message, '错误', error.details, buildGenerationErrorReport({ errorMessage: error.message, errorDetails: error.details, context }));
          if (!jobIds.length) return failure(nodeId, 'failed', error.message);
        }
      }
    }
    return { ok: true, nodeId, resultNodeIds, jobIds };
  } catch (error) {
    if (error instanceof GenerationInputError) return failure(nodeId, error.reason, error.message);
    const resolved = resolveErrorContent(error, '生成失败');
    resultNodeIds.forEach(resultId => markFailed(resultId, error, startedAt, context, nodeId, options.agentTurnId));
    if (source.type === CANVAS_NODE_TYPES.aiText || source.type === CANVAS_NODE_TYPES.aiAudio) mutations.updateNodeData(nodeId, {
      lastError: resolved.message, generationFailure: classifyGenerationFailure(error),
    });
    if (!(resultNodeIds.length && referenceUrlFailureOf(error))) await showErrorDialog(resolved.message, '错误', resolved.details, buildGenerationErrorReport({ errorMessage: resolved.message, errorDetails: resolved.details, context }));
    return failure(nodeId, 'failed', resolved.message);
  } finally {
    recordHistory({ context, resultNodeIds, jobIds });
    release();
  }
}

function markFailed(nodeId: string, error: unknown, startedAt: number, context: GenerationDebugContext | undefined, sourceNodeId: string, agentTurnId?: string): void {
  const resolved = resolveErrorContent(error, '生成失败');
  const reference = referenceUrlFailureOf(error);
  generationCanvasMutations(agentTurnId).updateNodeData(nodeId, {
    isGenerating: false, isStreaming: false, generationStartedAt: null, generationElapsedMs: Math.max(0, Date.now() - startedAt),
    generationJobId: null, generationProviderId: null, generationClientSessionId: null,
    generationError: resolved.message, generationErrorDetails: resolved.details ?? null, generationDebugContext: context,
    generationFailure: classifyGenerationFailure(error),
    generationReferenceFailure: reference ? { sourceNodeId, ...reference } : null,
  });
}

/**
 * Explicit, user-confirmed recovery for a result that failed on a local reference: host that slot's
 * images, keep the public URLs on the source node, drop the failed placeholders and submit again.
 */
export async function retryGenerationWithHostedReference(resultNodeId: string, confirmation: { confirmed: true }): Promise<GenerationSubmitOutcome> {
  const state = useCanvasStore.getState();
  const found = readGenerationReferenceFailure(state.nodes.find(node => node.id === resultNodeId)?.data);
  const source = found ? state.nodes.find(node => node.id === found.sourceNodeId) : undefined;
  const slots = source ? normalizeChannelGenerationFields(source.data).referenceSlots : undefined;
  if (!found?.slotKind || !source || !slots?.[found.slotKey]?.length) return failure(resultNodeId, 'invalid-input', 'reference.retryUnavailable');
  const referenceSlots = await hostChannelReferenceSlot(slots, found.slotKey, found.slotKind, confirmation);
  const current = useCanvasStore.getState();
  // A panorama regenerates in place: it is both source and failed result.
  current.updateNodeData(source.id, source.id === resultNodeId ? { referenceSlots, generationReferenceFailure: null } : { referenceSlots });
  const stale = current.nodes.filter(node => node.id !== source.id && readGenerationReferenceFailure(node.data)?.sourceNodeId === source.id).map(node => node.id);
  if (stale.length) current.deleteNodes(stale);
  return await submitNodeGeneration(source.id);
}

/** Stops local result polling only; preserves the job handle for explicit recovery. No upstream cancel is sent. */
export function cancelNodeGeneration(nodeId: string): void {
  const state = useCanvasStore.getState();
  const targets = new Set([nodeId, ...state.edges.filter(edge => edge.source === nodeId).map(edge => edge.target)]);
  for (const node of state.nodes) {
    if (!targets.has(node.id) || ![CANVAS_NODE_TYPES.exportImage, CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.audio, CANVAS_NODE_TYPES.panorama].some(type => type === node.type)) continue;
    if ('isGenerating' in node.data && node.data.isGenerating === true) state.updateNodeData(node.id, { isGenerating: false });
  }
}
