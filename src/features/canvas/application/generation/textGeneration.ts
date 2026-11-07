import { t } from 'i18next';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { getChannelCatalogProviders, resolveChannelCatalogModelId } from '@/features/channels/application/channelCatalog';
import { CANVAS_NODE_TYPES } from '../../domain/canvasNodes';
import { buildAiTextUserPrompt, buildOpenAiChatPayload, collectAiTextInputs, computeAiTextInputHash, resolveAiTextResult } from '../aiText/helpers';
import { buildChatModelCatalog, type ChatCatalogEntry } from '../chatModelCatalog';
import { buildCustomChatCompletionRequestDebugPreview, streamCustomChatCompletion, submitCustomChatCompletion } from '@/features/channels/runtime/channelChat';
import { GenerationInputError } from './types';
import type { AiTextInputPart, AiTextOpenAiChatPayload } from '../aiText/types';
import { generationCanvasMutations } from './canvasMutations';

export interface TextRequestAssembly {
  entry: ChatCatalogEntry;
  provider: { id: string; label: string } | null;
  model: { id: string; modelId: string; label: string; supportsMultimodal: boolean } | null;
  inputHash: string;
  textPrompt: string;
  inputParts: AiTextInputPart[];
  inputDiagnostics: {
    userPromptIncluded: boolean;
    partCount: number;
    parts: Array<{kind: string; sourceType: string; sourceNodeId: string; label: string; jsonPath: string | null; contentCharacters: number | null}>;
  };
  payload: AiTextOpenAiChatPayload;
  providerRequest: unknown;
}
function isLengthLimitedFinishReason(reason: string | null | undefined): boolean {
  return /length|max[_-]?tokens?|token[_-]?limit|output[_-]?limit|incomplete/i.test(reason ?? '');
}

function buildLengthLimitedWarning(reason: string): string {
  return `模型停止原因为 ${reason}，输出可能因为 token 上限被截断。请提高服务商配置里的 max_tokens/max_completion_tokens，或减少单次输出内容。`;
}
const STREAM_PREVIEW_MAX_LENGTH = 260;
const STREAM_PREVIEW_SEGMENT_LIMIT = 3;
const STREAM_PREVIEW_UPDATE_INTERVAL_MS = 900;

