import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Bug, Check, ChevronDown, Copy, LoaderCircle, MoreHorizontal, Sparkles } from 'lucide-react';

import {
  CANVAS_NODE_TYPES,
  type AiTextNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  AI_TEXT_MODEL_OPTIONS,
  buildAiTextUserPrompt,
  buildOpenAiChatPayload,
  collectAiTextInputs,
  computeAiTextInputHash,
} from '@/features/canvas/application/aiText/helpers';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { UiButton, UiChipButton, UiModal } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { isVideoCustomProvider, useCustomProvidersStore } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';

type AiTextNodeProps = NodeProps & {
  id: string;
  data: AiTextNodeData;
  selected?: boolean;
};

interface TextProviderOption {
  id: string;
  label: string;
  models: string[];
}

const AI_TEXT_NODE_MIN_WIDTH = 520;
const AI_TEXT_NODE_MIN_HEIGHT = 280;
const AI_TEXT_NODE_DEFAULT_WIDTH = 680;
const AI_TEXT_NODE_DEFAULT_HEIGHT = 380;
const AI_TEXT_NODE_MAX_WIDTH = 1200;
const AI_TEXT_NODE_MAX_HEIGHT = 1000;
const BUILTIN_PROVIDER_ID = 'openai-chat';
const MAX_VISIBLE_AGENT_CHIPS = 5;

function serializeDebugJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function TextNodeIcon({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center justify-center text-sm font-semibold ${className}`}>
      T
    </span>
  );
}

function waitForPreviewDelay(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 260);
  });
}

export const AiTextNode = memo(({ id, data, selected, width, height }: AiTextNodeProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const textAgents = useSettingsStore((state) => state.textAgents);
  const showNodePayloadPreview = useSettingsStore((state) => state.showNodePayloadPreview);
  const customProviders = useCustomProvidersStore((state) => state.providers);

  const [providerOpen, setProviderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [agentOverflowOpen, setAgentOverflowOpen] = useState(false);
  const [payloadDebugText, setPayloadDebugText] = useState<string | null>(null);
  const [payloadDebugCopied, setPayloadDebugCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const [runningAgentId, setRunningAgentId] = useState<string | null>(null);
  const promptDraftRef = useRef(data.prompt ?? '');
  const promptCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [promptDraft, setPromptDraft] = useState(() => data.prompt ?? '');

  const resolvedTitle = resolveNodeDisplayName(CANVAS_NODE_TYPES.aiText, data);
  const resolvedWidth = Math.max(AI_TEXT_NODE_MIN_WIDTH, Math.round(width ?? AI_TEXT_NODE_DEFAULT_WIDTH));
  const resolvedHeight = Math.max(AI_TEXT_NODE_MIN_HEIGHT, Math.round(height ?? AI_TEXT_NODE_DEFAULT_HEIGHT));

  const enabledAgents = useMemo(
    () => textAgents.filter((agent) => agent.enabled),
    [textAgents]
  );

  const selectedAgent = useMemo(
    () => enabledAgents.find((agent) => agent.id === data.agentId) ?? enabledAgents[0] ?? null,
    [data.agentId, enabledAgents]
  );

  const providerOptions = useMemo<TextProviderOption[]>(() => {
    const options: TextProviderOption[] = [{
      id: BUILTIN_PROVIDER_ID,
      label: 'OpenAI Chat',
      models: [...AI_TEXT_MODEL_OPTIONS],
    }];

    customProviders
      .filter((provider) => !isVideoCustomProvider(provider))
      .forEach((provider) => {
        const models = Array.from(new Set(
          [
            ...provider.models,
            typeof provider.extraParams?.defaultModel === 'string' ? provider.extraParams.defaultModel : '',
          ].filter((model): model is string => Boolean(model && model.trim()))
        ));

        options.push({
          id: provider.id,
          label: provider.label?.trim() || provider.id,
          models,
        });
      });

    return options;
  }, [customProviders]);

  const selectedProvider = useMemo(
    () => providerOptions.find((provider) => provider.id === data.providerId) ?? providerOptions[0] ?? null,
    [data.providerId, providerOptions]
  );

  const availableModelOptions = useMemo(() => {
    const options = new Set<string>(selectedProvider?.models ?? AI_TEXT_MODEL_OPTIONS);
    if (data.model?.trim()) {
      options.add(data.model.trim());
    }
    return Array.from(options);
  }, [data.model, selectedProvider?.models]);

  const visibleAgents = useMemo(
    () => enabledAgents.slice(0, MAX_VISIBLE_AGENT_CHIPS),
    [enabledAgents]
  );

  const overflowAgents = useMemo(
    () => enabledAgents.slice(MAX_VISIBLE_AGENT_CHIPS),
    [enabledAgents]
  );

  const inputParts = useMemo(
    () => collectAiTextInputs(id, nodes, edges, selectedAgent, textAgents),
    [edges, id, nodes, selectedAgent, textAgents]
  );

  const currentInputHash = useMemo(
    () => computeAiTextInputHash({
      agentId: selectedAgent?.id ?? data.agentId ?? null,
      providerId: selectedProvider?.id ?? data.providerId ?? null,
      model: data.model,
      agentPrompt: selectedAgent?.prompt ?? '',
      userPrompt: promptDraft,
      parts: inputParts,
    }),
    [data.agentId, data.model, data.providerId, inputParts, promptDraft, selectedAgent, selectedProvider]
  );

  const isStale = Boolean(data.lastRunInputHash) && data.lastRunInputHash !== currentInputHash;
  const textInputCount = inputParts.filter((part) => part.kind === 'text').length;
  const imageInputCount = inputParts.filter((part) => part.kind === 'image').length;
  const isGeneratingPreview = runningAgentId !== null;

  const clearPromptCommitTimer = useCallback(() => {
    if (promptCommitTimerRef.current) {
      window.clearTimeout(promptCommitTimerRef.current);
      promptCommitTimerRef.current = null;
    }
  }, []);

  const flushPromptDraft = useCallback((nextPrompt = promptDraftRef.current) => {
    clearPromptCommitTimer();
    promptDraftRef.current = nextPrompt;
    if (nextPrompt !== (data.prompt ?? '')) {
      updateNodeData(id, { prompt: nextPrompt });
    }
  }, [clearPromptCommitTimer, data.prompt, id, updateNodeData]);

  const schedulePromptDraftCommit = useCallback(() => {
    clearPromptCommitTimer();
    promptCommitTimerRef.current = window.setTimeout(() => {
      promptCommitTimerRef.current = null;
      const latestPrompt = promptDraftRef.current;
      if (latestPrompt !== (data.prompt ?? '')) {
        updateNodeData(id, { prompt: latestPrompt });
      }
    }, 250);
  }, [clearPromptCommitTimer, data.prompt, id, updateNodeData]);

  useEffect(() => {
    const externalPrompt = data.prompt ?? '';
    if (externalPrompt !== promptDraftRef.current) {
      promptDraftRef.current = externalPrompt;
      setPromptDraft(externalPrompt);
    }
  }, [data.prompt]);

  useEffect(() => {
    return () => {
      clearPromptCommitTimer();
    };
  }, [clearPromptCommitTimer]);

  useEffect(() => {
    if (!selectedProvider && providerOptions.length > 0) {
      updateNodeData(id, { providerId: providerOptions[0].id });
      return;
    }

    if (!data.agentId && selectedAgent) {
      updateNodeData(id, { agentId: selectedAgent.id });
    }
  }, [data.agentId, id, providerOptions, selectedAgent, selectedProvider, updateNodeData]);

  useEffect(() => {
    if (!selectedProvider) {
      return;
    }

    if (!data.providerId) {
      updateNodeData(id, { providerId: selectedProvider.id });
      return;
    }

    if (availableModelOptions.length === 0) {
      return;
    }

    if (!data.model || !availableModelOptions.includes(data.model)) {
      updateNodeData(id, { model: availableModelOptions[0] });
    }
  }, [availableModelOptions, data.model, data.providerId, id, selectedProvider, updateNodeData]);

  useEffect(() => {
    if (!providerOpen && !modelOpen && !agentOverflowOpen) {
      return;
    }

    const handleOutside = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as globalThis.Node)) {
        return;
      }
      setProviderOpen(false);
      setModelOpen(false);
      setAgentOverflowOpen(false);
    };

    document.addEventListener('mousedown', handleOutside, true);
    return () => document.removeEventListener('mousedown', handleOutside, true);
  }, [agentOverflowOpen, modelOpen, providerOpen]);

  const buildPayloadPreview = useCallback((agentOverride?: typeof selectedAgent, modelOverride?: string) => {
    const agent = agentOverride ?? selectedAgent;
    const previewParts = collectAiTextInputs(id, nodes, edges, agent, textAgents);
    const previewModel = modelOverride ?? data.model;
    const previewInputHash = computeAiTextInputHash({
      agentId: agent?.id ?? data.agentId ?? null,
      providerId: selectedProvider?.id ?? data.providerId ?? null,
      model: previewModel,
      agentPrompt: agent?.prompt ?? '',
      userPrompt: promptDraftRef.current,
      parts: previewParts,
    });
    const previewComposedPrompt = buildAiTextUserPrompt(previewParts, promptDraftRef.current);
    const payload = buildOpenAiChatPayload({
      model: previewModel,
      agentPrompt: agent?.prompt ?? '',
      userPrompt: promptDraftRef.current,
      parts: previewParts,
    });

    return {
      provider: selectedProvider
        ? {
          id: selectedProvider.id,
          label: selectedProvider.label,
        }
        : null,
      agent: agent
        ? {
          id: agent.id,
          name: agent.name,
        }
        : null,
      inputHash: previewInputHash,
      textPrompt: previewComposedPrompt,
      payload,
    };
  }, [
    data.agentId,
    data.model,
    data.providerId,
    edges,
    id,
    nodes,
    selectedAgent,
    selectedProvider,
    textAgents,
  ]);

  const runAgent = useCallback(async (agentId?: string | null) => {
    const agent = enabledAgents.find((item) => item.id === agentId) ?? selectedAgent ?? enabledAgents[0] ?? null;
    if (!agent) {
      setNotice('暂无可用 Agent');
      return;
    }
    if (!agent.prompt.trim()) {
      setNotice('当前 Agent 缺少系统提示词');
      return;
    }

    const nextModel = data.model || availableModelOptions[0] || AI_TEXT_MODEL_OPTIONS[0];

    setRunningAgentId(agent.id);
    setNotice('');
    updateNodeData(id, {
      agentId: agent.id,
      model: nextModel,
    });

    try {
      await waitForPreviewDelay();
      const payloadPreview = buildPayloadPreview(agent, nextModel);
      updateNodeData(id, {
        agentId: agent.id,
        model: nextModel,
        lastPreparedPayload: payloadPreview,
        lastRunInputHash: payloadPreview.inputHash,
        lastError: null,
      });
      setNotice('已生成当前 Agent 的 payload 预览');
      setPayloadDebugText(serializeDebugJson(payloadPreview));
    } finally {
      setRunningAgentId(null);
    }
  }, [
    availableModelOptions,
    buildPayloadPreview,
    currentInputHash,
    data.model,
    enabledAgents,
    id,
    selectedAgent,
    updateNodeData,
  ]);

  useEffect(() => {
    return canvasEventBus.subscribe('generation-node/trigger', ({ nodeId }) => {
      if (nodeId === id) {
        void runAgent(selectedAgent?.id);
      }
    });
  }, [id, runAgent, selectedAgent?.id]);

  const copyPayload = async () => {
    if (!payloadDebugText) {
      return;
    }
    await navigator.clipboard.writeText(payloadDebugText);
    setPayloadDebugCopied(true);
    window.setTimeout(() => setPayloadDebugCopied(false), 1200);
  };

  const handleOpenPayloadDebug = useCallback(() => {
    if (payloadDebugText !== null) {
      setPayloadDebugText(null);
      return;
    }

    const existingPayload = data.lastPreparedPayload ?? buildPayloadPreview();
    setPayloadDebugText(serializeDebugJson(existingPayload));
  }, [buildPayloadPreview, data.lastPreparedPayload, payloadDebugText]);

  return (
    <div
      ref={rootRef}
      className={`
        group relative flex h-full flex-col overflow-visible rounded-[var(--node-radius)] border bg-[var(--canvas-node-bg)] p-2 shadow-[var(--canvas-node-shadow)] transition-colors duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[var(--canvas-node-border)] hover:border-[var(--canvas-node-border-hover)]'}
      `}
      style={{ width: `${resolvedWidth}px`, height: `${resolvedHeight}px` }}
      onClick={() => setSelectedNode(id)}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<TextNodeIcon className="h-4 w-4" />}
        titleText={resolvedTitle}
        rightSlot={showNodePayloadPreview ? (
          <button
            type="button"
            data-canvas-no-marquee="true"
            className="nodrag nowheel inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--canvas-node-border)] bg-[var(--canvas-node-menu-bg)] text-text-muted shadow-sm transition-colors hover:border-accent/50 hover:bg-[var(--canvas-node-menu-hover)] hover:text-accent"
            title="查看 payload"
            aria-label="查看 payload"
            onClick={(event) => {
              event.stopPropagation();
              handleOpenPayloadDebug();
            }}
          >
            <Bug className="h-3.5 w-3.5" />
          </button>
        ) : undefined}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div className="mb-2 shrink-0 rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {visibleAgents.map((agent) => {
                const active = selectedAgent?.id === agent.id;
                const running = runningAgentId === agent.id;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    disabled={isGeneratingPreview && !running}
                    className={`inline-flex max-w-[156px] items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium text-white transition-colors ${
                      active
                        ? 'border-accent bg-accent shadow-[0_0_0_1px_rgba(59,130,246,0.34)]'
                        : 'border-sky-500/55 bg-sky-500/90 hover:bg-sky-500'
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                    title={agent.name}
                    onClick={(event) => {
                      event.stopPropagation();
                      void runAgent(agent.id);
                    }}
                  >
                    {running ? (
                      <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    ) : null}
                    <span className="truncate">{agent.name}</span>
                  </button>
                );
              })}

              {overflowAgents.length > 0 ? (
                <div className="relative shrink-0">
                  <button
                    type="button"
                    className="inline-flex items-center rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 py-1 text-[11px] text-[var(--canvas-node-button-text)] transition-colors hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]"
                    title="更多 Agent"
                    onClick={(event) => {
                      event.stopPropagation();
                      setAgentOverflowOpen((open) => !open);
                      setProviderOpen(false);
                      setModelOpen(false);
                    }}
                  >
                    <MoreHorizontal className="mr-1 h-3 w-3" />
                    +{overflowAgents.length}
                  </button>
                  {agentOverflowOpen ? (
                    <div
                      className="nowheel absolute left-0 top-full z-50 mt-1 w-[220px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-1.5 shadow-xl"
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      <div className="ui-scrollbar max-h-[220px] overflow-y-auto pr-1">
                        {overflowAgents.map((agent) => {
                          const active = selectedAgent?.id === agent.id;
                          const running = runningAgentId === agent.id;
                          return (
                            <button
                              key={agent.id}
                              type="button"
                              disabled={isGeneratingPreview && !running}
                              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                                active
                                  ? 'bg-[var(--canvas-node-menu-active)] text-text-dark'
                                  : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'
                              } disabled:cursor-not-allowed disabled:opacity-60`}
                              onClick={(event) => {
                                event.stopPropagation();
                                void runAgent(agent.id);
                                setAgentOverflowOpen(false);
                              }}
                            >
                              {running ? (
                                <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
                              ) : active ? (
                                <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                              ) : null}
                              <span className="min-w-0 truncate">{agent.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {enabledAgents.length === 0 ? (
                <span className="text-xs text-text-muted">暂无可用 Agent</span>
              ) : null}
            </div>

            {!Boolean(data.isToolbarCollapsed) && selectedAgent ? (
              <>
                <div className="mt-2 line-clamp-2 whitespace-pre-wrap break-words text-xs leading-5 text-text-muted">
                  {selectedAgent?.prompt?.trim() || '暂无可用 Agent'}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center rounded-full border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 py-0.5 text-[11px] text-text-muted">
                    文本输入 {textInputCount}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 py-0.5 text-[11px] text-text-muted">
                    图片输入 {imageInputCount}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] px-2 py-0.5 text-[11px] text-text-muted">
                    Hash {currentInputHash}
                  </span>
                </div>
              </>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="nodrag nowheel inline-flex h-8 w-8 items-center justify-center rounded-[6px] border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-text-muted transition-colors hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)] hover:text-text-dark"
              onClick={(event) => {
                event.stopPropagation();
                updateNodeData(id, { isToolbarCollapsed: !data.isToolbarCollapsed });
              }}
              title={data.isToolbarCollapsed ? '展开功能区' : '收起功能区'}
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${data.isToolbarCollapsed ? '-rotate-90' : 'rotate-0'}`} />
            </button>
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-2">
        <textarea
          value={promptDraft}
          onChange={(event) => {
            const nextPrompt = event.target.value;
            promptDraftRef.current = nextPrompt;
            setPromptDraft(nextPrompt);
            schedulePromptDraftCommit();
          }}
          onBlur={() => flushPromptDraft()}
          onClick={(event) => event.stopPropagation()}
          onFocus={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return;
            }
            event.stopPropagation();
          }}
          onKeyUp={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          placeholder="输入这次任务的 prompt"
          className="ui-scrollbar nodrag nopan nowheel h-full w-full resize-none border-none bg-transparent px-1 py-0.5 text-sm leading-6 text-text-dark outline-none placeholder:text-text-muted/80"
          spellCheck={false}
        />
      </div>

      <div className="mt-2 flex min-w-0 shrink-0 items-center gap-1">
        <div className="relative min-w-0 max-w-[150px] shrink">
          <UiChipButton
            active={providerOpen}
            className={`w-full ${NODE_CONTROL_CHIP_CLASS}`}
            title={selectedProvider?.label ?? '选择 Provider'}
            onClick={(event) => {
              event.stopPropagation();
              setProviderOpen((open) => !open);
              setModelOpen(false);
              setAgentOverflowOpen(false);
            }}
          >
            <TextNodeIcon className={NODE_CONTROL_ICON_CLASS} />
            <span className="min-w-0 truncate">{selectedProvider?.label ?? '选择 Provider'}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
          </UiChipButton>
          {providerOpen ? (
            <div
              className="nowheel absolute bottom-full left-0 z-50 mb-1 min-w-[190px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-1.5 shadow-xl"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="ui-scrollbar max-h-[220px] overflow-y-auto pr-1">
                {providerOptions.map((provider) => {
                  const active = selectedProvider?.id === provider.id;
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                        active
                          ? 'bg-[var(--canvas-node-menu-active)] text-text-dark'
                          : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'
                      }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        updateNodeData(id, {
                          providerId: provider.id,
                          model: provider.models[0] ?? data.model,
                        });
                        setProviderOpen(false);
                      }}
                    >
                      {active ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" /> : null}
                      <span className="min-w-0 truncate">{provider.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        <div className="relative min-w-0 max-w-[180px] shrink">
          <UiChipButton
            active={modelOpen}
            className={`w-full ${NODE_CONTROL_CHIP_CLASS}`}
            title={data.model || '选择模型'}
            onClick={(event) => {
              event.stopPropagation();
              setModelOpen((open) => !open);
              setProviderOpen(false);
              setAgentOverflowOpen(false);
            }}
          >
            <span className="min-w-0 truncate">{data.model || '选择模型'}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
          </UiChipButton>
          {modelOpen ? (
            <div
              className="nowheel absolute bottom-full left-0 z-50 mb-1 w-[280px] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-1.5 shadow-xl"
              onMouseDown={(event) => event.stopPropagation()}
            >
              {availableModelOptions.length === 0 ? (
                <div className="flex items-start gap-2 p-2 text-xs leading-5 text-text-muted">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                  <span>当前 Provider 还没有可选模型</span>
                </div>
              ) : (
                <div className="ui-scrollbar max-h-[240px] overflow-y-auto pr-1">
                  {availableModelOptions.map((model) => {
                    const active = data.model === model;
                    return (
                      <button
                        key={model}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors ${
                          active
                            ? 'bg-[var(--canvas-node-menu-active)] text-text-dark'
                            : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'
                        }`}
                        onClick={(event) => {
                          event.stopPropagation();
                          updateNodeData(id, { model });
                          setModelOpen(false);
                        }}
                      >
                        {active ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" /> : null}
                        <span className="min-w-0 truncate">{model}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <UiButton
          variant="primary"
          className={`ml-auto shrink-0 ${NODE_CONTROL_PRIMARY_BUTTON_CLASS}`}
          disabled={isGeneratingPreview}
          onClick={(event) => {
            event.stopPropagation();
            void runAgent(selectedAgent?.id);
          }}
        >
          {isGeneratingPreview ? (
            <LoaderCircle className={`${NODE_CONTROL_ICON_CLASS} animate-spin`} />
          ) : (
            <Sparkles className={NODE_CONTROL_ICON_CLASS} />
          )}
          生成
        </UiButton>
      </div>

      {isStale ? (
        <div className="mt-1 shrink-0 text-xs text-amber-300">结果可能已过期</div>
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
        minWidth={AI_TEXT_NODE_MIN_WIDTH}
        minHeight={AI_TEXT_NODE_MIN_HEIGHT}
        maxWidth={AI_TEXT_NODE_MAX_WIDTH}
        maxHeight={AI_TEXT_NODE_MAX_HEIGHT}
      />

      <UiModal
        isOpen={payloadDebugText !== null}
        title="OpenAI Chat Payload"
        onClose={() => setPayloadDebugText(null)}
        widthClassName="w-[calc(100vw-32px)] max-w-[1200px]"
        containerClassName="!z-[13050]"
        footer={(
          <>
            <UiButton variant="muted" size="sm" onClick={() => setPayloadDebugText(null)}>
              关闭
            </UiButton>
            <UiButton variant="primary" size="sm" onClick={() => void copyPayload()}>
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              {payloadDebugCopied ? (
                <>
                  <Check className="mr-1 h-3.5 w-3.5" />
                  已复制
                </>
              ) : '复制'}
            </UiButton>
          </>
        )}
      >
        <pre className="ui-scrollbar nowheel max-h-[60vh] overflow-auto rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] p-3 text-xs leading-5 text-text-dark">
          {payloadDebugText}
        </pre>
      </UiModal>
    </div>
  );
});

AiTextNode.displayName = 'AiTextNode';
