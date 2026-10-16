import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';

import {
  isChatCustomProvider,
  useCustomProvidersStore,
  type CustomProviderChatModelMetadata,
  type CustomProviderConfig,
} from '@/stores/customProvidersStore';
import {
  fetchCustomProviderModels,
  testCustomChatProviderConnectivity,
  type CustomProviderModelListResult,
  type CustomProviderTestResult,
} from '@/features/canvas/infrastructure/customProviderGateway';
import {
  normalizeProviderBaseUrl,
  normalizeProviderEndpointPath,
} from '@/features/canvas/application/providerUrl';

type ChatProviderKind =
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'anthropic-messages'
  | 'google-gemini';

interface ChatModelDraft {
  id: string;
  supportsMultimodal: boolean;
  contextWindow: string;
  maxOutputTokens: string;
  description: string;
}

interface ChatProviderTemplate {
  key: ChatProviderKind;
  label: string;
  hint: string;
  labelValue: string;
  baseUrl: string;
  endpointPath: string;
  modelListEndpointPath: string;
  apiStyle: string;
  models: ChatModelDraft[];
  extraParams: Record<string, unknown>;
  note: string;
}

const DEFAULT_CHAT_CONTEXT_WINDOW = '128000';
const DEFAULT_CHAT_MAX_OUTPUT_TOKENS = '8192';

function inferSupportsMultimodal(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /(gpt-(?:4o|4\.1|5|5\.4|5\.5)|gemini|claude-(?:3|4)|sonnet|opus|haiku|vision|multimodal|vl\b|qwen.*vl|llava)/i.test(id);
}

function emptyModelDraft(id = ''): ChatModelDraft {
  return {
    id,
    supportsMultimodal: id ? inferSupportsMultimodal(id) : false,
    contextWindow: DEFAULT_CHAT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_CHAT_MAX_OUTPUT_TOKENS,
    description: '',
  };
}

const CHAT_PROVIDER_TEMPLATES: ChatProviderTemplate[] = [
  {
    key: 'openai-responses',
    label: 'OpenAI Responses',
    hint: 'POST /v1/responses，body: { model, input }',
    labelValue: 'OpenAI Responses',
    baseUrl: 'https://api.openai.com',
    endpointPath: '/v1/responses',
    modelListEndpointPath: '/v1/models',
    apiStyle: 'openai-compatible',
    models: [],
    extraParams: {
      providerKind: 'openai-responses',
      requestComposer: 'chat-openai-responses',
    },
    note: '用于 OpenAI Responses API 或兼容代理。测试连通会发送 { model, input: "..." }，后续多模态输入可扩展为 input 数组。',
  },
  {
    key: 'openai-chat-completions',
    label: 'OpenAI Chat Completions',
    hint: 'POST /v1/chat/completions，messages 格式',
    labelValue: 'OpenAI Chat Completions',
    baseUrl: 'https://api.openai.com',
    endpointPath: '/v1/chat/completions',
    modelListEndpointPath: '/v1/models',
    apiStyle: 'openai-compatible',
    models: [],
    extraParams: {
      providerKind: 'openai-chat-completions',
      requestComposer: 'chat-openai-compatible',
    },
    note: '用于 OpenAI Chat Completions API 或兼容代理。测试连通会发送 messages: [{ role: "user", content: "..." }]。',
  },
  {
    key: 'anthropic-messages',
    label: 'Anthropic Messages',
    hint: 'POST /v1/messages，x-api-key + anthropic-version',
    labelValue: 'Anthropic Messages',
    baseUrl: 'https://api.anthropic.com',
    endpointPath: '/v1/messages',
    modelListEndpointPath: '/v1/models',
    apiStyle: 'anthropic',
    models: [],
    extraParams: {
      providerKind: 'anthropic-messages',
      requestComposer: 'chat-anthropic-messages',
    },
    note: '用于 Anthropic Messages API。测试连通会带 x-api-key、anthropic-version: 2023-06-01，并发送 max_tokens + messages。',
  },
  {
    key: 'google-gemini',
    label: 'Google Gemini',
    hint: 'POST /v1beta/models/{model}:generateContent?key=...',
    labelValue: 'Google Gemini Chat',
    baseUrl: 'https://generativelanguage.googleapis.com',
    endpointPath: '/v1beta/models/{model}:generateContent',
    modelListEndpointPath: '/v1beta/models',
    apiStyle: 'google-gemini',
    models: [],
    extraParams: {
      providerKind: 'google-gemini',
      requestComposer: 'chat-google-gemini',
    },
    note: '用于 Google Gemini generateContent。测试连通会把 API Key 放到 key 查询参数，模型列表会把 models/ 前缀去掉后保存。',
  },
];

