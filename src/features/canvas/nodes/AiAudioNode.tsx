import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Bug, Check, ChevronDown, Copy, LoaderCircle, Music2, Settings2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  type AiAudioNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { subscribeCanvasGenerationTrigger } from '@/features/canvas/application/canvasGenerationTriggers';
import {
  resolveAudioInputSchemaFromExtraParams,
  type AudioInputSchema,
  type AudioParameterSchema,
} from '@/features/canvas/application/audioInputSchema';
import { collectInputReferences } from '@/features/canvas/application/graphReferenceResolver';
import { resolveErrorContent, showErrorDialog } from '@/features/canvas/application/errorDialog';
import {
  acquireGenerationSubmitLock,
  generationSubmitLockKey,
} from '@/features/canvas/application/generationSubmitLock';
import {
  buildAudioGenerationDebugPreview,
  generateAudio,
  transcribeVoxCpmReferenceAudio,
  type GenerateAudioRequest,
} from '@/features/canvas/infrastructure/localAudioGateway';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { UiButton, UiCheckbox, UiModal } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore, type AudioModelConfig } from '@/stores/settingsStore';

type AiAudioNodeProps = NodeProps & {
  id: string;
  data: AiAudioNodeData;
  selected?: boolean;
};

interface AudioGenerationRequestAssembly {
  text: string;
  latestModel: AudioModelConfig;
  latestSettings: ReturnType<typeof useSettingsStore.getState>['audioGenerationSettings'];
  latestInputSchema: AudioInputSchema;
  latestGenerationParams: Record<string, unknown>;
  latestVoiceId: string;
  latestUsePromptText: boolean;
  latestPromptTextValue: string;
  latestControlInstruction: string;
  latestAudioReferences: ReturnType<typeof collectInputReferences>;
  latestMode: string;
  gatewayPayload: GenerateAudioRequest;
}

const AI_AUDIO_NODE_MIN_WIDTH = 500;
const AI_AUDIO_NODE_MIN_HEIGHT = 320;
const AI_AUDIO_NODE_DEFAULT_WIDTH = 640;
const AI_AUDIO_NODE_DEFAULT_HEIGHT = 390;
const AI_AUDIO_NODE_MAX_WIDTH = 1200;
const AI_AUDIO_NODE_MAX_HEIGHT = 900;
const PROMPT_COMMIT_DELAY_MS = 450;
const VOXCPM_REFERENCE_ASR_FIELD = '__voxcpmReferenceAsr';

function resolveNodeDimension(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    return Math.round(value);
  }
  return fallback;
}

