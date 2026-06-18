import {
  customHttpRequest,
  type CustomHttpRequest,
  type CustomHttpResponse,
} from '@/commands/ai';
import { loadAudioSourceDataUrl } from '@/commands/image';
import type {
  AudioModelConfig,
  AudioOutputMode,
  AudioVoiceCategory,
  AudioVoiceOption,
} from '@/stores/settingsStore';

export interface LocalAudioVoiceCatalog {
  voices: AudioVoiceOption[];
  categories: AudioVoiceCategory[];
  selectedVoiceId: string;
  raw: unknown;
}

export interface GenerateLocalTtsRequest {
  baseUrl: string;
  endpointPath?: string;
  text: string;
  voiceId?: string | null;
  outputMode?: AudioOutputMode;
  timeoutMs?: number;
}

export interface GenerateLocalTtsResult {
  audioUrl: string;
  voiceId?: string | null;
  textLength?: number | null;
  count?: number | null;
  raw: unknown;
}

export interface GenerateAudioRequest {
  model: AudioModelConfig;
  fallbackBaseUrl: string;
  text: string;
  voiceId?: string | null;
  outputMode?: AudioOutputMode;
  timeoutMs?: number;
  referenceAudioUrl?: string | null;
  referenceAudioTitle?: string | null;
  extraParams?: Record<string, unknown>;
}

export type GenerateAudioResult = GenerateLocalTtsResult;

export interface TranscribeVoxCpmReferenceAudioRequest {
  model: AudioModelConfig;
  fallbackBaseUrl: string;
  referenceAudioUrl: string;
  timeoutMs?: number;
  usePromptText?: boolean;
}

export interface TranscribeVoxCpmReferenceAudioResult {
  text: string;
  referenceAudioUsed: boolean;
  raw: unknown;
}

interface VoxCpmSubmitPayload {
  baseUrl: string;
  endpointPath: string;
  submitUrl: string;
  resultUrlTemplate: string;
  timeoutMs: number;
  extraParams: Record<string, unknown>;
  referenceAudioSource: string;
  refWav: Record<string, unknown> | null;
  usePromptText: boolean;
  data: unknown[];
  dataMap: Array<{ index: number; name: string; value: unknown }>;
  body: { data: unknown[] };
}

const VOXCPM_GENERATE_PARAMETER_NAMES = [
  'text',
  'control_instruction',
  'ref_wav',
  'use_prompt_text',
  'prompt_text_value',
  'cfg_value',
  'do_normalize',
  'denoise',
  'dit_steps',
  'user_id',
];
const VOXCPM_DEFAULT_USER_ID = 'fp-2fejme4mpcko';
const VOXCPM_RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524]);
const VOXCPM_RETRY_DELAYS_MS = [1200, 2800, 5000];

