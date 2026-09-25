import type { CustomHttpMultipartBody, GenerateRequest } from '@/commands/ai';
import { resolveImageOutputGeometry } from '@/features/canvas/application/imageOutputGeometry';
import type { CustomProviderConfig } from '@/stores/customProvidersStore';

type JsonRecord = Record<string, unknown>;

export interface ComfyUIInputBinding {
  nodeId: string;
  input: string;
}

export interface ComfyUIBindings {
  prompt?: ComfyUIInputBinding;
  seed?: ComfyUIInputBinding;
  width?: ComfyUIInputBinding;
  height?: ComfyUIInputBinding;
  images: ComfyUIInputBinding[];
}

export interface ComfyUIConfig {
  workflow: Record<string, JsonRecord>;
  bindings: ComfyUIBindings;
  outputNodeIds: string[];
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

export interface ComfyUITransport {
  json: (path: string, method: 'GET' | 'POST', body?: unknown) => Promise<unknown>;
  multipart: (path: string, body: CustomHttpMultipartBody) => Promise<unknown>;
  url: (path: string, query: Record<string, string>) => string;
}

export class ComfyUIExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComfyUIExecutionError';
  }
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_WORKFLOW_BYTES = 8 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v']);

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function nonemptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeKey(value: string): boolean {
  return Boolean(value) && !UNSAFE_KEYS.has(value);
}

function parseBinding(value: unknown, label: string): ComfyUIInputBinding | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = asRecord(value);
  const nodeId = nonemptyString(raw?.nodeId);
  const input = nonemptyString(raw?.input);
  if (!safeKey(nodeId) || !safeKey(input)) {
    throw new Error(`ComfyUI ${label} 映射需要有效的节点 ID 和输入字段名。`);
  }
  return { nodeId, input };
}

function parseBindings(value: unknown): ComfyUIBindings {
  const raw = asRecord(value) ?? {};
  const images = raw.images === undefined ? [] : raw.images;
  if (!Array.isArray(images)) throw new Error('ComfyUI 参考图映射必须是数组。');
  return {
    prompt: parseBinding(raw.prompt, '提示词'),
    seed: parseBinding(raw.seed, '种子'),
    width: parseBinding(raw.width, '宽度'),
    height: parseBinding(raw.height, '高度'),
    images: images.map((entry, index) => {
      const binding = parseBinding(entry, `参考图 ${index + 1}`);
      if (!binding) throw new Error(`ComfyUI 参考图 ${index + 1} 映射不能为空。`);
      return binding;
    }),
  };
}

function cloneWorkflow(raw: unknown): Record<string, JsonRecord> {
  const source = asRecord(raw);
  if (!source || Object.keys(source).length === 0) {
    throw new Error('请导入 ComfyUI 的 API 格式工作流 JSON。');
  }
  if (Array.isArray(source.nodes) && Array.isArray(source.links)) {
    throw new Error('当前文件是 ComfyUI 画布格式；请在 ComfyUI 中导出 API 格式工作流。');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(source);
  } catch {
    throw new Error('ComfyUI 工作流不是有效的 JSON 数据。');
  }
  if (serialized.length > MAX_WORKFLOW_BYTES) {
    throw new Error('ComfyUI 工作流超过 8 MiB，请移除内嵌媒体后再导入。');
  }
  const cloned = JSON.parse(serialized) as JsonRecord;
  for (const [nodeId, value] of Object.entries(cloned)) {
    const node = asRecord(value);
    if (!safeKey(nodeId) || !node || !nonemptyString(node.class_type) || !asRecord(node.inputs)) {
      throw new Error(`ComfyUI 节点 ${nodeId} 缺少 class_type 或 inputs；请使用 API 格式。`);
    }
  }
  return cloned as Record<string, JsonRecord>;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.min(max, Math.max(min, Math.floor(number)))
    : fallback;
}

export function isComfyUIProvider(cfg: Pick<CustomProviderConfig, 'apiStyle'>): boolean {
  return cfg.apiStyle === 'comfyui';
}