function normalizeTextBlock(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function computeInputHash(value: unknown): string {
  let text = '';
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildAudioInputText(prompt: string, upstreamTextParts: string[]): string {
  const upstream = upstreamTextParts
    .map(normalizeTextBlock)
    .filter(Boolean)
    .join('\n\n');
  const ownPrompt = normalizeTextBlock(prompt);
  return [upstream, ownPrompt].filter(Boolean).join('\n\n');
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min?: number, max?: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const lowerBounded = typeof min === 'number' ? Math.max(min, numeric) : numeric;
  return typeof max === 'number' ? Math.min(max, lowerBounded) : lowerBounded;
}

function getSchemaDefaultParams(schema: AudioInputSchema): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  schema.parameters.forEach((parameter) => {
    params[parameter.key] = parameter.defaultValue;
  });
  return params;
}

function resolveGenerationParams(
  schema: AudioInputSchema,
  model: AudioModelConfig | null,
  data: AiAudioNodeData
): Record<string, unknown> {
  const modelParams = asPlainRecord(model?.extraParams) ?? {};
  return {
    ...getSchemaDefaultParams(schema),
    ...modelParams,
    ...(asPlainRecord(data.audioGenerationParams) ?? {}),
    ...(data.controlInstruction !== undefined ? { controlInstruction: data.controlInstruction ?? '' } : {}),
    ...(data.usePromptText !== undefined ? { usePromptText: data.usePromptText === true } : {}),
    ...(data.promptTextValue !== undefined ? { promptTextValue: data.promptTextValue ?? '' } : {}),
  };
}

function resolveParameterValue(
  parameter: AudioParameterSchema,
  params: Record<string, unknown>
): string | number | boolean {
  const value = params[parameter.key];
  if (parameter.kind === 'boolean') {
    return asBoolean(value, Boolean(parameter.defaultValue));
  }
  if (parameter.kind === 'number') {
    const fallback = typeof parameter.defaultValue === 'number' ? parameter.defaultValue : 0;
    return asNumber(value, fallback, parameter.min, parameter.max);
  }
  return typeof value === 'string' ? value : String(parameter.defaultValue ?? '');
}

function resolveAudioGenerationMode(
  schema: AudioInputSchema,
  usePromptText: boolean,
  referenceCount: number
): string {
  if (schema.promptText.enabled && usePromptText) {
    return 'ultimate-cloning';
  }
  if (schema.referenceAudio.enabled && referenceCount > 0) {
    return 'controllable-cloning';
  }
  if (schema.controlInstruction.enabled) {
    return 'voice-design';
  }
  return 'text-to-audio';
}

function syncTextareaValue(element: HTMLTextAreaElement | null, value: string) {
  if (element && element.value !== value) {
    element.value = value;
  }
}

function serializeDebugJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const AiAudioNode = memo(({ id, data, selected, width, height }: AiAudioNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const controlInstructionTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const promptTextTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const promptCommitTimerRef = useRef<number | null>(null);
  const lastCommittedPromptRef = useRef(data.prompt ?? '');
  const promptDraftRef = useRef(data.prompt ?? '');
  const composingTextFieldsRef = useRef(new Set<string>());
  const [promptDraft, setPromptDraft] = useState(() => data.prompt ?? '');
  const [modelOpen, setModelOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isTranscribingReference, setIsTranscribingReference] = useState(false);
  const [payloadDebugText, setPayloadDebugText] = useState<string | null>(null);
  const [payloadDebugCopied, setPayloadDebugCopied] = useState(false);

  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const audioSettings = useSettingsStore((state) => state.audioGenerationSettings);
  const showNodePayloadPreview = useSettingsStore((state) => state.showNodePayloadPreview);

  const enabledModels = useMemo(
    () => audioSettings.models.filter((model) => model.enabled),
    [audioSettings.models]
  );
  const selectedModel = useMemo<AudioModelConfig | null>(
    () => enabledModels.find((model) => model.id === data.modelId)
      ?? enabledModels[0]
      ?? null,
    [data.modelId, enabledModels]
  );
  const currentInputSchema = useMemo(
    () => resolveAudioInputSchemaFromExtraParams(
      selectedModel?.extraParams,
      selectedModel?.providerKind
    ),
    [selectedModel?.extraParams, selectedModel?.providerKind]
  );
  const selectedVoiceId = useMemo(
    () => !currentInputSchema.voice.enabled
      ? ''
      : data.voiceId
      || selectedModel?.defaultVoiceId
      || audioSettings.selectedVoiceId
      || audioSettings.voices[0]?.id
      || '',
    [
      audioSettings.selectedVoiceId,
      audioSettings.voices,
      currentInputSchema.voice.enabled,
      data.voiceId,
      selectedModel?.defaultVoiceId,
    ]
  );
  const selectedVoice = useMemo(
    () => audioSettings.voices.find((voice) => voice.id === selectedVoiceId) ?? null,
    [audioSettings.voices, selectedVoiceId]
  );
  const generationParams = useMemo(
    () => resolveGenerationParams(currentInputSchema, selectedModel, data),
    [currentInputSchema, data, selectedModel]
  );
  const usePromptText = currentInputSchema.promptText.enabled
    ? asBoolean(generationParams[currentInputSchema.promptText.toggleField], false)
    : false;
  const promptTextValue = currentInputSchema.promptText.enabled
    ? asString(generationParams[currentInputSchema.promptText.field])
    : '';
  const controlInstruction = currentInputSchema.controlInstruction.enabled
    ? asString(generationParams[currentInputSchema.controlInstruction.field])
    : '';
  const controlInstructionDisabled =
    currentInputSchema.controlInstruction.disabledWhenPromptText
    && currentInputSchema.promptText.enabled
    && usePromptText;
  const incomingTextReferences = useMemo(
    () => collectInputReferences(id, nodes, edges)
      .filter((reference) => reference.kind === 'text' && reference.content?.trim()),
    [edges, id, nodes]
  );
  const incomingAudioReferences = useMemo(
    () => collectInputReferences(id, nodes, edges)
      .filter((reference) => reference.kind === 'audio' && reference.audioUrl?.trim()),
    [edges, id, nodes]
  );
  const schemaAudioReferences = useMemo(
    () => currentInputSchema.referenceAudio.enabled
      ? incomingAudioReferences.slice(0, currentInputSchema.referenceAudio.max)
      : [],
    [
      currentInputSchema.referenceAudio.enabled,
      currentInputSchema.referenceAudio.max,
      incomingAudioReferences,
    ]
  );
  const activeAudioReference = schemaAudioReferences[0] ?? null;
  const upstreamTextParts = useMemo(
    () => incomingTextReferences.map((reference) => reference.content ?? ''),
    [incomingTextReferences]
  );
  const currentInputText = useMemo(
    () => buildAudioInputText(promptDraft, upstreamTextParts),
    [promptDraft, upstreamTextParts]
  );
  const currentInputHash = useMemo(
    () => computeInputHash({
      modelId: selectedModel?.id ?? null,
      voiceId: selectedVoiceId,
      text: currentInputText,
      generationParams,
      inputSchema: currentInputSchema,
      referenceAudios: schemaAudioReferences.map((reference) => reference.audioUrl),
    }),
    [
      currentInputSchema,
      currentInputText,
      generationParams,
      schemaAudioReferences,
      selectedModel?.id,
      selectedVoiceId,
    ]
  );
  const isStale = Boolean(data.lastRunInputHash) && data.lastRunInputHash !== currentInputHash;
  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.aiAudio, data),
    [data]
  );
  const resolvedWidth = resolveNodeDimension(width, AI_AUDIO_NODE_DEFAULT_WIDTH);
  const resolvedHeight = Math.max(
    resolveNodeDimension(height, AI_AUDIO_NODE_DEFAULT_HEIGHT),
    AI_AUDIO_NODE_MIN_HEIGHT
  );

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  useEffect(() => {
    const externalPrompt = data.prompt ?? '';
    lastCommittedPromptRef.current = externalPrompt;
    if (externalPrompt !== promptDraftRef.current) {
      if (promptCommitTimerRef.current) {
        window.clearTimeout(promptCommitTimerRef.current);
        promptCommitTimerRef.current = null;
      }
      promptDraftRef.current = externalPrompt;
      setPromptDraft(externalPrompt);
      syncTextareaValue(promptTextareaRef.current, externalPrompt);
    }
  }, [data.prompt]);

  useEffect(() => {
    if (!composingTextFieldsRef.current.has('prompt')) {
      syncTextareaValue(promptTextareaRef.current, promptDraft);
    }
  }, [promptDraft]);

  useEffect(() => {
    if (!composingTextFieldsRef.current.has('controlInstruction')) {
      syncTextareaValue(controlInstructionTextareaRef.current, controlInstruction);
    }
  }, [controlInstruction]);

  useEffect(() => {
    if (!composingTextFieldsRef.current.has('promptText')) {
      syncTextareaValue(promptTextTextareaRef.current, promptTextValue);
    }
  }, [promptTextValue]);

  useEffect(() => {
    const referenceAudioUrl = activeAudioReference?.audioUrl?.trim() ?? '';
    if (
      selectedModel?.providerKind !== 'gradio-voxcpm'
      || !usePromptText
      || !referenceAudioUrl
    ) {
      return;
    }

    const asrRecord = asPlainRecord(data.audioGenerationParams?.[VOXCPM_REFERENCE_ASR_FIELD]);
    const lastAudioUrl = typeof asrRecord?.audioUrl === 'string' ? asrRecord.audioUrl : '';
    const lastText = typeof asrRecord?.text === 'string' ? asrRecord.text : '';
    const userEditedPromptText = Boolean(
      promptTextValue
      && lastAudioUrl === referenceAudioUrl
      && promptTextValue !== lastText
    );
    if (userEditedPromptText || (lastAudioUrl === referenceAudioUrl && promptTextValue)) {
      return;
    }

    let cancelled = false;
    setIsTranscribingReference(true);
    setNotice('正在识别参考音频文本...');
    void transcribeVoxCpmReferenceAudio({
      model: selectedModel,
      fallbackBaseUrl: audioSettings.apiBaseUrl,
      referenceAudioUrl,
      timeoutMs: selectedModel.timeoutMs || audioSettings.defaultTimeoutMs,
      usePromptText: true,
    })
      .then((result) => {
        if (cancelled) {
          return;
        }
        const text = result.text.trim();
        updateNodeData(id, {
          promptTextValue: text,
          audioGenerationParams: {
            ...(asPlainRecord(data.audioGenerationParams) ?? {}),
            [currentInputSchema.promptText.field]: text,
            [VOXCPM_REFERENCE_ASR_FIELD]: {
              audioUrl: referenceAudioUrl,
              text,
              updatedAt: Date.now(),
            },
          },
        });
        setNotice(text ? '已自动识别参考音频文本，可手动修正' : '');
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const resolvedError = resolveErrorContent(error, t('ai.error'));
        setNotice(`参考音频文本识别失败：${resolvedError.message}`);
      })
      .finally(() => {
        if (!cancelled) {
          setIsTranscribingReference(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeAudioReference?.audioUrl,
    audioSettings.apiBaseUrl,
    audioSettings.defaultTimeoutMs,
    currentInputSchema.promptText.field,
    data.audioGenerationParams,
    id,
    promptTextValue,
    selectedModel,
    t,
    updateNodeData,
    usePromptText,
  ]);

  useEffect(() => {
    if (!selectedModel) {
      return;
    }
    const patch: Partial<AiAudioNodeData> = {};
    if (!data.modelId) {
      patch.modelId = selectedModel.id;
    }
    if (selectedModel.providerKind === 'gradio-voxcpm' && data.voiceId) {
      patch.voiceId = null;
    } else if (!data.voiceId && selectedVoiceId) {
      patch.voiceId = selectedVoiceId;
    }
    if (Object.keys(patch).length > 0) {
      updateNodeData(id, patch);
    }
  }, [data.modelId, data.voiceId, id, selectedModel, selectedVoiceId, updateNodeData]);

  const flushPromptDraft = useCallback((nextPrompt = promptDraftRef.current) => {
    if (promptCommitTimerRef.current) {
      window.clearTimeout(promptCommitTimerRef.current);
      promptCommitTimerRef.current = null;
    }
    promptDraftRef.current = nextPrompt;
    if (!Object.is(lastCommittedPromptRef.current, nextPrompt)) {
      lastCommittedPromptRef.current = nextPrompt;
      updateNodeData(id, { prompt: nextPrompt });
    }
  }, [id, updateNodeData]);

  const schedulePromptCommit = useCallback((nextPrompt: string) => {
    promptDraftRef.current = nextPrompt;
    if (promptCommitTimerRef.current) {
      window.clearTimeout(promptCommitTimerRef.current);
    }
    promptCommitTimerRef.current = window.setTimeout(() => {
      promptCommitTimerRef.current = null;
      const latest = promptDraftRef.current;
      if (!Object.is(lastCommittedPromptRef.current, latest)) {
        lastCommittedPromptRef.current = latest;
        updateNodeData(id, { prompt: latest });
      }
    }, PROMPT_COMMIT_DELAY_MS);
  }, [id, updateNodeData]);

  const commitPromptInput = useCallback((nextPrompt: string) => {
    promptDraftRef.current = nextPrompt;
    setPromptDraft(nextPrompt);
    schedulePromptCommit(nextPrompt);
  }, [schedulePromptCommit]);

  const handlePromptChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextPrompt = event.target.value;
    promptDraftRef.current = nextPrompt;
    if (composingTextFieldsRef.current.has('prompt')) {
      return;
    }
    commitPromptInput(nextPrompt);
  }, [commitPromptInput]);

  const handleCompositionStart = useCallback((field: string, event: CompositionEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    composingTextFieldsRef.current.add(field);
  }, []);

  const handlePromptCompositionEnd = useCallback((event: CompositionEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    composingTextFieldsRef.current.delete('prompt');
    commitPromptInput(event.currentTarget.value);
  }, [commitPromptInput]);

  const handlePromptBlur = useCallback((event: FocusEvent<HTMLTextAreaElement>) => {
    composingTextFieldsRef.current.delete('prompt');
    flushPromptDraft(event.currentTarget.value);
  }, [flushPromptDraft]);

  useEffect(() => () => {
    if (promptCommitTimerRef.current) {
      window.clearTimeout(promptCommitTimerRef.current);
    }
    const latest = promptDraftRef.current;
    if (!Object.is(lastCommittedPromptRef.current, latest)) {
      updateNodeData(id, { prompt: latest });
    }
  }, [id, updateNodeData]);

  const handlePromptKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) {
      return;
    }
  }, []);

  const updateGenerationParam = useCallback((key: string, value: unknown) => {
    updateNodeData(id, {
      audioGenerationParams: {
        ...(asPlainRecord(data.audioGenerationParams) ?? {}),
        [key]: value,
      },
      ...(key === currentInputSchema.controlInstruction.field ? { controlInstruction: String(value ?? '') } : {}),
      ...(key === currentInputSchema.promptText.toggleField ? { usePromptText: value === true } : {}),
      ...(key === currentInputSchema.promptText.field ? { promptTextValue: String(value ?? '') } : {}),
    });
  }, [
    currentInputSchema.controlInstruction.field,
    currentInputSchema.promptText.field,
    currentInputSchema.promptText.toggleField,
    data.audioGenerationParams,
    id,
    updateNodeData,
  ]);

  const handleParameterTextChange = useCallback((
    fieldKey: 'controlInstruction' | 'promptText',
    paramKey: string,
    event: ChangeEvent<HTMLTextAreaElement>
  ) => {
    if (composingTextFieldsRef.current.has(fieldKey)) {
      return;
    }
    updateGenerationParam(paramKey, event.target.value);
  }, [updateGenerationParam]);

  const handleParameterTextCompositionEnd = useCallback((
    fieldKey: 'controlInstruction' | 'promptText',
    paramKey: string,
    event: CompositionEvent<HTMLTextAreaElement>
  ) => {
    event.stopPropagation();
    composingTextFieldsRef.current.delete(fieldKey);
    updateGenerationParam(paramKey, event.currentTarget.value);
  }, [updateGenerationParam]);

  const handleParameterTextBlur = useCallback((
    fieldKey: 'controlInstruction' | 'promptText',
    paramKey: string,
    event: FocusEvent<HTMLTextAreaElement>
  ) => {
    composingTextFieldsRef.current.delete(fieldKey);
    updateGenerationParam(paramKey, event.currentTarget.value);
  }, [updateGenerationParam]);

  const assembleAudioGenerationRequest = useCallback((): AudioGenerationRequestAssembly | null => {
    flushPromptDraft();
    const latestPrompt = promptDraftRef.current;
    const latestCanvasState = useCanvasStore.getState();
    const latestNode = latestCanvasState.nodes.find((candidate) => candidate.id === id);
    const latestData = (latestNode?.data ?? data) as AiAudioNodeData;
    const latestSettings = useSettingsStore.getState().audioGenerationSettings;
    const latestModel = latestSettings.models.find((model) => model.enabled && model.id === latestData.modelId)
      ?? latestSettings.models.find((model) => model.enabled && model.id === selectedModel?.id)
      ?? latestSettings.models.find((model) => model.enabled)
      ?? selectedModel;
    const latestReferences = collectInputReferences(id, latestCanvasState.nodes, latestCanvasState.edges)
      .filter((reference) => reference.kind === 'text' && reference.content?.trim());
    const allLatestAudioReferences = collectInputReferences(id, latestCanvasState.nodes, latestCanvasState.edges)
      .filter((reference) => reference.kind === 'audio' && reference.audioUrl?.trim());
    const latestText = buildAudioInputText(
      latestPrompt,
      latestReferences.map((reference) => reference.content ?? '')
    );
    if (!latestModel) {
      setNotice(t('node.aiAudio.noModel'));
      return null;
    }
    const latestInputSchema = resolveAudioInputSchemaFromExtraParams(
      latestModel.extraParams,
      latestModel.providerKind
    );
    const latestGenerationParams = resolveGenerationParams(latestInputSchema, latestModel, latestData);
    const latestVoiceId = !latestInputSchema.voice.enabled
      ? ''
      : latestData.voiceId
      || latestModel.defaultVoiceId
      || latestSettings.selectedVoiceId
      || latestSettings.voices[0]?.id
      || '';
    const latestUsePromptText = latestInputSchema.promptText.enabled
      ? asBoolean(latestGenerationParams[latestInputSchema.promptText.toggleField], false)
      : false;
    const latestPromptTextValue = latestInputSchema.promptText.enabled
      ? asString(latestGenerationParams[latestInputSchema.promptText.field])
      : '';
    const latestControlInstruction = latestInputSchema.controlInstruction.enabled
      ? asString(latestGenerationParams[latestInputSchema.controlInstruction.field])
      : '';
    const latestAudioReferences = latestInputSchema.referenceAudio.enabled
      ? allLatestAudioReferences.slice(0, latestInputSchema.referenceAudio.max)
      : [];
    const latestMode = resolveAudioGenerationMode(
      latestInputSchema,
      latestUsePromptText,
      latestAudioReferences.length
    );
    if (latestInputSchema.text.required && !latestText) {
      setNotice(
        latestInputSchema.promptText.enabled && latestUsePromptText
          ? '请输入要生成的目标文本；参考音频文本只是克隆参考，不是最终朗读内容。'
          : t('node.aiAudio.textRequired')
      );
      return null;
    }
    if (latestInputSchema.referenceAudio.min > latestAudioReferences.length) {
      setNotice(`当前模型至少需要 ${latestInputSchema.referenceAudio.min} 个参考音频`);
      return null;
    }
    if (
      latestInputSchema.promptText.enabled
      && latestUsePromptText
      && latestInputSchema.promptText.requiresReferenceAudio
      && latestAudioReferences.length === 0
    ) {
      setNotice('Ultimate Cloning 需要先连接一个音频卡片');
      return null;
    }
    if (
      latestInputSchema.promptText.enabled
      && latestUsePromptText
      && latestInputSchema.promptText.requiredWhenEnabled
      && !latestPromptTextValue
    ) {
      setNotice('请填写参考音频文本');
      return null;
    }

    const gatewayPayload: GenerateAudioRequest = {
      model: latestModel,
      fallbackBaseUrl: latestSettings.apiBaseUrl,
      text: latestText,
      voiceId: latestVoiceId,
      outputMode: latestModel.outputMode || latestSettings.defaultOutputMode,
      timeoutMs: latestModel.timeoutMs || latestSettings.defaultTimeoutMs,
      referenceAudioUrl: latestAudioReferences[0]?.audioUrl ?? null,
      referenceAudioTitle: latestAudioReferences[0]?.title ?? null,
      extraParams: {
        ...latestGenerationParams,
        audioInputSchema: latestInputSchema,
        controlInstruction: latestInputSchema.promptText.disablesControlInstruction && latestUsePromptText
          ? ''
          : latestControlInstruction,
        usePromptText: latestUsePromptText,
        promptTextValue: latestPromptTextValue,
      },
    };

    return {
      text: latestText,
      latestModel,
      latestSettings,
      latestInputSchema,
      latestGenerationParams,
      latestVoiceId,
      latestUsePromptText,
      latestPromptTextValue,
      latestControlInstruction,
      latestAudioReferences,
      latestMode,
      gatewayPayload,
    };
  }, [data, flushPromptDraft, id, selectedModel, t]);

  const handleGenerate = useCallback(async () => {
    const releaseSubmitLock = acquireGenerationSubmitLock(
      generationSubmitLockKey(id, 'ai-audio-node')
    );
    if (!releaseSubmitLock) {
      return;
    }

    let resultNodeId: string | null = null;
    const generationStartedAt = Date.now();
    setIsGenerating(true);
    setNotice('');
    try {
      const assembled = assembleAudioGenerationRequest();
      if (!assembled) {
        return;
      }
      const {
        text: latestText,
        latestModel,
        latestSettings,
        latestGenerationParams,
        latestVoiceId,
        latestUsePromptText,
        latestPromptTextValue,
        latestControlInstruction,
        latestAudioReferences,
        latestMode,
        gatewayPayload,
      } = assembled;

      resultNodeId = addNode(
        CANVAS_NODE_TYPES.audio,
        findNodePosition(id, 360, 160),
        {
          displayName: t('node.aiAudio.outputTitle'),
          isGenerating: true,
          generationStartedAt,
          generationDurationMs: latestModel.timeoutMs || latestSettings.defaultTimeoutMs,
          generationElapsedMs: null,
          sourcePrompt: latestText,
          sourceTextLength: latestText.length,
          sourceVoiceId: latestVoiceId || null,
          sourceModelId: latestModel.id,
          sourceControlInstruction: latestControlInstruction || null,
          sourcePromptTextValue: latestUsePromptText ? latestPromptTextValue : null,
          sourceAudioMode: latestMode,
          sourceReferenceCount: latestAudioReferences.length,
          sourceReferenceAudioId: latestAudioReferences[0]?.sourceNodeId ?? null,
          sourceReferenceAudioTitle: latestAudioReferences[0]?.title ?? null,
        }
      );
      addEdge(id, resultNodeId);

      const result = await generateAudio(gatewayPayload);
      const generationElapsedMs = Math.max(0, Date.now() - generationStartedAt);
      updateNodeData(resultNodeId, {
        audioUrl: result.audioUrl,
        localAudioUrl: result.audioUrl,
        isGenerating: false,
        generationStartedAt: null,
        generationElapsedMs,
        generationError: null,
        sourcePrompt: latestText,
        sourceTextLength: latestText.length,
        sourceVoiceId: result.voiceId ?? latestVoiceId ?? null,
        sourceModelId: latestModel.id,
        sourceControlInstruction: latestControlInstruction || null,
        sourcePromptTextValue: latestUsePromptText ? latestPromptTextValue : null,
        sourceAudioMode: latestMode,
        sourceReferenceCount: latestAudioReferences.length,
        sourceReferenceAudioId: latestAudioReferences[0]?.sourceNodeId ?? null,
        sourceReferenceAudioTitle: latestAudioReferences[0]?.title ?? null,
      });
      updateNodeData(id, {
        modelId: latestModel.id,
        voiceId: latestVoiceId || null,
        controlInstruction: latestControlInstruction || null,
        usePromptText: latestUsePromptText,
        promptTextValue: latestPromptTextValue || null,
        audioGenerationParams: latestGenerationParams,
        resultNodeId,
        lastRunInputHash: currentInputHash,
        lastError: null,
      });
      setNotice(t('node.aiAudio.generated'));
    } catch (error) {
      const resolvedError = resolveErrorContent(error, t('ai.error'));
      updateNodeData(id, {
        lastError: resolvedError.message,
      });
      if (resultNodeId) {
        const generationElapsedMs = Math.max(0, Date.now() - generationStartedAt);
        updateNodeData(resultNodeId, {
          isGenerating: false,
          generationStartedAt: null,
          generationElapsedMs,
          generationError: resolvedError.message,
          generationErrorDetails: resolvedError.details ?? null,
        });
      }
      setNotice(t('node.aiAudio.generateFailed'));
      void showErrorDialog(resolvedError.message, t('common.error'), resolvedError.details);
    } finally {
      setIsGenerating(false);
      releaseSubmitLock();
    }
  }, [
    addEdge,
    addNode,
    assembleAudioGenerationRequest,
    currentInputHash,
    findNodePosition,
    id,
    t,
    updateNodeData,
  ]);

  useEffect(() => subscribeCanvasGenerationTrigger(
    canvasEventBus,
    CANVAS_NODE_TYPES.aiAudio,
    id,
    handleGenerate,
  ), [handleGenerate, id]);

  const handleOpenPayloadDebug = useCallback(() => {
    try {
      const assembled = assembleAudioGenerationRequest();
      if (!assembled) {
        return;
      }
      const preview = buildAudioGenerationDebugPreview(assembled.gatewayPayload);
      setPayloadDebugText(serializeDebugJson(preview));
      setPayloadDebugCopied(false);
    } catch (debugError) {
      const resolvedError = resolveErrorContent(debugError, t('ai.error'));
      updateNodeData(id, {
        lastError: resolvedError.message,
      });
      void showErrorDialog(
        resolvedError.message,
        t('common.error'),
        resolvedError.details,
      );
    }
  }, [assembleAudioGenerationRequest, id, t, updateNodeData]);

  const handleCopyPayloadDebug = useCallback(async () => {
    if (!payloadDebugText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(payloadDebugText);
      setPayloadDebugCopied(true);
      window.setTimeout(() => setPayloadDebugCopied(false), 1600);
    } catch (copyError) {
      const resolvedError = resolveErrorContent(copyError, t('ai.error'));
      void showErrorDialog(
        resolvedError.message,
        t('common.error'),
        resolvedError.details,
      );
    }
  }, [payloadDebugText, t]);

  return (
    <div
      className={`
        group relative flex h-full flex-col overflow-visible rounded-[var(--node-radius)] border bg-[var(--canvas-node-bg)] p-2 shadow-[var(--canvas-node-shadow)] transition-colors duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[var(--canvas-node-border)] hover:border-[var(--canvas-node-border-hover)]'}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Music2 className="h-4 w-4" />}
        titleText={resolvedTitle}
        rightSlot={showNodePayloadPreview ? (
          <button
            type="button"
            data-canvas-no-marquee="true"
            className="nodrag nowheel inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] text-text-muted shadow-sm transition-colors hover:border-accent/50 hover:bg-[var(--canvas-node-menu-hover)] hover:text-accent"
            title={t('node.aiAudio.payloadDebug')}
            aria-label={t('node.aiAudio.payloadDebug')}
            onClick={(event) => {
              event.stopPropagation();
              if (payloadDebugText !== null) {
                setPayloadDebugText(null);
                return;
              }
              handleOpenPayloadDebug();
            }}
          >
            <Bug className="h-3.5 w-3.5" />
          </button>
        ) : undefined}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div className="relative min-h-[130px] flex-1 rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-2">
        <div className="mb-1 flex items-center justify-between gap-2 px-1 text-[10px] font-medium text-text-muted">
          <span>{currentInputSchema.text.label}</span>
          {incomingTextReferences.length > 0 ? <span>已接入文本 {incomingTextReferences.length}</span> : null}
        </div>
        <textarea
          ref={promptTextareaRef}
          defaultValue={promptDraft}
          onChange={handlePromptChange}
          onCompositionStart={(event) => handleCompositionStart('prompt', event)}
          onCompositionEnd={handlePromptCompositionEnd}
          onBlur={handlePromptBlur}
          onClick={(event) => event.stopPropagation()}
          onFocus={(event) => event.stopPropagation()}
          onKeyDown={handlePromptKeyDown}
          onKeyUp={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          placeholder={currentInputSchema.text.placeholder || t('node.aiAudio.promptPlaceholder') as string}
          className="ui-scrollbar nodrag nopan nowheel h-[calc(100%-22px)] w-full resize-none border-none bg-transparent px-1 py-0.5 pb-5 text-sm leading-6 text-text-dark outline-none placeholder:text-text-muted/80"
          spellCheck={false}
        />
        <span className="pointer-events-none absolute bottom-2 right-3 text-[10px] text-text-muted/60">
          {promptDraft.length}
        </span>
      </div>

      {(currentInputSchema.controlInstruction.enabled
        || currentInputSchema.referenceAudio.enabled
        || currentInputSchema.promptText.enabled) ? (
        <div className="ui-scrollbar mt-2 min-h-0 shrink overflow-y-auto rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-2">
          {currentInputSchema.referenceAudio.enabled
            && (activeAudioReference || currentInputSchema.referenceAudio.min > 0) ? (
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
              <span className="inline-flex max-w-[260px] items-center rounded-full border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 py-0.5">
                <span className="truncate">
                  {activeAudioReference
                    ? `参考：${activeAudioReference.title}`
                    : '需要连接音频卡片'}
                </span>
              </span>
            </div>
          ) : null}

          {currentInputSchema.controlInstruction.enabled ? (
            <label className="block text-[10px] font-medium text-text-muted">
              {currentInputSchema.controlInstruction.label}
              <textarea
                ref={controlInstructionTextareaRef}
                defaultValue={controlInstruction}
                disabled={controlInstructionDisabled}
                onChange={(event) => handleParameterTextChange(
                  'controlInstruction',
                  currentInputSchema.controlInstruction.field,
                  event
                )}
                onCompositionStart={(event) => handleCompositionStart('controlInstruction', event)}
                onCompositionEnd={(event) => handleParameterTextCompositionEnd(
                  'controlInstruction',
                  currentInputSchema.controlInstruction.field,
                  event
                )}
                onBlur={(event) => handleParameterTextBlur(
                  'controlInstruction',
                  currentInputSchema.controlInstruction.field,
                  event
                )}
                onClick={(event) => event.stopPropagation()}
                onFocus={(event) => event.stopPropagation()}
                onKeyDown={handlePromptKeyDown}
                onKeyUp={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                placeholder={currentInputSchema.controlInstruction.placeholder}
                className="ui-scrollbar nodrag nopan nowheel mt-1 h-[58px] w-full resize-none rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 py-1.5 text-xs leading-5 text-text-dark outline-none placeholder:text-text-muted/70 focus:border-accent disabled:cursor-not-allowed disabled:opacity-45"
              />
            </label>
          ) : null}

          {currentInputSchema.promptText.enabled ? (
            <div className="mt-2 rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] p-2">
              <label className="flex items-center gap-2 text-[11px] text-text-muted">
                <UiCheckbox
                  checked={usePromptText}
                  onCheckedChange={(checked) => updateGenerationParam(
                    currentInputSchema.promptText.toggleField,
                    checked
                  )}
                />
                <span>Ultimate Cloning</span>
                {isTranscribingReference ? (
                  <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-accent">
                    <LoaderCircle className="h-3 w-3 animate-spin" />
                    识别参考音频
                  </span>
                ) : null}
              </label>
              {usePromptText ? (
                <div className="mt-2">
                  <div className="mb-1 text-[10px] leading-4 text-text-muted">
                    参考音频内容文本，连接音频后自动识别，可手动修正。
                  </div>
                  <textarea
                    ref={promptTextTextareaRef}
                    defaultValue={promptTextValue}
                    onChange={(event) => handleParameterTextChange(
                      'promptText',
                      currentInputSchema.promptText.field,
                      event
                    )}
                    onCompositionStart={(event) => handleCompositionStart('promptText', event)}
                    onCompositionEnd={(event) => handleParameterTextCompositionEnd(
                      'promptText',
                      currentInputSchema.promptText.field,
                      event
                    )}
                    onBlur={(event) => handleParameterTextBlur(
                      'promptText',
                      currentInputSchema.promptText.field,
                      event
                    )}
                    onClick={(event) => event.stopPropagation()}
                    onFocus={(event) => event.stopPropagation()}
                    onKeyDown={handlePromptKeyDown}
                    onKeyUp={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    placeholder={isTranscribingReference ? '正在自动识别参考音频文本...' : currentInputSchema.promptText.placeholder}
                    className="ui-scrollbar nodrag nopan nowheel h-[48px] w-full resize-none rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] px-2 py-1.5 text-xs leading-5 text-text-dark outline-none placeholder:text-text-muted/70 focus:border-accent"
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 flex min-w-0 shrink-0 flex-wrap items-center gap-1">
        <div className="relative min-w-0 max-w-[170px] shrink">
          <UiButton
            type="button"
            variant="muted"
            className={`w-full ${NODE_CONTROL_CHIP_CLASS}`}
            title={selectedModel?.name ?? t('node.aiAudio.noModel') as string}
            onClick={(event) => {
              event.stopPropagation();
              setModelOpen((open) => !open);
              setVoiceOpen(false);
              setParamsOpen(false);
            }}
          >
            <Settings2 className={NODE_CONTROL_ICON_CLASS} />
            <span className="min-w-0 truncate">{selectedModel?.name ?? t('node.aiAudio.noModel')}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
          </UiButton>
          {modelOpen ? (
            <div
              className="nowheel absolute bottom-full left-0 z-50 mb-1 w-[260px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-1.5 shadow-xl"
              onMouseDown={(event) => event.stopPropagation()}
            >
              {enabledModels.length === 0 ? (
                <div className="flex items-start gap-2 p-2 text-xs leading-5 text-text-muted">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                  <span>{t('node.aiAudio.noModel')}</span>
                </div>
              ) : (
                <div className="ui-scrollbar max-h-[240px] overflow-y-auto pr-1">
                  {enabledModels.map((model) => {
                    const active = selectedModel?.id === model.id;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors ${
                          active
                            ? 'bg-[var(--canvas-node-menu-active)] text-text-dark'
                            : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'
                        }`}
                        onClick={(event) => {
                          event.stopPropagation();
                          const modelInputSchema = resolveAudioInputSchemaFromExtraParams(
                            model.extraParams,
                            model.providerKind
                          );
                          updateNodeData(id, {
                            modelId: model.id,
                            voiceId: !modelInputSchema.voice.enabled
                              ? null
                              : model.defaultVoiceId || data.voiceId || audioSettings.selectedVoiceId || null,
                          });
                          setModelOpen(false);
                          setParamsOpen(false);
                        }}
                      >
                        {active ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" /> : null}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{model.name}</span>
                          <span className="mt-0.5 block truncate text-[11px] text-text-muted">
                            {model.apiBaseUrl}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>

        {currentInputSchema.voice.enabled ? (
        <div className="relative min-w-0 max-w-[160px] shrink">
          <UiButton
            type="button"
            variant="muted"
            className={`w-full ${NODE_CONTROL_CHIP_CLASS}`}
            title={selectedVoice?.name ?? t('node.aiAudio.noVoice') as string}
            onClick={(event) => {
              event.stopPropagation();
              setVoiceOpen((open) => !open);
              setModelOpen(false);
              setParamsOpen(false);
            }}
          >
            <Music2 className={NODE_CONTROL_ICON_CLASS} />
            <span className="min-w-0 truncate">{selectedVoice?.name ?? t('node.aiAudio.noVoice')}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
          </UiButton>
          {voiceOpen ? (
            <div
              className="nowheel absolute bottom-full left-0 z-50 mb-1 w-[280px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-1.5 shadow-xl"
              onMouseDown={(event) => event.stopPropagation()}
            >
              {audioSettings.voices.length === 0 ? (
                <div className="flex items-start gap-2 p-2 text-xs leading-5 text-text-muted">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                  <span>{t('node.aiAudio.noVoice')}</span>
                </div>
              ) : (
                <div className="ui-scrollbar max-h-[260px] overflow-y-auto pr-1">
                  {audioSettings.voices.map((voice) => {
                    const active = selectedVoiceId === voice.id;
                    return (
                      <button
                        key={voice.id}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors ${
                          active
                            ? 'bg-[var(--canvas-node-menu-active)] text-text-dark'
                            : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'
                        }`}
                        title={voice.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          updateNodeData(id, { voiceId: voice.id });
                          setVoiceOpen(false);
                        }}
                      >
                        {active ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" /> : null}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{voice.name}</span>
                          <span className="mt-0.5 block truncate text-[11px] text-text-muted">
                            {voice.category || voice.locale || voice.id}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>
        ) : null}

        {currentInputSchema.parameters.length > 0 ? (
          <div className="relative shrink-0">
            <UiButton
              type="button"
              variant="muted"
              className={`shrink-0 ${NODE_CONTROL_CHIP_CLASS}`}
              title="音频生成参数"
              onClick={(event) => {
                event.stopPropagation();
                setParamsOpen((open) => !open);
                setModelOpen(false);
                setVoiceOpen(false);
              }}
            >
              <Settings2 className={NODE_CONTROL_ICON_CLASS} />
              <span>参数</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
            </UiButton>
            {paramsOpen ? (
              <div
                className="nowheel absolute bottom-full right-0 z-50 mb-1 w-[280px] rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-2 shadow-xl"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <div className="flex flex-col gap-2">
                  {currentInputSchema.parameters.map((parameter) => {
                    const value = resolveParameterValue(parameter, generationParams);
                    if (parameter.kind === 'boolean') {
                      return (
                        <label
                          key={parameter.key}
                          className="flex items-center gap-2 rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 py-1.5 text-xs text-text-muted"
                        >
                          <UiCheckbox
                            checked={value === true}
                            onCheckedChange={(checked) => updateGenerationParam(parameter.key, checked)}
                          />
                          <span className="min-w-0">
                            <span className="block text-text-dark">{parameter.label}</span>
                            {parameter.description ? (
                              <span className="mt-0.5 block text-[10px] leading-4 text-text-muted">
                                {parameter.description}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      );
                    }
                    if (parameter.kind === 'number') {
                      const numericValue = typeof value === 'number' ? value : Number(value);
                      return (
                        <label key={parameter.key} className="block text-[10px] font-medium text-text-muted">
                          {parameter.label}
                          <div className="mt-1 flex items-center gap-2">
                            <input
                              type="range"
                              min={parameter.min}
                              max={parameter.max}
                              step={parameter.step ?? 1}
                              value={Number.isFinite(numericValue) ? numericValue : Number(parameter.defaultValue) || 0}
                              onChange={(event) => updateGenerationParam(parameter.key, Number(event.target.value))}
                              className="nodrag nowheel h-5 min-w-0 flex-1 accent-accent"
                            />
                            <input
                              type="number"
                              min={parameter.min}
                              max={parameter.max}
                              step={parameter.step ?? 1}
                              value={Number.isFinite(numericValue) ? numericValue : Number(parameter.defaultValue) || 0}
                              onChange={(event) => updateGenerationParam(parameter.key, Number(event.target.value))}
                              onClick={(event) => event.stopPropagation()}
                              onFocus={(event) => event.stopPropagation()}
                              onKeyDown={(event) => event.stopPropagation()}
                              className="nodrag nowheel h-7 w-16 rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] px-2 text-right text-xs text-text-dark outline-none focus:border-accent"
                            />
                          </div>
                          {parameter.description ? (
                            <div className="mt-1 text-[10px] leading-4 text-text-muted">
                              {parameter.description}
                            </div>
                          ) : null}
                        </label>
                      );
                    }
                    return (
                      <label key={parameter.key} className="block text-[10px] font-medium text-text-muted">
                        {parameter.label}
                        <input
                          type="text"
                          value={String(value)}
                          onChange={(event) => updateGenerationParam(parameter.key, event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onFocus={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                          className="nodrag nowheel mt-1 h-8 w-full rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] px-2 text-xs text-text-dark outline-none focus:border-accent"
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <UiButton
          variant="primary"
          className={`ml-auto shrink-0 ${NODE_CONTROL_PRIMARY_BUTTON_CLASS}`}
          disabled={isGenerating}
          onClick={(event) => {
            event.stopPropagation();
            void handleGenerate();
          }}
        >
          {isGenerating ? (
            <LoaderCircle className={`${NODE_CONTROL_ICON_CLASS} animate-spin`} />
          ) : (
            <Sparkles className={NODE_CONTROL_ICON_CLASS} />
          )}
          {t('node.aiAudio.generate')}
        </UiButton>
      </div>

      {isStale ? (
        <div className="mt-1 shrink-0 text-xs text-amber-300">{t('node.aiAudio.staleResult')}</div>
      ) : null}
      {notice ? (
        <div className="mt-1 shrink-0 text-xs text-text-muted">{notice}</div>
      ) : null}
      {data.lastError ? (
        <div className="mt-1 shrink-0 text-xs text-text-muted">{data.lastError}</div>
      ) : null}

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle
        minWidth={AI_AUDIO_NODE_MIN_WIDTH}
        minHeight={AI_AUDIO_NODE_MIN_HEIGHT}
        maxWidth={AI_AUDIO_NODE_MAX_WIDTH}
        maxHeight={AI_AUDIO_NODE_MAX_HEIGHT}
      />

      <UiModal
        isOpen={payloadDebugText !== null}
        title={t('node.aiAudio.payloadDebugTitle')}
        onClose={() => setPayloadDebugText(null)}
        widthClassName="w-[min(760px,calc(100vw-32px))]"
        containerClassName="!z-[13050]"
        footer={(
          <>
            <UiButton
              variant="muted"
              size="sm"
              onClick={() => setPayloadDebugText(null)}
            >
              {t('common.close')}
            </UiButton>
            <UiButton
              variant="primary"
              size="sm"
              onClick={() => void handleCopyPayloadDebug()}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              {payloadDebugCopied ? t('nodeToolbar.copied') : t('nodeToolbar.copy')}
            </UiButton>
          </>
        )}
      >
        <div className="flex flex-col gap-2">
          <div className="text-xs text-text-muted">
            {t('node.aiAudio.payloadDebugHint')}
          </div>
          <pre
            className="ui-scrollbar nowheel max-h-[60vh] overflow-auto rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-3 text-xs leading-5 text-text-dark"
            onWheelCapture={(event) => event.stopPropagation()}
            onTouchMoveCapture={(event) => event.stopPropagation()}
          >
            {payloadDebugText}
          </pre>
        </div>
      </UiModal>
    </div>
  );
});

AiAudioNode.displayName = 'AiAudioNode';