function joinApiPath(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function parseJsonResponse(text: string, fallbackMessage: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(fallbackMessage);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatVoxCpmHttpFailure(action: string, status: number, attempts: number): string {
  const retryText = attempts > 1 ? `，已自动重试 ${attempts - 1} 次` : '';
  if (status === 503) {
    return `VoxCPM ${action}失败（HTTP 503）。官方生成接口当前繁忙或临时不可用${retryText}，请稍后再试。`;
  }
  if (status === 429) {
    return `VoxCPM ${action}失败（HTTP 429）。请求过快或服务限流${retryText}，请稍后再试。`;
  }
  return `VoxCPM ${action}失败（HTTP ${status}）${retryText}`;
}

async function customVoxCpmHttpRequest(
  request: CustomHttpRequest,
  action: string
): Promise<CustomHttpResponse> {
  let response: CustomHttpResponse | null = null;

  for (let attempt = 0; attempt <= VOXCPM_RETRY_DELAYS_MS.length; attempt += 1) {
    response = await customHttpRequest(request);
    if (!VOXCPM_RETRYABLE_HTTP_STATUSES.has(response.status)) {
      return response;
    }

    const delayMs = VOXCPM_RETRY_DELAYS_MS[attempt];
    if (typeof delayMs !== 'number') {
      break;
    }
    console.warn('[VoxCPM] retryable HTTP status', {
      action,
      status: response.status,
      attempt: attempt + 1,
      nextDelayMs: delayMs,
    });
    await sleep(delayMs);
  }

  if (response) {
    throw new Error(formatVoxCpmHttpFailure(action, response.status, VOXCPM_RETRY_DELAYS_MS.length + 1));
  }
  throw new Error(`VoxCPM ${action}失败`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeVoiceId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeVoiceName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeVoice(input: unknown): AudioVoiceOption | null {
  if (typeof input === 'string') {
    const id = input.trim();
    return id ? { id, name: id, raw: input } : null;
  }
  const record = asRecord(input);
  if (!record) {
    return null;
  }

  const id =
    normalizeVoiceId(record.id)
    || normalizeVoiceId(record.voiceId)
    || normalizeVoiceId(record.voice_id)
    || normalizeVoiceId(record.value)
    || normalizeVoiceId(record.key);
  if (!id) {
    return null;
  }

  const category =
    normalizeVoiceId(record.category)
    || normalizeVoiceId(record.categoryKey)
    || normalizeVoiceId(record.group)
    || undefined;
  const locale =
    normalizeVoiceId(record.locale)
    || normalizeVoiceId(record.languageCode)
    || normalizeVoiceId(record.language)
    || undefined;

  return {
    id,
    name: normalizeVoiceName(record.name ?? record.label ?? record.title, id),
    category,
    locale,
    raw: input,
  };
}

function pushVoice(target: AudioVoiceOption[], seen: Set<string>, input: unknown) {
  const voice = normalizeVoice(input);
  if (!voice || seen.has(voice.id)) {
    return;
  }
  seen.add(voice.id);
  target.push(voice);
}

function normalizeCategory(input: unknown): AudioVoiceCategory | null {
  if (typeof input === 'string') {
    const key = input.trim();
    return key ? { key, label: key } : null;
  }
  const record = asRecord(input);
  if (!record) {
    return null;
  }
  const key =
    normalizeVoiceId(record.key)
    || normalizeVoiceId(record.id)
    || normalizeVoiceId(record.value)
    || normalizeVoiceId(record.category);
  if (!key) {
    return null;
  }
  return {
    key,
    label: normalizeVoiceName(record.label ?? record.name ?? record.title, key),
  };
}

function normalizeCategories(input: unknown): AudioVoiceCategory[] {
  const candidates = Array.isArray(input) ? input : [];
  const categories: AudioVoiceCategory[] = [];
  const seen = new Set<string>();
  candidates.forEach((item) => {
    const category = normalizeCategory(item);
    if (!category || seen.has(category.key)) {
      return;
    }
    seen.add(category.key);
    categories.push(category);
  });
  return categories;
}

function collectVoiceCandidates(parsed: unknown): AudioVoiceOption[] {
  const voices: AudioVoiceOption[] = [];
  const seen = new Set<string>();
  const root = asRecord(parsed);

  if (Array.isArray(parsed)) {
    parsed.forEach((item) => pushVoice(voices, seen, item));
  }
  if (Array.isArray(root?.voices)) {
    root.voices.forEach((item) => pushVoice(voices, seen, item));
  }

  const options = asRecord(root?.options);
  if (Array.isArray(options?.voices)) {
    options.voices.forEach((item) => pushVoice(voices, seen, item));
  }

  const groups = root?.groups;
  if (Array.isArray(groups)) {
    groups.forEach((group) => {
      const groupRecord = asRecord(group);
      if (Array.isArray(groupRecord?.voices)) {
        groupRecord.voices.forEach((item) => pushVoice(voices, seen, item));
      }
    });
  } else if (asRecord(groups)) {
    Object.values(groups as Record<string, unknown>).forEach((group) => {
      if (Array.isArray(group)) {
        group.forEach((item) => pushVoice(voices, seen, item));
        return;
      }
      const groupRecord = asRecord(group);
      if (Array.isArray(groupRecord?.voices)) {
        groupRecord.voices.forEach((item) => pushVoice(voices, seen, item));
      }
    });
  }

  return voices;
}

function collectCategoryCandidates(parsed: unknown): AudioVoiceCategory[] {
  const root = asRecord(parsed);
  const options = asRecord(root?.options);
  const categories = [
    ...normalizeCategories(root?.categories),
    ...normalizeCategories(options?.categories),
  ];
  const seen = new Set<string>();
  return categories.filter((category) => {
    if (seen.has(category.key)) {
      return false;
    }
    seen.add(category.key);
    return true;
  });
}

function isLikelyBase64Audio(value: string, keyHint = ''): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 80) {
    return false;
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    return false;
  }
  return /(audio|base64|content|data|file|bytes)/i.test(keyHint) || trimmed.length > 512;
}

function normalizeAudioSource(value: unknown, keyHint = ''): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^data:audio\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed) || /^blob:/i.test(trimmed)) {
    return trimmed;
  }
  if (
    /^\/gradio_api\/file=/i.test(trimmed)
    || /^gradio_api\/file=/i.test(trimmed)
    || (/^\/tmp\/gradio\//i.test(trimmed) && /(path|file|url|audio)/i.test(keyHint))
  ) {
    return trimmed;
  }
  if (/^data:application\/octet-stream;base64,/i.test(trimmed)) {
    return trimmed.replace(/^data:application\/octet-stream/i, 'data:audio/mpeg');
  }
  if (isLikelyBase64Audio(trimmed, keyHint)) {
    return `data:audio/mpeg;base64,${trimmed.replace(/\s+/g, '')}`;
  }
  return null;
}