export function parseComfyUIConfig(cfg: CustomProviderConfig): ComfyUIConfig {
  const raw = asRecord(cfg.extraParams?.comfyui);
  if (!raw) throw new Error('ComfyUI 配置缺少 API 工作流。');
  const outputNodeIds = raw.outputNodeIds === undefined ? [] : raw.outputNodeIds;
  if (!Array.isArray(outputNodeIds) || outputNodeIds.some((item) => !safeKey(nonemptyString(item)))) {
    throw new Error('ComfyUI 输出节点 ID 必须是有效字符串数组。');
  }
  const workflow = cloneWorkflow(raw.workflow);
  for (const nodeId of outputNodeIds) {
    if (!Object.prototype.hasOwnProperty.call(workflow, nodeId)) {
      throw new Error(`ComfyUI 输出节点 ${nodeId} 不在工作流中。`);
    }
  }
  return {
    workflow,
    bindings: parseBindings(raw.bindings),
    outputNodeIds: outputNodeIds as string[],
    pollIntervalMs: boundedNumber(raw.pollIntervalMs, 1500, 500, 10000),
    pollTimeoutMs: boundedNumber(raw.pollTimeoutMs, 10 * 60 * 1000, 5000, 30 * 60 * 1000),
  };
}

function nodeInputs(workflow: Record<string, JsonRecord>, nodeId: string): JsonRecord {
  const inputs = asRecord(workflow[nodeId]?.inputs);
  if (!inputs) throw new Error(`ComfyUI 工作流中找不到节点 ${nodeId}。`);
  return inputs;
}

function setInput(
  workflow: Record<string, JsonRecord>,
  binding: ComfyUIInputBinding,
  value: unknown,
): void {
  const inputs = nodeInputs(workflow, binding.nodeId);
  if (!Object.prototype.hasOwnProperty.call(inputs, binding.input)) {
    throw new Error(`ComfyUI 节点 ${binding.nodeId} 没有输入字段 ${binding.input}。`);
  }
  inputs[binding.input] = value;
}

function findInput(
  workflow: Record<string, JsonRecord>,
  classPattern: RegExp,
  input: string,
): ComfyUIInputBinding | undefined {
  const matches = Object.entries(workflow).filter(([, node]) =>
    classPattern.test(nonemptyString(node.class_type))
    && Object.prototype.hasOwnProperty.call(asRecord(node.inputs) ?? {}, input)
  );
  return matches.length === 1 ? { nodeId: matches[0][0], input } : undefined;
}

export function suggestComfyUIBindings(workflowInput: unknown): ComfyUIBindings {
  const workflow = cloneWorkflow(workflowInput);
  const imageNodes = Object.entries(workflow).filter(([, node]) =>
    /^LoadImage(?:Mask)?$/i.test(nonemptyString(node.class_type))
    && Object.prototype.hasOwnProperty.call(asRecord(node.inputs) ?? {}, 'image')
  );
  return {
    prompt: findInput(workflow, /^CLIPTextEncode$/i, 'text'),
    seed: findInput(workflow, /^(?:KSampler|KSamplerAdvanced)$/i, 'seed'),
    width: findInput(workflow, /^EmptyLatentImage$/i, 'width'),
    height: findInput(workflow, /^EmptyLatentImage$/i, 'height'),
    images: imageNodes.map(([nodeId]) => ({ nodeId, input: 'image' })),
  };
}

export function suggestComfyUIOutputNodes(workflowInput: unknown): string[] {
  const workflow = cloneWorkflow(workflowInput);
  return Object.entries(workflow)
    .filter(([, node]) => /(?:SaveImage|SaveVideo|SaveAnimated|VideoCombine|VHS_)/i.test(nonemptyString(node.class_type)))
    .map(([nodeId]) => nodeId);
}