function createStreamPreview(fullText: string): string {
  const normalized = fullText.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  const segments = normalized.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [normalized];
  const sentencePreview = segments.slice(0, STREAM_PREVIEW_SEGMENT_LIMIT).join('').trim();
  const preview = sentencePreview.length >= 40 ? sentencePreview : normalized;
  if (preview.length <= STREAM_PREVIEW_MAX_LENGTH) {
    return preview;
  }
  return `${preview.slice(0, STREAM_PREVIEW_MAX_LENGTH)}...`;
}
export async function assembleTextRequest(id: string): Promise<TextRequestAssembly> {
    const latestCanvas = useCanvasStore.getState();
    const node = latestCanvas.nodes.find(node => node.id === id);
    if (!node || node.type !== CANVAS_NODE_TYPES.aiText) throw new GenerationInputError('unsupported', 'Not a text generation node');
    const data = node.data;
    const settings = useSettingsStore.getState();
    const chatCatalog = buildChatModelCatalog(getChannelCatalogProviders());
    const modelId = typeof data.model === 'string' ? data.model : '';
    const entry = chatCatalog.find(entry => entry.id === resolveChannelCatalogModelId(modelId)) ?? chatCatalog.find(entry => entry.providerId === data.providerId) ?? chatCatalog[0];
    if (!entry) throw new GenerationInputError('missing-model', t('node.aiText.noChatModel'));
    if (!entry.usable) throw new GenerationInputError('missing-credentials', entry.notReadyReason ?? t('node.aiText.modelNotReady'));
    const previewParts = collectAiTextInputs(id, latestCanvas.nodes, latestCanvas.edges);
    const effectiveUserPrompt = typeof data.prompt === 'string' ? data.prompt : '';
    const previewInputHash = computeAiTextInputHash({
      providerId: entry.providerId,
      model: entry.id,
      agentPrompt: '',
      userPrompt: effectiveUserPrompt,
      parts: previewParts,
    });
    const previewComposedPrompt = buildAiTextUserPrompt(previewParts, effectiveUserPrompt);
    const payload = await buildOpenAiChatPayload({
      model: entry.modelId,
      agentPrompt: '',
      userPrompt: effectiveUserPrompt,
      parts: previewParts,
    });
    const providerRequest = entry
      ? buildCustomChatCompletionRequestDebugPreview(entry.id, payload, settings.enableAiTextStreaming && entry.supportsStreaming !== false)
      : null;

    return {
      entry,
      provider: entry
        ? {
          id: entry.providerId,
          label: entry.providerLabel,
        }
        : null,
      model: entry
        ? {
          id: entry.id,
          modelId: entry.modelId,
          label: entry.modelLabel,
          supportsMultimodal: entry.supportsMultimodal,
        }
        : null,
      inputHash: previewInputHash,
      textPrompt: previewComposedPrompt,
      inputParts: previewParts,
      inputDiagnostics: {
        userPromptIncluded: effectiveUserPrompt.trim().length > 0,
        partCount: previewParts.length,
        parts: previewParts.map((part) => ({
          kind: part.kind,
          sourceType: part.sourceType,
          sourceNodeId: part.sourceNodeId,
          label: part.label,
          jsonPath: part.kind === 'text' ? part.jsonPath ?? null : null,
          contentCharacters: part.kind === 'text' ? part.content.length : null,
        })),
      },
      payload,
      providerRequest,
    };
}
export async function executeTextRequest(id: string, payloadPreview: TextRequestAssembly, resultNodeIds: string[], agentTurnId?: string) {
 const { addNode, addEdge, updateNodeData } = generationCanvasMutations(agentTurnId);
 const { findNodePosition } = useCanvasStore.getState();
 const nextEntry = payloadPreview.entry;
 const generationStartedAt = Date.now();
 const enableAiTextStreaming = useSettingsStore.getState().enableAiTextStreaming && nextEntry.supportsStreaming !== false;
 updateNodeData(id, {providerId: nextEntry.providerId, model: nextEntry.id, lastError: null});
      const resultNodeId = addNode(
        CANVAS_NODE_TYPES.jsonCard,
        findNodePosition(id, 420, 240),
        {
          displayName: t('node.aiText.outputTitle'),
          rawContent: '',
          parsedJson: null,
          parseError: null,
          displayFields: [],
          isStreaming: true,
          isGenerating: true,
          generationStartedAt,
          generationElapsedMs: null,
          sourceAiNodeId: id,
          generationFinishReason: null,
          generationWarning: null,
          streamPreview: null,
          streamReceivedCharacters: 0,
        }
      );
      resultNodeIds.push(resultNodeId);
      addEdge(id, resultNodeId, { provenance: 'generationResult' });

      let rawOutput = '';
      let usedStreaming = false;
      let finishReason: string | null = null;
      let responseStatus: number | null = null;
      let requestDebug: unknown = payloadPreview.providerRequest ?? null;
      let rawStreamTail: string | null = null;
      let streamDiagnostics: unknown = null;
      let responseUsage: unknown = null;
      let streamFailureWarning: string | null = null;
      let lastStreamPreviewUpdateAt = 0;
      if (enableAiTextStreaming) try {
          usedStreaming = true;
          const streamResult = await streamCustomChatCompletion(nextEntry.id, payloadPreview.payload, {
            onTextDelta: (_delta, fullText) => {
              rawOutput = fullText;
              const now = Date.now();
              if (now - lastStreamPreviewUpdateAt < STREAM_PREVIEW_UPDATE_INTERVAL_MS) {
                return;
              }
              lastStreamPreviewUpdateAt = now;
              updateNodeData(resultNodeId, {
                streamPreview: createStreamPreview(fullText),
                streamReceivedCharacters: fullText.length,
                isStreaming: true,
                isGenerating: true,
                generationStartedAt,
                generationElapsedMs: null,
                sourceAiNodeId: id,
              });
            },
          });
          if (streamResult.text.trim()) {
            rawOutput = streamResult.text;
          }
          if (rawOutput.trim()) {
            updateNodeData(resultNodeId, {
              streamPreview: createStreamPreview(rawOutput),
              streamReceivedCharacters: rawOutput.length,
              isStreaming: true,
              isGenerating: true,
              generationStartedAt,
              generationElapsedMs: null,
              sourceAiNodeId: id,
            });
          }
          finishReason = streamResult.finishReason ?? null;
          responseStatus = typeof streamResult.status === 'number' ? streamResult.status : null;
          requestDebug = streamResult.requestDebug ?? requestDebug;
          rawStreamTail = streamResult.rawStreamTail ?? null;
          streamDiagnostics = streamResult.streamDiagnostics ?? null;
          responseUsage = streamResult.usage ?? null;
        } catch (streamError) {
          const message = streamError instanceof Error ? streamError.message : String(streamError);
          const diagnosticError = streamError as {
            status?: number;
            requestDebug?: unknown;
            rawStreamTail?: string | null;
            streamDiagnostics?: unknown;
          };
          responseStatus = typeof diagnosticError.status === 'number' ? diagnosticError.status : responseStatus;
          requestDebug = diagnosticError.requestDebug ?? requestDebug;
          rawStreamTail = diagnosticError.rawStreamTail ?? rawStreamTail;
          streamDiagnostics = diagnosticError.streamDiagnostics ?? streamDiagnostics;
          if (rawOutput.trim()) {
            streamFailureWarning = `流式输出中断，已保留已收到的内容。错误：${message}`;
            finishReason = finishReason ?? 'stream_error';

            updateNodeData(resultNodeId, {
              streamPreview: createStreamPreview(rawOutput),
              streamReceivedCharacters: rawOutput.length,
              isStreaming: false,
              isGenerating: true,
              generationStartedAt,
              generationElapsedMs: null,
            });
          } else {
            usedStreaming = false;
            // Only explicit unsupported-stream responses are safe to send again.
            if (![400, 404, 405, 415, 422, 501].includes(responseStatus ?? 0)) throw streamError;
            updateNodeData(resultNodeId, {
              rawContent: '',
              isStreaming: false,
              isGenerating: true,
              generationStartedAt,
              generationElapsedMs: null,
            });
          }
      }

      if (!rawOutput.trim() && (!enableAiTextStreaming || !usedStreaming)) {
        const result = await submitCustomChatCompletion(nextEntry.id, payloadPreview.payload);
        rawOutput = result.text;
        finishReason = result.finishReason ?? finishReason;
        responseStatus = typeof result.status === 'number' ? result.status : responseStatus;
        requestDebug = result.requestDebug ?? requestDebug;
        responseUsage = result.usage ?? responseUsage;
        streamDiagnostics = result.usage
          ? {
            ...(streamDiagnostics && typeof streamDiagnostics === 'object' ? streamDiagnostics : {}),
            usage: result.usage,
          }
          : streamDiagnostics;
      }
      let effectiveRawOutput = rawOutput;
      if (!effectiveRawOutput.trim()) {
        const existingResultNode = useCanvasStore
          .getState()
          .nodes.find((node) => node.id === resultNodeId);
        const existingRawContent =
          existingResultNode?.type === CANVAS_NODE_TYPES.jsonCard
          && typeof existingResultNode.data.rawContent === 'string'
            ? existingResultNode.data.rawContent
            : '';
        if (existingRawContent.trim()) {
          effectiveRawOutput = existingRawContent;
        }
      }
      if (!effectiveRawOutput.trim()) throw new Error('模型返回了空文本；为避免重复扣费，未自动重新提交。');
      const resolvedResult = resolveAiTextResult(effectiveRawOutput);
      const parsedJson = resolvedResult.kind === 'json' ? resolvedResult.parsedJson ?? null : null;
      const baseParseError = resolvedResult.kind === 'json'
        ? resolvedResult.parseError ?? null
        : resolvedResult.parseError ?? null;
      const lengthLimited = isLengthLimitedFinishReason(finishReason);
      const generationWarning = lengthLimited && finishReason
        ? buildLengthLimitedWarning(finishReason)
        : null;
      const combinedGenerationWarning = [streamFailureWarning, generationWarning]
        .filter((item): item is string => Boolean(item))
        .join('\n');
      const parseError = parsedJson === null && generationWarning
        ? '模型输出因长度限制截断，JSON 不完整。'
        : baseParseError;
      const generationElapsedMs = Math.max(0, Date.now() - generationStartedAt);
      const payloadDiagnostics = {
        inputDiagnostics: payloadPreview.inputDiagnostics,
        responseDiagnostics: {
          status: responseStatus,
          finishReason,
          usedStreaming,
          outputCharacters: effectiveRawOutput.length,
          parsedAs: resolvedResult.kind,
          parseError,
          usage: responseUsage,
          rawStreamTail,
          streamDiagnostics,
        },
      };
      const {
        entry: _entry,
        inputDiagnostics: _inputDiagnostics,
        inputParts: _inputParts,
        ...payloadPreviewForStorage
      } = payloadPreview;
      const preparedPayload = {
        ...payloadPreviewForStorage,
        providerRequest: requestDebug,
      };
      updateNodeData(resultNodeId, {
        rawContent: resolvedResult.rawContent || effectiveRawOutput,
        parsedJson,
        parseError,
        displayFields: [],
        generationFinishReason: finishReason,
        generationWarning: combinedGenerationWarning || null,
        streamPreview: null,
        streamReceivedCharacters: null,
        isStreaming: false,
        isGenerating: false,
        generationStartedAt: null,
        generationElapsedMs,
        sourceAiNodeId: id,
      });
      updateNodeData(id, {
        providerId: nextEntry.providerId,
        model: nextEntry.id,
        resultNodeId,
        lastPreparedPayload: preparedPayload,
        lastPayloadDiagnostics: payloadDiagnostics,
        lastRunInputHash: payloadPreview.inputHash,
        lastOutputType: resolvedResult.kind,
        lastError: null,
      });
}