function extractFirstAudioSource(value: unknown, keyHint = ''): string | null {
  const direct = normalizeAudioSource(value, keyHint);
  if (direct) {
    return direct;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractFirstAudioSource(item, keyHint);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const preferredKeys = [
    'dataUrl',
    'data_url',
    'audioUrl',
    'audio_url',
    'url',
    'base64',
    'b64',
    'content',
    'audio',
    'file',
    'path',
  ];
  for (const key of preferredKeys) {
    if (key in record) {
      const found = extractFirstAudioSource(record[key], key);
      if (found) {
        return found;
      }
    }
  }
  for (const [key, nested] of Object.entries(record)) {
    const found = extractFirstAudioSource(nested, key);
    if (found) {
      return found;
    }
  }
  return null;
}

function normalizeAbsoluteUrl(baseUrl: string, value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return new URL(trimmed, `${baseUrl.trim().replace(/\/+$/, '')}/`).toString();
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function endpointToGradioEventPath(endpointPath: string): string {
  const normalized = endpointPath.trim() || '/gradio_api/call/generate';
  if (normalized.includes('/call/')) {
    return normalized;
  }
  const apiName = normalized.replace(/^\/+/, '').replace(/^gradio_api\/?/, '').replace(/^\/?/, '');
  return `/gradio_api/call/${apiName.replace(/^\/+/, '') || 'generate'}`;
}

function inferFileNameFromAudioSource(value: string, fallback = 'reference.wav'): string {
  const trimmed = value.trim();
  if (/^data:audio\/mpeg/i.test(trimmed)) {
    return 'reference.mp3';
  }
  if (/^data:audio\/wav/i.test(trimmed) || /^data:audio\/wave/i.test(trimmed) || /^data:audio\/x-wav/i.test(trimmed)) {
    return 'reference.wav';
  }
  if (/^data:audio\/ogg/i.test(trimmed)) {
    return 'reference.ogg';
  }
  try {
    const parsed = new URL(trimmed);
    const lastPart = parsed.pathname.split('/').filter(Boolean).pop();
    return lastPart || fallback;
  } catch {
    return fallback;
  }
}

function inferMimeTypeFromAudioSource(value: string): string {
  const match = /^data:([^;,]+)/i.exec(value.trim());
  if (match?.[1]) {
    return match[1];
  }

  const normalized = value.trim();
  let pathname = '';
  try {
    pathname = new URL(normalized).pathname;
  } catch {
    pathname = normalized.split('?')[0] ?? '';
  }
  const lowerPath = pathname.toLowerCase();
  if (lowerPath.endsWith('.mp3') || lowerPath.endsWith('.mpeg')) {
    return 'audio/mpeg';
  }
  if (lowerPath.endsWith('.wav') || lowerPath.endsWith('.wave')) {
    return 'audio/wav';
  }
  if (lowerPath.endsWith('.ogg') || lowerPath.endsWith('.oga')) {
    return 'audio/ogg';
  }
  if (lowerPath.endsWith('.m4a') || lowerPath.endsWith('.mp4')) {
    return 'audio/mp4';
  }
  if (lowerPath.endsWith('.flac')) {
    return 'audio/flac';
  }
  return 'audio/wav';
}

function gradioUploadAudioFileName(source: string): string {
  const trimmed = source.trim();
  if (/^data:audio\/mpeg/i.test(trimmed)) {
    return 'reference.mp3';
  }
  if (/^data:audio\/wav/i.test(trimmed) || /^data:audio\/wave/i.test(trimmed) || /^data:audio\/x-wav/i.test(trimmed)) {
    return 'reference.wav';
  }
  if (/^data:audio\/ogg/i.test(trimmed)) {
    return 'reference.ogg';
  }
  try {
    const parsed = new URL(trimmed);
    const lastPart = parsed.pathname.split('/').filter(Boolean).pop();
    return lastPart || 'reference.wav';
  } catch {
    return 'reference.wav';
  }
}

function extractFirstGradioFilePath(value: unknown): string | null {
  const direct = asString(value);
  if (direct) {
    return direct;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractFirstGradioFilePath(item);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const preferredKeys = ['path', 'url', 'value', 'file'];
  for (const key of preferredKeys) {
    const found = extractFirstGradioFilePath(record[key]);
    if (found) {
      return found;
    }
  }

  for (const nested of Object.values(record)) {
    const found = extractFirstGradioFilePath(nested);
    if (found) {
      return found;
    }
  }

  return null;
}

function extractFirstGradioTextValue(value: unknown): string {
  const direct = asString(value);
  if (direct) {
    return direct;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractFirstGradioTextValue(item);
      if (found) {
        return found;
      }
    }
    return '';
  }

  const record = asRecord(value);
  if (!record) {
    return '';
  }

  const preferredKeys = ['value', 'text'];
  for (const key of preferredKeys) {
    const found = extractFirstGradioTextValue(record[key]);
    if (found) {
      return found;
    }
  }

  for (const nested of Object.values(record)) {
    const found = extractFirstGradioTextValue(nested);
    if (found) {
      return found;
    }
  }

  return '';
}

function createGradioFileData(source: string): Record<string, unknown> | null {
  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }
  const fileName = inferFileNameFromAudioSource(trimmed);
  return {
    path: trimmed,
    ...(/^https?:\/\//i.test(trimmed) ? { url: trimmed } : {}),
    orig_name: fileName,
    mime_type: inferMimeTypeFromAudioSource(trimmed),
    meta: { _type: 'gradio.FileData' },
  };
}

function extractSameServerGradioFilePath(baseUrl: string, source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\/tmp\/gradio\//i.test(trimmed)) {
    return trimmed;
  }

  const directMatch = /^\/?gradio_api\/file=(\/tmp\/gradio\/.+)$/i.exec(trimmed);
  if (directMatch?.[1]) {
    return directMatch[1];
  }

  try {
    const parsedSource = new URL(trimmed);
    const parsedBase = new URL(baseUrl.trim().replace(/\/+$/, '') || parsedSource.origin);
    if (parsedSource.origin !== parsedBase.origin) {
      return null;
    }
    const marker = '/gradio_api/file=';
    const markerIndex = parsedSource.pathname.indexOf(marker);
    if (markerIndex < 0) {
      return null;
    }
    const pathPart = decodeURIComponent(parsedSource.pathname.slice(markerIndex + marker.length));
    return /^\/tmp\/gradio\//i.test(pathPart) ? pathPart : null;
  } catch {
    return null;
  }
}

async function resolveAudioSourceDataUrl(source: string): Promise<string> {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error('VoxCPM 参考音频源为空');
  }
  if (/^data:audio\//i.test(trimmed)) {
    return trimmed;
  }

  const normalized = trimmed.startsWith('/gradio_api/file=')
    ? trimmed.replace(/^\/gradio_api\/file=/i, '')
    : trimmed.startsWith('gradio_api/file=')
      ? trimmed.replace(/^gradio_api\/file=/i, '')
      : trimmed;

  return await loadAudioSourceDataUrl(normalized);
}