export function prepareComfyUIWorkflow(
  config: ComfyUIConfig,
  request: GenerateRequest,
  uploadedNames: string[] = [],
): Record<string, JsonRecord> {
  const workflow = cloneWorkflow(config.workflow);
  const suggested = suggestComfyUIBindings(workflow);
  const prompt = config.bindings.prompt ?? suggested.prompt;
  if (!prompt) throw new Error('请选择 ComfyUI 提示词节点及其输入字段。');
  setInput(workflow, prompt, request.prompt);

  const seed = config.bindings.seed ?? suggested.seed;
  const seedValue = Number(request.extra_params?.seed);
  if (seed && Number.isFinite(seedValue) && request.extra_params?.seed !== undefined) {
    setInput(workflow, seed, Math.floor(seedValue));
  }

  const geometry = resolveImageOutputGeometry({
    aspectRatio: request.aspect_ratio,
    selectedSize: request.extra_params?.resolutionType ?? request.size,
    defaultTier: '1k',
  });
  if (!geometry.ok) throw new Error(geometry.error);
  if (geometry.width && geometry.height) {
    const width = config.bindings.width ?? suggested.width;
    const height = config.bindings.height ?? suggested.height;
    if (width) setInput(workflow, width, geometry.width);
    if (height) setInput(workflow, height, geometry.height);
  }

  const referenceCount = request.reference_images?.length ?? 0;
  if (referenceCount > 0) {
    const imageBindings = config.bindings.images.length > 0 ? config.bindings.images : suggested.images;
    if (imageBindings.length < referenceCount) {
      throw new Error(`工作流只有 ${imageBindings.length} 个参考图输入，画布传入 ${referenceCount} 张；请增加 LoadImage 映射或减少参考图。`);
    }
    if (uploadedNames.length !== referenceCount) {
      throw new Error('ComfyUI 参考图上传结果数量不匹配。');
    }
    uploadedNames.forEach((name, index) => setInput(workflow, imageBindings[index], name));
  }
  return workflow;
}

export function validateComfyUIRequest(config: ComfyUIConfig, request: GenerateRequest): void {
  const count = request.reference_images?.length ?? 0;
  prepareComfyUIWorkflow(config, request, Array.from({ length: count }, (_, index) => `reference-${index + 1}.png`));
}

function uploadedImageName(payload: unknown): string {
  const record = asRecord(payload);
  const name = nonemptyString(record?.name);
  const subfolder = nonemptyString(record?.subfolder);
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('ComfyUI 上传图片后未返回有效文件名。');
  }
  if (subfolder.split(/[\\/]/).some((segment) => segment === '..')) {
    throw new Error('ComfyUI 上传图片返回了无效子目录。');
  }
  return subfolder ? `${subfolder}/${name}` : name;
}

export async function submitComfyUIWorkflow(
  config: ComfyUIConfig,
  request: GenerateRequest,
  transport: ComfyUITransport,
): Promise<{ prompt_id: string }> {
  validateComfyUIRequest(config, request);
  const uploadedNames: string[] = [];
  for (const [index, source] of (request.reference_images ?? []).entries()) {
    if (!/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(source)) {
      throw new Error('ComfyUI 参考图必须先转换为本地 data URL，不能直接上传远程地址。');
    }
    const mimeType = source.slice(5, source.indexOf(';'));
    const extension = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const response = await transport.multipart('/upload/image', {
      fields: [{ name: 'type', value: 'input' }],
      files: [{ name: 'image', fileName: `canvas-reference-${index + 1}.${extension}`, mimeType, dataUrl: source }],
    });
    uploadedNames.push(uploadedImageName(response));
  }
  const workflow = prepareComfyUIWorkflow(config, request, uploadedNames);
  const parsed = asRecord(await transport.json('/prompt', 'POST', { prompt: workflow }));
  const promptId = nonemptyString(parsed?.prompt_id);
  if (!promptId) {
    const detail = nonemptyString(asRecord(parsed?.error)?.message)
      || nonemptyString(parsed?.error)
      || '响应缺少 prompt_id';
    throw new Error(`ComfyUI 工作流提交失败：${detail}`);
  }
  return { prompt_id: promptId };
}

interface ComfyOutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