function templateByKey(key: ChatProviderKind): ChatProviderTemplate {
  return CHAT_PROVIDER_TEMPLATES.find((template) => template.key === key) ?? CHAT_PROVIDER_TEMPLATES[0];
}

function generateProviderId(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  values.forEach((value) => {
    const text = value.trim().replace(/^models\//, '');
    if (!text || seen.has(text)) return;
    seen.add(text);
    next.push(text);
  });
  return next;
}

function parseJsonObject(text: string): { ok: boolean; value: Record<string, unknown>; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, value: {}, error: '必须是 JSON 对象，例如 { "temperature": 0.2 }' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false, value: {}, error: error instanceof Error ? error.message : 'JSON 格式不正确' };
  }
}

function stringifyJsonObject(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '{}';
  return JSON.stringify(value, null, 2);
}

function numericOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function modelDraftsFromProvider(provider: CustomProviderConfig): ChatModelDraft[] {
  const metadata = provider.modelMetadata ?? {};
  return (provider.models.length > 0 ? provider.models : []).map((id) => {
    const item = metadata[id] ?? {};
    return {
      id,
      supportsMultimodal: Boolean(item.supportsMultimodal ?? inferSupportsMultimodal(id)),
      contextWindow: item.contextWindow ? String(item.contextWindow) : DEFAULT_CHAT_CONTEXT_WINDOW,
      maxOutputTokens: item.maxOutputTokens ? String(item.maxOutputTokens) : DEFAULT_CHAT_MAX_OUTPUT_TOKENS,
      description: item.description ?? '',
    };
  });
}

function metadataFromModels(models: ChatModelDraft[]): Record<string, CustomProviderChatModelMetadata> {
  return Object.fromEntries(models.map((model) => [
    model.id,
    {
      supportsMultimodal: model.supportsMultimodal,
      contextWindow: numericOrNull(model.contextWindow),
      maxOutputTokens: numericOrNull(model.maxOutputTokens),
      description: model.description.trim() || null,
    },
  ]));
}

