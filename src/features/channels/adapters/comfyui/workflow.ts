export type WorkflowRecord = Record<string, unknown>;
export type ComfyUIWorkflow = Record<string, WorkflowRecord>;
export interface ComfyUIInputBinding { nodeId: string; input: string }

export function asRecord(value: unknown): WorkflowRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as WorkflowRecord : null;
}

export function nonemptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function safeKey(value: string): boolean {
  return Boolean(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
}

/** Validate and detach an API-format workflow before any network side effects. */
export function cloneWorkflow(raw: unknown): ComfyUIWorkflow {
  const source = asRecord(raw);
  if (!source || Object.keys(source).length === 0) throw new Error('请导入 ComfyUI 的 API 格式工作流 JSON。');
  if (Array.isArray(source.nodes) && Array.isArray(source.links)) {
    throw new Error('当前文件是 ComfyUI 画布格式；请在 ComfyUI 中导出 API 格式工作流。');
  }
  let serialized: string;
  try { serialized = JSON.stringify(source); }
  catch { throw new Error('ComfyUI 工作流不是有效的 JSON 数据。'); }
  if (serialized.length > 8 * 1024 * 1024) throw new Error('ComfyUI 工作流超过 8 MiB，请移除内嵌媒体后再导入。');
  const cloned = JSON.parse(serialized) as WorkflowRecord;
  for (const [nodeId, value] of Object.entries(cloned)) {
    const node = asRecord(value);
    if (!safeKey(nodeId) || !node || !nonemptyString(node.class_type) || !asRecord(node.inputs)) {
      throw new Error(`ComfyUI 节点 ${nodeId} 缺少 class_type 或 inputs；请使用 API 格式。`);
    }
  }
  return cloned as ComfyUIWorkflow;
}

export function nodeInputs(workflow: ComfyUIWorkflow, nodeId: string): WorkflowRecord {
  const inputs = safeKey(nodeId) ? asRecord(workflow[nodeId]?.inputs) : null;
  if (!inputs) throw new Error(`ComfyUI 工作流中找不到节点 ${nodeId}。`);
  return inputs;
}

export function setInput(workflow: ComfyUIWorkflow, binding: ComfyUIInputBinding, value: unknown): void {
  const inputs = nodeInputs(workflow, binding.nodeId);
  if (!safeKey(binding.input)) throw new Error(`ComfyUI 节点 ${binding.nodeId} 没有输入字段 ${binding.input}。`);
  if (!Object.prototype.hasOwnProperty.call(inputs, binding.input)) throw new Error(`ComfyUI 节点 ${binding.nodeId} 没有输入字段 ${binding.input}。`);
  inputs[binding.input] = value;
}

export function uploadedImageName(payload: unknown): string {
  const record = asRecord(payload);
  const name = nonemptyString(record?.name);
  const subfolder = nonemptyString(record?.subfolder);
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') throw new Error('ComfyUI 上传图片后未返回有效文件名。');
  if (subfolder.split(/[\\/]/).some((segment) => segment === '..')) throw new Error('ComfyUI 上传图片返回了无效子目录。');
  return subfolder ? `${subfolder}/${name}` : name;
}

export interface ComfyOutputFile { filename: string; subfolder: string; type: string }
const EXTENSIONS: Record<'image' | 'video' | 'audio', Record<string, true>> = {
  image: { png: true, jpg: true, jpeg: true, webp: true, gif: true, bmp: true, avif: true },
  video: { mp4: true, webm: true, mov: true, m4v: true },
  audio: { mp3: true, wav: true, ogg: true, flac: true, m4a: true, aac: true },
};

export function outputFile(value: unknown, mediaType: 'image' | 'video' | 'audio'): ComfyOutputFile | null {
  const record = asRecord(value);
  const filename = nonemptyString(record?.filename);
  if (!filename || filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') return null;
  if (!Object.prototype.hasOwnProperty.call(EXTENSIONS[mediaType], filename.split('.').pop()?.toLowerCase() ?? '')) return null;
  const subfolder = nonemptyString(record?.subfolder);
  if (subfolder.split(/[\\/]/).some((part) => part === '..')) return null;
  const type = nonemptyString(record?.type) || 'output';
  if (type !== 'output' && type !== 'temp') return null;
  return { filename, subfolder, type };
}

export function historyError(entry: WorkflowRecord): string | null {
  const status = asRecord(entry.status);
  const state = nonemptyString(status?.status_str ?? entry.status_str).toLowerCase();
  if (state !== 'error' && state !== 'failed') return null;
  const messages = status?.messages;
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  const detail = Array.isArray(last) ? asRecord(last[1]) : null;
  return nonemptyString(detail?.exception_message) || nonemptyString(detail?.exception_type) || 'ComfyUI 工作流执行失败。';
}