function outputFile(value: unknown, mediaType: 'image' | 'video'): ComfyOutputFile | null {
  const record = asRecord(value);
  const filename = nonemptyString(record?.filename);
  if (!filename || filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') return null;
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  if (!(mediaType === 'image' ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS).has(extension)) return null;
  const subfolder = nonemptyString(record?.subfolder);
  if (subfolder.split(/[\\/]/).some((part) => part === '..')) return null;
  const type = nonemptyString(record?.type) || 'output';
  if (type !== 'output' && type !== 'temp') return null;
  return { filename, subfolder, type };
}

function findOutputFile(
  outputs: JsonRecord,
  nodeIds: string[],
  mediaType: 'image' | 'video',
): ComfyOutputFile | null {
  const candidates: ComfyOutputFile[] = [];
  for (const nodeId of nodeIds) {
    const nodeOutput = asRecord(outputs[nodeId]);
    if (!nodeOutput) continue;
    const preferredKeys = mediaType === 'image' ? ['images', 'gifs', 'files'] : ['videos', 'gifs', 'files'];
    const keys = [
      ...preferredKeys,
      ...Object.keys(nodeOutput).filter((key) => !preferredKeys.includes(key)),
    ];
    for (const key of keys) {
      const files = nodeOutput[key];
      if (!Array.isArray(files)) continue;
      for (const value of files) {
        const file = outputFile(value, mediaType);
        if (file) candidates.push(file);
      }
    }
  }
  return candidates.find((file) => file.type === 'output') ?? candidates[0] ?? null;
}

function historyError(entry: JsonRecord): string | null {
  const status = asRecord(entry.status);
  const state = nonemptyString(status?.status_str ?? entry.status_str).toLowerCase();
  if (state !== 'error' && state !== 'failed') return null;
  const messages = status?.messages;
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  const detail = Array.isArray(last) ? asRecord(last[1]) : null;
  return nonemptyString(detail?.exception_message)
    || nonemptyString(detail?.exception_type)
    || 'ComfyUI 工作流执行失败。';
}

export function inspectComfyUIHistory(
  payload: unknown,
  promptId: string,
  config: ComfyUIConfig,
  mediaType: 'image' | 'video',
): { state: 'pending' | 'failed' | 'ready'; file?: ComfyOutputFile; error?: string } {
  const root = asRecord(payload);
  const entry = asRecord(root?.[promptId]) ?? (root?.outputs ? root : null);
  if (!entry) return { state: 'pending' };
  const error = historyError(entry);
  if (error) return { state: 'failed', error };
  const outputs = asRecord(entry.outputs) ?? {};
  const nodeIds = config.outputNodeIds.length > 0
    ? config.outputNodeIds
    : suggestComfyUIOutputNodes(config.workflow);
  const file = findOutputFile(outputs, nodeIds.length > 0 ? nodeIds : Object.keys(outputs), mediaType);
  if (file) return { state: 'ready', file };
  const status = asRecord(entry.status);
  if (status?.completed === true || nonemptyString(status?.status_str).toLowerCase() === 'success') {
    return { state: 'failed', error: `ComfyUI 已完成，但所选输出节点没有 ${mediaType === 'image' ? '图片' : '视频'}文件。` };
  }
  return { state: 'pending' };
}

export async function pollComfyUIWorkflow(
  config: ComfyUIConfig,
  promptId: string,
  mediaType: 'image' | 'video',
  transport: ComfyUITransport,
): Promise<string> {
  const startedAt = Date.now();
  let first = true;
  while (Date.now() - startedAt < config.pollTimeoutMs) {
    if (!first) await new Promise<void>((resolve) => setTimeout(resolve, config.pollIntervalMs));
    first = false;
    const payload = await transport.json(`/history/${encodeURIComponent(promptId)}`, 'GET');
    const result = inspectComfyUIHistory(payload, promptId, config, mediaType);
    if (result.state === 'failed') throw new ComfyUIExecutionError(result.error ?? 'ComfyUI 任务失败。');
    if (result.file) {
      return transport.url('/view', {
        filename: result.file.filename,
        subfolder: result.file.subfolder,
        type: result.file.type,
      });
    }
  }
  throw new Error(`ComfyUI 任务 ${promptId} 仍在运行；可稍后从生成任务恢复查询。`);
}

export async function checkComfyUIConnection(transport: ComfyUITransport): Promise<void> {
  try {
    await transport.json('/system_stats', 'GET');
  } catch {
    await transport.json('/queue', 'GET');
  }
}