function summarizeDebugString(value: string, maxLength = 500): string {
  const trimmed = value.trim();
  const commaIndex = trimmed.indexOf(',');
  if (/^data:[^,]+;base64,/i.test(trimmed) && commaIndex >= 0) {
    const meta = trimmed.slice(0, commaIndex);
    const base64 = trimmed.slice(commaIndex + 1);
    return `${meta},[base64 ${base64.length} chars]`;
  }
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length > 300) {
    return `[base64 ${trimmed.length} chars]`;
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...(${trimmed.length} chars)` : value;
}

function isSensitiveDebugFieldName(name: string): boolean {
  return /(authorization|api[-_ ]?key|access[-_ ]?token|secret|password|bearer|cookie|session)/i.test(name);
}

function summarizeDebugValue(value: unknown, key = '', depth = 0): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') {
    return isSensitiveDebugFieldName(key) ? '[masked]' : summarizeDebugString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return depth >= 5
      ? `[array ${value.length}]`
      : value.map((item, index) => summarizeDebugValue(item, `${key}[${index}]`, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= 5) return '[object]';
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, item]) => [
        entryKey,
        summarizeDebugValue(item, entryKey, depth + 1),
      ])
    );
  }
  return String(value);
}

function pythonStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function pythonBooleanLiteral(value: unknown): 'True' | 'False' {
  return value === true ? 'True' : 'False';
}

function pythonNumberLiteral(value: unknown, fallback: number): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? String(numeric) : String(fallback);
}

function buildVoxCpmPythonClientEquivalent(payload: VoxCpmSubmitPayload): {
  installHint: string;
  code: string;
  predictArgs: Record<string, unknown>;
} {
  const [
    text,
    controlInstruction,
    refWav,
    usePromptText,
    promptTextValue,
    cfgValue,
    doNormalize,
    denoise,
    ditSteps,
    userId,
  ] = payload.data;
  const referencePath = asString(asRecord(refWav)?.path);
  const refWavArgument = referencePath
    ? `handle_file(${pythonStringLiteral(summarizeDebugString(referencePath))})`
    : 'None';
  const code = [
    'from gradio_client import Client, handle_file',
    '',
    `client = Client(${pythonStringLiteral(payload.baseUrl)})`,
    'result = client.predict(',
    `    text=${pythonStringLiteral(String(text ?? ''))},`,
    `    control_instruction=${pythonStringLiteral(String(controlInstruction ?? ''))},`,
    `    ref_wav=${refWavArgument},`,
    `    use_prompt_text=${pythonBooleanLiteral(usePromptText)},`,
    `    prompt_text_value=${pythonStringLiteral(String(promptTextValue ?? ''))},`,
    `    cfg_value=${pythonNumberLiteral(cfgValue, 2)},`,
    `    do_normalize=${pythonBooleanLiteral(doNormalize)},`,
    `    denoise=${pythonBooleanLiteral(denoise)},`,
    `    dit_steps=${pythonNumberLiteral(ditSteps, 10)},`,
    `    user_id=${pythonStringLiteral(String(userId ?? ''))},`,
    '    api_name="/generate",',
    ')',
    'print(result)',
  ].join('\n');

  return {
    installHint: 'Equivalent to gradio_client.Client.predict(api_name="/generate"). Data URL audio is summarized in this preview.',
    code,
    predictArgs: {
      text,
      control_instruction: controlInstruction,
      ref_wav: referencePath ? `handle_file(${summarizeDebugString(referencePath)})` : null,
      use_prompt_text: usePromptText,
      prompt_text_value: promptTextValue,
      cfg_value: cfgValue,
      do_normalize: doNormalize,
      denoise,
      dit_steps: ditSteps,
      user_id: userId,
      api_name: '/generate',
    },
  };
}

function buildVoxCpmSubmitPayload(
  request: GenerateAudioRequest,
  referenceAudioSource = request.referenceAudioUrl || ''
): VoxCpmSubmitPayload {
  const extraParams = {
    ...(asRecord(request.model.extraParams) ?? {}),
    ...(asRecord(request.extraParams) ?? {}),
  };
  const baseUrl = request.model.apiBaseUrl || request.fallbackBaseUrl;
  const endpointPath = endpointToGradioEventPath(request.model.endpointPath || '/gradio_api/call/generate');
  const timeoutMs = request.timeoutMs ?? request.model.timeoutMs ?? 180000;
  const normalizedReferenceAudioSource = referenceAudioSource.trim();
  const refWav = normalizedReferenceAudioSource
    ? createGradioFileData(normalizedReferenceAudioSource)
    : null;
  const usePromptText = asBoolean(extraParams.usePromptText, false);
  const data = [
    request.text,
    usePromptText ? '' : asString(extraParams.controlInstruction),
    refWav,
    usePromptText,
    asString(extraParams.promptTextValue),
    asNumber(extraParams.cfgValue, 2, 1, 3),
    asBoolean(extraParams.doNormalize, false),
    asBoolean(extraParams.denoise, false),
    asNumber(extraParams.ditSteps, 10, 1, 50),
    asString(extraParams.userId) || VOXCPM_DEFAULT_USER_ID,
  ];
  return {
    baseUrl,
    endpointPath,
    submitUrl: joinApiPath(baseUrl, endpointPath),
    resultUrlTemplate: joinApiPath(baseUrl, `${endpointPath}/{event_id}`),
    timeoutMs,
    extraParams,
    referenceAudioSource: normalizedReferenceAudioSource,
    refWav,
    usePromptText,
    data,
    dataMap: data.map((value, index) => ({
      index,
      name: VOXCPM_GENERATE_PARAMETER_NAMES[index] ?? `parameter_${index}`,
      value,
    })),
    body: { data },
  };
}

async function uploadGradioAudioReference(baseUrl: string, audioSource: string, timeoutMs: number): Promise<string | null> {
  const trimmed = audioSource.trim();
  if (!trimmed) {
    return null;
  }

  const existingGradioPath = extractSameServerGradioFilePath(baseUrl, trimmed);
  if (existingGradioPath) {
    return existingGradioPath;
  }

  const uploadSource = await resolveAudioSourceDataUrl(trimmed);

  const response = await customVoxCpmHttpRequest({
    url: joinApiPath(baseUrl, '/gradio_api/upload'),
    method: 'POST',
    bodyMode: 'multipart',
    multipart: {
      files: [
        {
          name: 'files',
          fileName: gradioUploadAudioFileName(uploadSource),
          mimeType: inferMimeTypeFromAudioSource(uploadSource),
          dataUrl: uploadSource,
        },
      ],
    },
    timeoutMs,
  }, '参考音频上传');

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`VoxCPM 参考音频上传失败（HTTP ${response.status}）`);
  }

  const parsed = parseJsonResponse(response.text, 'VoxCPM 参考音频上传返回了非 JSON 内容');
  return extractFirstGradioFilePath(parsed);
}

function parseGradioEventId(payload: string): string {
  const parsed = parseJsonResponse(payload, 'VoxCPM 返回了非 JSON 任务响应');
  const root = asRecord(parsed);
  const eventId = asString(root?.event_id) || asString(root?.eventId) || asString(root?.hash);
  if (!eventId) {
    throw new Error('VoxCPM 没有返回 event_id');
  }
  return eventId;
}

function parseSseEvents(text: string): Array<{ event: string; data: string }> {
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks = normalized.split(/\n\n+/);
  const events: Array<{ event: string; data: string }> = [];
  blocks.forEach((block) => {
    let eventName = 'message';
    const dataLines: string[] = [];
    block.split('\n').forEach((line) => {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim() || eventName;
        return;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    });
    if (dataLines.length > 0) {
      events.push({ event: eventName, data: dataLines.join('\n') });
    }
  });
  return events;
}

function parseGradioDataPayload(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function extractLastGradioResultPayload(sseText: string, errorPrefix: string): unknown {
  const events = parseSseEvents(sseText);
  const errorEvent = events.find((event) => event.event === 'error');
  if (errorEvent) {
    throw new Error(`${errorPrefix}：${errorEvent.data}`);
  }

  const completeEvent = [...events].reverse().find((event) => event.event === 'complete')
    ?? [...events].reverse().find((event) => event.event === 'generating')
    ?? [...events].reverse().find((event) => event.data);
  if (!completeEvent) {
    throw new Error(`${errorPrefix}：没有返回结果`);
  }
  return parseGradioDataPayload(completeEvent.data);
}

function normalizeGradioAudioSource(baseUrl: string, payload: unknown): string | null {
  const audioSource = extractFirstAudioSource(payload);
  if (!audioSource) {
    return null;
  }
  if (/^\/tmp\/gradio\//i.test(audioSource)) {
    return normalizeAbsoluteUrl(baseUrl, `/gradio_api/file=${audioSource}`);
  }
  if (/^\/|^gradio_api\//i.test(audioSource)) {
    return normalizeAbsoluteUrl(baseUrl, audioSource);
  }
  return audioSource;
}

function extractGradioResultAudio(baseUrl: string, sseText: string): { audioUrl: string; raw: unknown } {
  const parsed = extractLastGradioResultPayload(sseText, 'VoxCPM 生成失败');
  const audioUrl = normalizeGradioAudioSource(baseUrl, parsed);
  if (!audioUrl) {
    throw new Error('VoxCPM 返回结果中没有找到可播放的音频 URL');
  }

  return { audioUrl, raw: parsed };
}

export async function fetchLocalAudioHealth(baseUrl: string): Promise<unknown> {
  const response = await customHttpRequest({
    url: joinApiPath(baseUrl, '/health'),
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeoutMs: 12000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`音频 API 健康检查失败（HTTP ${response.status}）`);
  }
  return parseJsonResponse(response.text, '音频 API 健康检查返回了非 JSON 内容');
}

export async function fetchLocalAudioVoices(
  baseUrl: string,
  options: { refresh?: boolean; category?: string; locale?: string } = {}
): Promise<LocalAudioVoiceCatalog> {
  const params = new URLSearchParams();
  if (options.refresh) {
    params.set('refresh', '1');
  }
  if (options.category?.trim()) {
    params.set('category', options.category.trim());
  }
  if (options.locale?.trim()) {
    params.set('locale', options.locale.trim());
  }

  const response = await customHttpRequest({
    url: `${joinApiPath(baseUrl, '/voices')}${params.size > 0 ? `?${params.toString()}` : ''}`,
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeoutMs: 60000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`音色同步失败（HTTP ${response.status}）`);
  }

  const parsed = parseJsonResponse(response.text, '音色同步返回了非 JSON 内容');
  const voices = collectVoiceCandidates(parsed);
  const categories = collectCategoryCandidates(parsed);
  const root = asRecord(parsed);
  return {
    voices,
    categories,
    selectedVoiceId: normalizeVoiceId(root?.selectedVoiceId),
    raw: parsed,
  };
}

export async function generateLocalTts(
  request: GenerateLocalTtsRequest
): Promise<GenerateLocalTtsResult> {
  const endpointPath = request.endpointPath?.trim() || '/tts';
  const response = await customHttpRequest({
    url: joinApiPath(request.baseUrl, endpointPath),
    method: 'POST',
    headers: {
      Accept: 'application/json',
    },
    bodyMode: 'json',
    body: {
      text: request.text,
      voiceId: request.voiceId?.trim() || undefined,
      outputMode: request.outputMode ?? 'server',
      timeoutMs: request.timeoutMs,
      restoreVoice: true,
      restoreOutputMode: true,
    },
    timeoutMs: request.timeoutMs ?? 180000,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`音频生成失败（HTTP ${response.status}）`);
  }

  const parsed = parseJsonResponse(response.text, '音频 API 返回了非 JSON 内容，请优先使用 /tts 接口');
  const audioUrl = extractFirstAudioSource(parsed);
  if (!audioUrl) {
    throw new Error('音频 API 返回中没有找到可播放的 audio/base64/url 字段');
  }

  const root = asRecord(parsed);
  return {
    audioUrl,
    voiceId: normalizeVoiceId(root?.voiceId) || request.voiceId || null,
    textLength: typeof root?.textLength === 'number' ? root.textLength : null,
    count: typeof root?.count === 'number' ? root.count : null,
    raw: parsed,
  };
}

export async function generateVoxCpmAudio(
  request: GenerateAudioRequest
): Promise<GenerateAudioResult> {
  const initialPayload = buildVoxCpmSubmitPayload(request);
  const uploadedReference = request.referenceAudioUrl
    ? await uploadGradioAudioReference(initialPayload.baseUrl, request.referenceAudioUrl, initialPayload.timeoutMs)
    : null;
  const payload = buildVoxCpmSubmitPayload(
    request,
    uploadedReference || request.referenceAudioUrl || ''
  );

  const submitResponse = await customVoxCpmHttpRequest({
    url: payload.submitUrl,
    method: 'POST',
    headers: {
      Accept: 'application/json',
    },
    bodyMode: 'json',
    body: payload.body,
    timeoutMs: payload.timeoutMs,
  }, '提交');

  if (submitResponse.status < 200 || submitResponse.status >= 300) {
    throw new Error(`VoxCPM 提交失败（HTTP ${submitResponse.status}）`);
  }

  const eventId = parseGradioEventId(submitResponse.text);
  const resultResponse = await customVoxCpmHttpRequest({
    url: joinApiPath(payload.baseUrl, `${payload.endpointPath}/${eventId}`),
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
    },
    timeoutMs: payload.timeoutMs,
  }, '结果读取');

  if (resultResponse.status < 200 || resultResponse.status >= 300) {
    throw new Error(`VoxCPM 结果读取失败（HTTP ${resultResponse.status}）`);
  }

  const result = extractGradioResultAudio(payload.baseUrl, resultResponse.text);
  return {
    audioUrl: result.audioUrl,
    voiceId: request.voiceId || null,
    textLength: request.text.length,
    count: null,
    raw: {
      provider: 'voxcpm',
      referenceAudioTitle: request.referenceAudioTitle ?? null,
      referenceAudioUsed: Boolean(payload.refWav),
      result: result.raw,
    },
  };
}

export async function transcribeVoxCpmReferenceAudio(
  request: TranscribeVoxCpmReferenceAudioRequest
): Promise<TranscribeVoxCpmReferenceAudioResult> {
  const baseUrl = request.model.apiBaseUrl || request.fallbackBaseUrl;
  const endpointPath = endpointToGradioEventPath('/_run_asr_if_needed');
  const timeoutMs = request.timeoutMs ?? request.model.timeoutMs ?? 180000;
  const uploadedReference = request.referenceAudioUrl
    ? await uploadGradioAudioReference(baseUrl, request.referenceAudioUrl, timeoutMs)
    : null;
  const referenceAudioSource = uploadedReference || request.referenceAudioUrl || '';
  const refWav = referenceAudioSource ? createGradioFileData(referenceAudioSource) : null;
  if (!refWav) {
    throw new Error('VoxCPM ASR 需要先连接一个参考音频');
  }

  const submitResponse = await customVoxCpmHttpRequest({
    url: joinApiPath(baseUrl, endpointPath),
    method: 'POST',
    headers: {
      Accept: 'application/json',
    },
    bodyMode: 'json',
    body: {
      data: [request.usePromptText !== false, refWav],
    },
    timeoutMs,
  }, 'ASR 提交');

  if (submitResponse.status < 200 || submitResponse.status >= 300) {
    throw new Error(`VoxCPM ASR 提交失败（HTTP ${submitResponse.status}）`);
  }

  const eventId = parseGradioEventId(submitResponse.text);
  const resultResponse = await customVoxCpmHttpRequest({
    url: joinApiPath(baseUrl, `${endpointPath}/${eventId}`),
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
    },
    timeoutMs,
  }, 'ASR 结果读取');

  if (resultResponse.status < 200 || resultResponse.status >= 300) {
    throw new Error(`VoxCPM ASR 结果读取失败（HTTP ${resultResponse.status}）`);
  }

  const raw = extractLastGradioResultPayload(resultResponse.text, 'VoxCPM ASR 失败');
  const text = extractFirstGradioTextValue(raw);
  if (!text) {
    throw new Error('VoxCPM ASR 没有返回参考音频文本');
  }
  return {
    text,
    referenceAudioUsed: Boolean(refWav),
    raw,
  };
}

export function buildAudioGenerationDebugPreview(request: GenerateAudioRequest): unknown {
  const modelRequest = {
    modelId: request.model.id,
    modelName: request.model.name,
    providerKind: request.model.providerKind,
    apiBaseUrl: request.model.apiBaseUrl || request.fallbackBaseUrl,
    endpointPath: request.model.endpointPath,
    text: request.text,
    voiceId: request.voiceId ?? null,
    outputMode: request.outputMode ?? request.model.outputMode,
    timeoutMs: request.timeoutMs ?? request.model.timeoutMs,
    referenceAudioTitle: request.referenceAudioTitle ?? null,
    referenceAudioUrl: request.referenceAudioUrl ?? null,
    extraParams: request.extraParams,
  };

  if (request.model.providerKind === 'gradio-voxcpm') {
    const payload = buildVoxCpmSubmitPayload(request);
    const clientPredictEquivalent = buildVoxCpmPythonClientEquivalent(payload);
    const referenceAudioSource = request.referenceAudioUrl?.trim() ?? '';
    const referenceAudioNeedsUpload = Boolean(
      referenceAudioSource && !extractSameServerGradioFilePath(payload.baseUrl, referenceAudioSource)
    );
    return {
      route: 'gradio-voxcpm',
      gatewayRequest: summarizeDebugValue(modelRequest),
      providerRequest: {
        provider: 'VoxCPM Gradio',
        endpoint: '/generate',
        method: 'POST',
        submitUrl: payload.submitUrl,
        resultUrlTemplate: payload.resultUrlTemplate,
        timeoutMs: payload.timeoutMs,
        parameterOrder: VOXCPM_GENERATE_PARAMETER_NAMES,
        webUiInputOrder: [
          { componentId: 12, name: 'text', label: 'target_text_label' },
          { componentId: 11, name: 'control_instruction', label: 'control_label' },
          { componentId: 8, name: 'ref_wav', label: 'reference_audio_label' },
          { componentId: 9, name: 'use_prompt_text', label: 'show_prompt_text_label' },
          { componentId: 10, name: 'prompt_text_value', label: 'prompt_text_label' },
          { componentId: 16, name: 'cfg_value', label: 'cfg_label' },
          { componentId: 15, name: 'do_normalize', label: 'normalize_label' },
          { componentId: 14, name: 'denoise', label: 'ref_denoise_label' },
          { componentId: 17, name: 'dit_steps', label: 'dit_steps_label' },
          { componentId: 3, name: 'user_id', label: 'hidden user_id textbox' },
        ],
        clientPredictEquivalent,
        bodyMode: 'json',
        body: summarizeDebugValue(payload.body),
        dataMap: payload.dataMap.map((entry) => ({
          ...entry,
          value: summarizeDebugValue(entry.value, entry.name),
        })),
        referenceAudio: {
          title: request.referenceAudioTitle ?? null,
          originalSource: summarizeDebugValue(request.referenceAudioUrl ?? null, 'referenceAudioUrl'),
          previewRefWav: summarizeDebugValue(payload.refWav, 'ref_wav'),
          actualGenerationWillUploadBeforeSubmit: referenceAudioNeedsUpload,
          uploadRequest: referenceAudioNeedsUpload
            ? {
              method: 'POST',
              url: joinApiPath(payload.baseUrl, '/gradio_api/upload'),
              bodyMode: 'multipart',
              fileField: 'files',
              fileName: inferFileNameFromAudioSource(referenceAudioSource),
              mimeType: inferMimeTypeFromAudioSource(referenceAudioSource),
              sourceWillBeLoadedAsDataUrl: !/^data:audio\//i.test(referenceAudioSource),
            }
            : null,
          note: referenceAudioNeedsUpload
            ? 'Preview does not upload files; actual generation converts the reference audio to a data URL, uploads it to Gradio, then replaces ref_wav.path with the /tmp/gradio upload result.'
            : 'Preview ref_wav is the same source shape used for submit.',
        },
      },
    };
  }

  const endpointPath = request.model.endpointPath || '/tts';
  const baseUrl = request.model.apiBaseUrl || request.fallbackBaseUrl;
  const body = {
    text: request.text,
    voiceId: request.voiceId?.trim() || undefined,
    outputMode: request.outputMode ?? request.model.outputMode,
    timeoutMs: request.timeoutMs ?? request.model.timeoutMs,
    restoreVoice: true,
    restoreOutputMode: true,
  };
  return {
    route: 'local-doubao-tts',
    gatewayRequest: summarizeDebugValue(modelRequest),
    providerRequest: {
      provider: 'Local Doubao TTS',
      method: 'POST',
      url: joinApiPath(baseUrl, endpointPath),
      bodyMode: 'json',
      body: summarizeDebugValue(body),
      timeoutMs: request.timeoutMs ?? request.model.timeoutMs ?? 180000,
    },
  };
}

export async function generateAudio(request: GenerateAudioRequest): Promise<GenerateAudioResult> {
  if (request.model.providerKind === 'gradio-voxcpm') {
    return generateVoxCpmAudio(request);
  }

  return generateLocalTts({
    baseUrl: request.model.apiBaseUrl || request.fallbackBaseUrl,
    endpointPath: request.model.endpointPath || '/tts',
    text: request.text,
    voiceId: request.voiceId,
    outputMode: request.outputMode ?? request.model.outputMode,
    timeoutMs: request.timeoutMs ?? request.model.timeoutMs,
  });
}