export const ChatProvidersSection = memo(function ChatProvidersSection() {
  const providers = useCustomProvidersStore((state) => state.providers);
  const pendingEditId = useCustomProvidersStore((state) => state.pendingEditId);
  const addProvider = useCustomProvidersStore((state) => state.addProvider);
  const updateProvider = useCustomProvidersStore((state) => state.updateProvider);
  const setPendingEditId = useCustomProvidersStore((state) => state.setPendingEditId);

  const initialTemplate = CHAT_PROVIDER_TEMPLATES[0];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState(initialTemplate.labelValue);
  const [baseUrl, setBaseUrl] = useState(initialTemplate.baseUrl);
  const [endpointPath, setEndpointPath] = useState(initialTemplate.endpointPath);
  const [modelListEndpointPath, setModelListEndpointPath] = useState(initialTemplate.modelListEndpointPath);
  const [apiStyle, setApiStyle] = useState(initialTemplate.apiStyle);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ChatModelDraft[]>([]);
  const [newModelId, setNewModelId] = useState('');
  const [newModelDescription, setNewModelDescription] = useState('');
  const [templateExtraParams, setTemplateExtraParams] = useState<Record<string, unknown>>(initialTemplate.extraParams);
  const [providerNote, setProviderNote] = useState(initialTemplate.note);
  const [defaultParamsText, setDefaultParamsText] = useState('{}');
  const [savedFlash, setSavedFlash] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelFetchResult, setModelFetchResult] = useState<CustomProviderModelListResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CustomProviderTestResult | null>(null);

  const parsedDefaultParams = useMemo(() => parseJsonObject(defaultParamsText), [defaultParamsText]);

  const buildConfig = useCallback((id: string, requireModels = true): CustomProviderConfig | null => {
    const cleanModels = models
      .map((model) => ({ ...model, id: model.id.trim().replace(/^models\//, '') }))
      .filter((model) => model.id);
    if (!label.trim() || !baseUrl.trim() || (requireModels && cleanModels.length === 0) || !parsedDefaultParams.ok) {
      return null;
    }
    const modelMetadata = metadataFromModels(cleanModels);
    const modelDescriptions = Object.fromEntries(
      cleanModels
        .filter((model) => model.description.trim())
        .map((model) => [model.id, model.description.trim()])
    );
    return {
      id,
      label: label.trim(),
      mediaType: 'chat',
      baseUrl: normalizeProviderBaseUrl(baseUrl),
      endpointPath: normalizeProviderEndpointPath(endpointPath),
      modelListEndpointPath: normalizeProviderEndpointPath(modelListEndpointPath),
      httpMethod: 'POST',
      apiKey,
      apiStyle,
      models: cleanModels.map((model) => model.id),
      supportsWebSearch: false,
      extraHeaders: {},
      queryParams: {},
      responseFormat: 'generic',
      modelMetadata,
      extraParams: {
        ...templateExtraParams,
        providerConfigVersion: 'chat-v1',
        mediaType: 'chat',
        modelDescriptions,
        defaultRequestParams: parsedDefaultParams.value,
      },
      note: providerNote,
    };
  }, [
    apiKey,
    apiStyle,
    baseUrl,
    endpointPath,
    label,
    modelListEndpointPath,
    models,
    parsedDefaultParams,
    providerNote,
    templateExtraParams,
  ]);

  const resetToTemplate = useCallback((key: ChatProviderKind) => {
    const template = templateByKey(key);
    setEditingId(null);
    setLabel(template.labelValue);
    setBaseUrl(template.baseUrl);
    setEndpointPath(template.endpointPath);
    setModelListEndpointPath(template.modelListEndpointPath);
    setApiStyle(template.apiStyle);
    setApiKey('');
    setModels(template.models.map((model) => ({ ...model })));
    setNewModelId('');
    setNewModelDescription('');
    setTemplateExtraParams(template.extraParams);
    setProviderNote(template.note);
    setDefaultParamsText('{}');
    setModelFetchResult(null);
    setTestResult(null);
  }, []);

  useEffect(() => {
    if (!pendingEditId) return;
    const provider = providers.find((item) => item.id === pendingEditId);
    if (!provider || !isChatCustomProvider(provider)) return;
    setEditingId(provider.id);
    setLabel(provider.label);
    setBaseUrl(provider.baseUrl);
    setEndpointPath(provider.endpointPath ?? '');
    setModelListEndpointPath(provider.modelListEndpointPath ?? '');
    setApiStyle(provider.apiStyle || 'openai-compatible');
    setApiKey(provider.apiKey);
    setModels(modelDraftsFromProvider(provider));
    setTemplateExtraParams({ ...(provider.extraParams ?? {}) });
    setProviderNote(provider.note ?? '');
    setDefaultParamsText(stringifyJsonObject(provider.extraParams?.defaultRequestParams));
    setModelFetchResult(null);
    setTestResult(null);
    setPendingEditId(null);
  }, [pendingEditId, providers, setPendingEditId]);

  const handleAddModel = useCallback(() => {
    const id = newModelId.trim().replace(/^models\//, '');
    if (!id || models.some((model) => model.id === id)) return;
    setModels((current) => [
      ...current,
      {
        ...emptyModelDraft(id),
        description: newModelDescription.trim(),
      },
    ]);
    setNewModelId('');
    setNewModelDescription('');
  }, [models, newModelDescription, newModelId]);

  const handleFetchModels = useCallback(async () => {
    const draftConfig = buildConfig(editingId ?? 'chat-model-fetch-draft', false);
    if (!draftConfig) return;
    setFetchingModels(true);
    setModelFetchResult(null);
    try {
      const result = await fetchCustomProviderModels(draftConfig);
      setModelFetchResult(result);
      if (result.ok && result.models.length > 0) {
        const fetchedIds = uniqueStrings(result.models);
        setModels((current) => {
          const byId = new Map(current.map((model) => [model.id, model]));
          return fetchedIds.map((id) => byId.get(id) ?? emptyModelDraft(id));
        });
      }
    } catch (error) {
      setModelFetchResult({
        ok: false,
        models: [],
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setFetchingModels(false);
    }
  }, [buildConfig, editingId]);

  const handleTest = useCallback(async () => {
    const draftConfig = buildConfig(editingId ?? 'chat-test-draft');
    if (!draftConfig) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testCustomChatProviderConnectivity(draftConfig);
      setTestResult(result);
    } catch (error) {
      setTestResult({
        ok: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  }, [buildConfig, editingId]);

  const handleSave = useCallback(() => {
    const config = buildConfig(editingId ?? generateProviderId());
    if (!config) return;
    if (editingId) {
      updateProvider(editingId, config);
    } else {
      addProvider(config);
    }
    setEditingId(null);
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1600);
  }, [addProvider, buildConfig, editingId, updateProvider]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-dark">文本对话供应商</h2>
        <p className="mt-1 text-xs leading-5 text-text-muted">
          选择一个对话 API 格式作为起点，填入 Base URL、Key 和模型。这里仅保存配置并测试文本连通，暂不接入画布对话 UI。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {CHAT_PROVIDER_TEMPLATES.map((template) => (
          <button
            key={template.key}
            type="button"
            onClick={() => resetToTemplate(template.key)}
            className="rounded-lg border border-border-dark bg-bg-dark p-3 text-left transition-colors hover:border-accent/55 hover:bg-accent/5"
            title={template.hint}
          >
            <div className="text-xs font-medium text-text-dark">{template.label}</div>
            <div className="mt-1 text-[11px] leading-4 text-text-muted">{template.hint}</div>
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">显示名</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-hidden focus:border-accent"
              placeholder="例如：我的文本模型代理"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">API Key</span>
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-hidden focus:border-accent"
              placeholder="sk-..."
              type="password"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">Base URL（只填基础地址）</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 text-sm text-text-dark outline-hidden focus:border-accent"
              placeholder="https://api.openai.com"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">对话接口路径</span>
            <input
              value={endpointPath}
              onChange={(event) => setEndpointPath(event.target.value)}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 font-mono text-sm text-text-dark outline-hidden focus:border-accent"
              placeholder="/v1/chat/completions"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">模型列表路径（可留空）</span>
            <input
              value={modelListEndpointPath}
              onChange={(event) => setModelListEndpointPath(event.target.value)}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 font-mono text-sm text-text-dark outline-hidden focus:border-accent"
              placeholder="/v1/models"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted">请求格式</span>
            <input
              value={apiStyle}
              onChange={(event) => setApiStyle(event.target.value)}
              className="h-9 w-full rounded-md border border-border-dark bg-surface-dark px-3 font-mono text-sm text-text-dark outline-hidden focus:border-accent"
              placeholder="openai-compatible / anthropic / google-gemini"
            />
          </label>
        </div>

        <div className="mt-4 rounded-lg border border-border-dark bg-surface-dark p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-text-muted">模型列表与对话能力</div>
            <button
              type="button"
              onClick={handleFetchModels}
              disabled={fetchingModels || !apiKey.trim() || !baseUrl.trim()}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-white/5 px-2 text-[11px] text-text-dark hover:bg-white/10 disabled:opacity-40"
              title="用当前配置请求模型列表，并覆盖下方模型 ID"
            >
              {fetchingModels ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              获取模型
            </button>
          </div>
          {modelFetchResult && (
            <div className={`mb-2 rounded border px-2 py-1 text-[10px] ${
              modelFetchResult.ok
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}>
              {modelFetchResult.ok ? `已获取 ${modelFetchResult.models.length} 个模型` : (modelFetchResult.errorMessage ?? '获取失败')}
            </div>
          )}
          <div className="space-y-2">
            {models.map((model) => (
              <div key={model.id} className="rounded-md border border-border-dark bg-bg-dark p-2">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)_auto]">
                  <div className="min-w-0 rounded-md border border-border-dark bg-surface-dark px-2 py-1.5 font-mono text-[11px] text-text-dark">
                    <div className="truncate">{model.id}</div>
                  </div>
                  <input
                    value={model.description}
                    onChange={(event) => setModels((current) => current.map((item) => (
                      item.id === model.id ? { ...item, description: event.target.value } : item
                    )))}
                    className="min-w-0 rounded-md border border-border-dark bg-surface-dark px-2 py-1.5 text-[11px] text-text-dark outline-hidden focus:border-accent"
                    placeholder="模型说明（选填）"
                  />
                  <button
                    type="button"
                    onClick={() => setModels((current) => current.filter((item) => item.id !== model.id))}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-red-500/20 hover:text-red-300"
                    title="删除模型"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[112px_minmax(0,1fr)_minmax(0,1fr)]">
                  <label className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border-dark bg-surface-dark px-2 text-[11px] text-text-muted">
                    <input
                      type="checkbox"
                      checked={model.supportsMultimodal}
                      onChange={(event) => setModels((current) => current.map((item) => (
                        item.id === model.id ? { ...item, supportsMultimodal: event.target.checked } : item
                      )))}
                      className="h-3 w-3 accent-accent"
                    />
                    多模态
                  </label>
                  <label className="flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border-dark bg-surface-dark px-2 text-[11px] text-text-muted">
                    <span className="shrink-0">上下文</span>
                    <input
                      value={model.contextWindow}
                      onChange={(event) => setModels((current) => current.map((item) => (
                        item.id === model.id ? { ...item, contextWindow: event.target.value } : item
                      )))}
                      className="min-w-0 flex-1 bg-transparent font-mono text-text-dark outline-hidden"
                      placeholder={DEFAULT_CHAT_CONTEXT_WINDOW}
                    />
                  </label>
                  <label className="flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-border-dark bg-surface-dark px-2 text-[11px] text-text-muted">
                    <span className="shrink-0">输出</span>
                    <input
                      value={model.maxOutputTokens}
                      onChange={(event) => setModels((current) => current.map((item) => (
                        item.id === model.id ? { ...item, maxOutputTokens: event.target.value } : item
                      )))}
                      className="min-w-0 flex-1 bg-transparent font-mono text-text-dark outline-hidden"
                      placeholder={DEFAULT_CHAT_MAX_OUTPUT_TOKENS}
                    />
                  </label>
                </div>
              </div>
            ))}
            <div className="grid grid-cols-1 gap-2 rounded-md border border-dashed border-border-dark bg-bg-dark p-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)_auto]">
              <input
                value={newModelId}
                onChange={(event) => setNewModelId(event.target.value)}
                className="rounded-md border border-dashed border-border-dark bg-surface-dark px-2 py-1.5 font-mono text-[11px] text-text-dark outline-hidden focus:border-accent"
                placeholder="模型 ID，例如 gpt-5.4"
              />
              <input
                value={newModelDescription}
                onChange={(event) => setNewModelDescription(event.target.value)}
                className="rounded-md border border-dashed border-border-dark bg-surface-dark px-2 py-1.5 text-[11px] text-text-dark outline-hidden focus:border-accent"
                placeholder="描述"
              />
              <button
                type="button"
                onClick={handleAddModel}
                disabled={!newModelId.trim()}
                className="inline-flex h-8 items-center justify-center gap-1 rounded-md bg-accent/20 px-2 text-[11px] text-accent hover:bg-accent/30 disabled:opacity-40"
              >
                <Plus className="h-3 w-3" /> 添加
              </button>
            </div>
          </div>
        </div>

        <details className="mt-4 rounded-lg border border-border-dark bg-surface-dark p-3">
          <summary className="cursor-pointer text-xs font-medium text-text-muted hover:text-text-dark">
            默认额外参数 JSON
          </summary>
          <div className="mt-2 flex items-start gap-2 text-[11px] leading-5 text-text-muted">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            <span>仅填写供应商文档明确要求的额外字段。model、input/messages/contents 会由测试和后续对话调用层单独组装。</span>
          </div>
          <textarea
            value={defaultParamsText}
            onChange={(event) => setDefaultParamsText(event.target.value)}
            className="ui-scrollbar mt-2 h-[110px] w-full resize-none rounded-md border border-border-dark bg-bg-dark px-3 py-2 font-mono text-[11px] leading-5 text-text-dark outline-hidden focus:border-accent"
            spellCheck={false}
          />
          {!parsedDefaultParams.ok && (
            <div className="mt-1 text-[10px] text-red-300">{parsedDefaultParams.error}</div>
          )}
        </details>

        <details className="mt-4 rounded-lg border border-border-dark bg-surface-dark p-3">
          <summary className="cursor-pointer text-xs font-medium text-text-muted hover:text-text-dark">
            模板说明 / 请求元数据
          </summary>
          <p className="mt-2 text-[11px] leading-5 text-text-muted">{providerNote}</p>
          <textarea
            key={providerNote}
            defaultValue={stringifyJsonObject(templateExtraParams)}
            onBlur={(event) => {
              const parsed = parseJsonObject(event.target.value);
              if (parsed.ok) {
                setTemplateExtraParams(parsed.value);
              }
            }}
            className="ui-scrollbar mt-2 h-[120px] w-full resize-none rounded-md border border-border-dark bg-bg-dark px-3 py-2 font-mono text-[11px] leading-5 text-text-dark outline-hidden focus:border-accent"
            spellCheck={false}
          />
        </details>

        {testResult && (
          <div className={`mt-4 rounded border px-3 py-2 text-[11px] ${
            testResult.ok
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-red-500/30 bg-red-500/10 text-red-300'
          }`}>
            {testResult.ok ? `连通正常${testResult.text ? `：${testResult.text.slice(0, 80)}` : ''}` : (testResult.errorMessage ?? '连通失败')}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2 border-t border-border-dark pt-3">
          {savedFlash && (
            <span className="mr-auto inline-flex items-center gap-1 text-xs text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" /> 已保存到我的配置
            </span>
          )}
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || !apiKey.trim() || !baseUrl.trim() || models.length === 0 || !parsedDefaultParams.ok}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-white/15 bg-white/5 px-4 text-sm text-text-dark hover:bg-white/10 disabled:opacity-40"
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {testing ? '测试中...' : '测试连通'}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!label.trim() || !baseUrl.trim() || models.length === 0 || !parsedDefaultParams.ok}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {editingId ? '保存对话配置' : '保存新对话供应商'}
          </button>
        </div>
      </div>
    </div>
  );
});
