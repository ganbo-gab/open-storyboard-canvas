import {
  CANVAS_NODE_TYPES,
  isExportImageNode,
  isImageEditNode,
  isTextAnnotationNode,
  isUploadNode,
  type CanvasEdge,
  type CanvasNode,
  type JsonCardNodeData,
  type TextAnnotationNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import type {
  AiTextInputImagePart,
  AiTextInputPart,
  AiTextInputSourceType,
  AiTextInputTextPart,
  AiTextOpenAiChatPayload,
  AiTextResolvedResult,
  FlattenedJsonPathOption,
  JsonCardDisplayField,
  TextAgentConfig,
  TextAgentInputConfig,
} from './types';

const JSON_FENCE_PATTERN = /```json\s*([\s\S]*?)```/i;
const DEFAULT_TEXT_MODEL = 'gpt-4.1-mini';

interface JsonCardLikeNode extends CanvasNode {
  type: typeof CANVAS_NODE_TYPES.jsonCard;
  data: JsonCardNodeData;
}

interface TextAnnotationLikeNode extends CanvasNode {
  type: typeof CANVAS_NODE_TYPES.textAnnotation;
  data: TextAnnotationNodeData;
}

function isJsonCardNode(node: CanvasNode | null | undefined): node is JsonCardLikeNode {
  return node?.type === CANVAS_NODE_TYPES.jsonCard;
}

function isTextAgentResultNode(node: CanvasNode | null | undefined): node is TextAnnotationLikeNode {
  return node?.type === CANVAS_NODE_TYPES.textAnnotation;
}

function safeStringify(value: unknown, spacing = 2): string {
  try {
    return JSON.stringify(value, null, spacing);
  } catch {
    return String(value);
  }
}

function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function createDefaultLabel(type: AiTextInputSourceType, index: number): string {
  switch (type) {
    case 'json':
      return `JSON 输入 ${index}`;
    case 'image':
      return `图片输入 ${index}`;
    case 'markdown':
    default:
      return `文本输入 ${index}`;
  }
}

function createSourceConfigId(): string {
  return `agent-source-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createJsonFieldId(): string {
  return `agent-json-field-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function tokenizeJsonPath(path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed) {
    return [];
  }
  const normalized = trimmed.startsWith('$.') ? trimmed.slice(2) : trimmed.startsWith('$') ? trimmed.slice(1) : trimmed;
  if (!normalized) {
    return [];
  }
  const tokens: string[] = [];
  const pattern = /([^[.\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    if (match[1]) {
      tokens.push(match[1]);
    } else if (match[2]) {
      tokens.push(match[2]);
    }
  }
  return tokens;
}

export function getValueByJsonPath(source: unknown, path?: string): unknown {
  if (!path?.trim()) {
    return source;
  }
  const tokens = tokenizeJsonPath(path);
  let current: unknown = source;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function formatJsonPathValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return safeStringify(value, 2);
}

function appendFlattenedPaths(
  value: unknown,
  currentPath: string,
  results: FlattenedJsonPathOption[],
  visited: Set<unknown>,
  depth: number,
  maxDepth: number,
  limit: number
) {
  if (results.length >= limit || depth > maxDepth) {
    return;
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    results.push({
      path: currentPath || '$',
      label: currentPath || '$',
    });
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  if (visited.has(value)) {
    return;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      results.push({
        path: currentPath || '$',
        label: currentPath || '$',
      });
      return;
    }
    appendFlattenedPaths(
      value[0],
      currentPath || '$',
      results,
      visited,
      depth + 1,
      maxDepth,
      limit
    );
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    results.push({
      path: currentPath || '$',
      label: currentPath || '$',
    });
    return;
  }

  entries.forEach(([key, child]) => {
    if (results.length >= limit) {
      return;
    }
    const nextPath = currentPath ? `${currentPath}.${key}` : `$.${key}`;
    appendFlattenedPaths(child, nextPath, results, visited, depth + 1, maxDepth, limit);
  });
}

export function flattenJsonPaths(
  value: unknown,
  options: { maxDepth?: number; limit?: number } = {}
): FlattenedJsonPathOption[] {
  const results: FlattenedJsonPathOption[] = [];
  appendFlattenedPaths(
    value,
    '$',
    results,
    new Set<unknown>(),
    0,
    options.maxDepth ?? 4,
    options.limit ?? 48
  );
  const deduped = new Map<string, FlattenedJsonPathOption>();
  results.forEach((item) => {
    if (!deduped.has(item.path)) {
      deduped.set(item.path, item);
    }
  });
  return Array.from(deduped.values());
}

export function parseAgentJsonExample(raw: string): {
  parsed: unknown | null;
  options: FlattenedJsonPathOption[];
  error: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { parsed: null, options: [], error: null };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return {
      parsed,
      options: flattenJsonPaths(parsed),
      error: null,
    };
  } catch (error) {
    return {
      parsed: null,
      options: [],
      error: error instanceof Error ? error.message : 'JSON 解析失败',
    };
  }
}

export function createDefaultTextAgent(): TextAgentConfig {
  const now = Date.now();
  return {
    id: `text-agent-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: '新建 Agent',
    enabled: true,
    prompt: '',
    defaultModel: DEFAULT_TEXT_MODEL,
    inputSources: [{
      id: createSourceConfigId(),
      type: 'markdown',
      label: createDefaultLabel('markdown', 1),
      enabled: true,
    }],
    jsonExample: '',
    jsonFields: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeTextAgentInputSource(
  input: unknown,
  index: number
): TextAgentInputConfig | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const record = input as Partial<TextAgentInputConfig>;
  const type = record.type === 'json' || record.type === 'image' || record.type === 'markdown'
    ? record.type
    : 'markdown';
  return {
    id: typeof record.id === 'string' && record.id.trim() ? record.id : createSourceConfigId(),
    type,
    label: typeof record.label === 'string' && record.label.trim()
      ? record.label.trim()
      : createDefaultLabel(type, index + 1),
    sourceAgentId: typeof record.sourceAgentId === 'string' && record.sourceAgentId.trim()
      ? record.sourceAgentId.trim()
      : null,
    jsonPath: typeof record.jsonPath === 'string' && record.jsonPath.trim()
      ? record.jsonPath.trim()
      : undefined,
    enabled: record.enabled !== false,
  };
}

export function normalizeTextAgent(input: unknown): TextAgentConfig | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const record = input as Partial<TextAgentConfig>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  if (!id || !prompt) {
    return null;
  }

  const jsonFields = Array.isArray(record.jsonFields)
    ? record.jsonFields.flatMap((field) => {
      if (!field || typeof field !== 'object') {
        return [];
      }
      const fieldRecord = field as Partial<TextAgentConfig['jsonFields'][number]>;
      const path = typeof fieldRecord.path === 'string' ? fieldRecord.path.trim() : '';
      if (!path) {
        return [];
      }
      return [{
        id: typeof fieldRecord.id === 'string' && fieldRecord.id.trim()
          ? fieldRecord.id
          : createJsonFieldId(),
        path,
        label: typeof fieldRecord.label === 'string' && fieldRecord.label.trim()
          ? fieldRecord.label.trim()
          : path,
        enabled: fieldRecord.enabled !== false,
      }];
    })
    : [];

  const inputSources = Array.isArray(record.inputSources)
    ? record.inputSources
      .map((item, index) => normalizeTextAgentInputSource(item, index))
      .filter((item): item is TextAgentInputConfig => Boolean(item))
    : [];

  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? record.createdAt
    : Date.now();
  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
    ? record.updatedAt
    : createdAt;

  return {
    id,
    name: typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : '未命名 Agent',
    enabled: record.enabled !== false,
    prompt,
    defaultModel: typeof record.defaultModel === 'string' && record.defaultModel.trim()
      ? record.defaultModel.trim()
      : DEFAULT_TEXT_MODEL,
    inputSources: inputSources.length > 0
      ? inputSources
      : [{
        id: createSourceConfigId(),
        type: 'markdown',
        label: createDefaultLabel('markdown', 1),
        enabled: true,
      }],
    jsonExample: typeof record.jsonExample === 'string' ? record.jsonExample : '',
    jsonFields,
    createdAt,
    updatedAt,
  };
}

export function normalizeTextAgents(input: unknown): TextAgentConfig[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  return input
    .map((item) => normalizeTextAgent(item))
    .filter((item): item is TextAgentConfig => {
      if (!item || seen.has(item.id)) {
        return false;
      }
      seen.add(item.id);
      return true;
    })
    .slice(0, 200);
}

function resolveJsonTextContent(node: JsonCardLikeNode, jsonPath?: string): string {
  const { parsedJson, rawContent } = node.data;
  if (!jsonPath?.trim()) {
    return parsedJson !== null && parsedJson !== undefined ? safeStringify(parsedJson, 2) : rawContent;
  }
  const value = getValueByJsonPath(parsedJson, jsonPath);
  return value === undefined ? '' : formatJsonPathValue(value);
}

function createMarkdownPart(node: CanvasNode, label: string): AiTextInputTextPart | null {
  if (!isTextAnnotationNode(node)) {
    return null;
  }
  const content = typeof node.data.content === 'string' ? node.data.content.trim() : '';
  if (!content) {
    return null;
  }
  return {
    kind: 'text',
    sourceType: 'markdown',
    sourceNodeId: node.id,
    label,
    content,
  };
}

function createJsonPart(
  node: CanvasNode,
  label: string,
  jsonPath?: string
): AiTextInputTextPart | null {
  if (!isJsonCardNode(node)) {
    return null;
  }
  const content = resolveJsonTextContent(node, jsonPath).trim();
  if (!content) {
    return null;
  }
  return {
    kind: 'text',
    sourceType: 'json',
    sourceNodeId: node.id,
    label,
    content,
    jsonPath,
  };
}

function createImagePart(node: CanvasNode, label: string): AiTextInputImagePart | null {
  if (!isUploadNode(node) && !isImageEditNode(node) && !isExportImageNode(node)) {
    return null;
  }
  const imageUrl =
    (typeof node.data.imageUrl === 'string' && node.data.imageUrl.trim())
      || (typeof node.data.previewImageUrl === 'string' && node.data.previewImageUrl.trim())
      || '';
  if (!imageUrl) {
    return null;
  }
  return {
    kind: 'image',
    sourceType: 'image',
    sourceNodeId: node.id,
    label,
    imageUrl,
    previewImageUrl:
      typeof node.data.previewImageUrl === 'string' ? node.data.previewImageUrl : null,
  };
}

function sourceTypeForNode(node: CanvasNode): AiTextInputSourceType | null {
  if (isTextAnnotationNode(node)) {
    return 'markdown';
  }
  if (isJsonCardNode(node)) {
    return 'json';
  }
  if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
    return 'image';
  }
  return null;
}

function buildPartFromConfig(node: CanvasNode, config: TextAgentInputConfig): AiTextInputPart | null {
  switch (config.type) {
    case 'json':
      return createJsonPart(node, config.label, config.jsonPath);
    case 'image':
      return createImagePart(node, config.label);
    case 'markdown':
    default:
      return createMarkdownPart(node, config.label);
  }
}

function resolveInputPartLabel(
  config: TextAgentInputConfig,
  sourceAgents: TextAgentConfig[]
): string {
  const agentName = config.sourceAgentId
    ? sourceAgents.find((item) => item.id === config.sourceAgentId)?.name?.trim()
    : '';
  if (!agentName) {
    return config.label;
  }
  if (config.type === 'json') {
    return `${agentName} JSON${config.jsonPath?.trim() ? ` ${config.jsonPath.trim()}` : ''}`;
  }
  if (config.type === 'markdown') {
    return `${agentName} 文本`;
  }
  return `${agentName} 图片`;
}

function findAgentTextOutputNode(
  nodeId: string,
  nodes: CanvasNode[],
  sourceAgentId?: string | null
): TextAnnotationLikeNode | null {
  if (!sourceAgentId) {
    return null;
  }

  return nodes.find((node): node is TextAnnotationLikeNode => (
    isTextAgentResultNode(node)
    && node.data.sourceAiNodeId === nodeId
    && node.data.sourceAgentId === sourceAgentId
  )) ?? null;
}

function findAgentJsonOutputNode(
  nodeId: string,
  nodes: CanvasNode[],
  sourceAgentId?: string | null
): JsonCardLikeNode | null {
  if (!sourceAgentId) {
    return null;
  }

  return nodes.find((node): node is JsonCardLikeNode => (
    isJsonCardNode(node)
    && node.data.sourceAiNodeId === nodeId
    && node.data.sourceAgentId === sourceAgentId
  )) ?? null;
}

export function collectDirectSourceNodes(
  nodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[]
): CanvasNode[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
  const seen = new Set<string>();
  return edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => edge.source)
    .filter((sourceId) => {
      if (seen.has(sourceId)) {
        return false;
      }
      seen.add(sourceId);
      return true;
    })
    .map((sourceId) => nodeMap.get(sourceId))
    .filter((node): node is CanvasNode => Boolean(node));
}

export function collectAiTextInputs(
  nodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  agent?: TextAgentConfig | null,
  sourceAgents: TextAgentConfig[] = []
): AiTextInputPart[] {
  const sourceNodes = collectDirectSourceNodes(nodeId, nodes, edges);
  const pool = {
    markdown: [] as CanvasNode[],
    json: [] as CanvasNode[],
    image: [] as CanvasNode[],
  };

  sourceNodes.forEach((node) => {
    const type = sourceTypeForNode(node);
    if (type) {
      pool[type].push(node);
    }
  });

  const parts: AiTextInputPart[] = [];
  const used = new Set<string>();
  const configs = agent?.inputSources.filter((item) => item.enabled) ?? [];

  configs.forEach((config) => {
    if (config.type === 'markdown' && config.sourceAgentId) {
      const agentTextNode = findAgentTextOutputNode(nodeId, nodes, config.sourceAgentId);
      if (!agentTextNode || used.has(agentTextNode.id)) {
        return;
      }
      const part = createMarkdownPart(agentTextNode, resolveInputPartLabel(config, sourceAgents));
      if (!part) {
        return;
      }
      parts.push(part);
      used.add(agentTextNode.id);
      return;
    }

    if (config.type === 'json' && config.sourceAgentId) {
      const agentJsonNode = findAgentJsonOutputNode(nodeId, nodes, config.sourceAgentId);
      if (!agentJsonNode || used.has(agentJsonNode.id)) {
        return;
      }
      const part = createJsonPart(agentJsonNode, resolveInputPartLabel(config, sourceAgents), config.jsonPath);
      if (!part) {
        return;
      }
      parts.push(part);
      used.add(agentJsonNode.id);
      return;
    }

    const candidate = pool[config.type].find((node) => !used.has(node.id));
    if (!candidate) {
      return;
    }
    const part = buildPartFromConfig(candidate, config);
    if (!part) {
      return;
    }
    parts.push(part);
    used.add(candidate.id);
  });

  (['markdown', 'json', 'image'] as const).forEach((type) => {
    let index = 0;
    pool[type].forEach((node) => {
      if (used.has(node.id)) {
        return;
      }
      index += 1;
      const fallbackLabel = resolveNodeDisplayName(node.type, node.data) || createDefaultLabel(type, index);
      const part = buildPartFromConfig(node, {
        id: createSourceConfigId(),
        type,
        label: fallbackLabel,
        enabled: true,
      });
      if (!part) {
        return;
      }
      parts.push(part);
      used.add(node.id);
    });
  });

  return parts;
}

export function buildAiTextUserPrompt(parts: AiTextInputPart[], userPrompt: string): string {
  const sections = parts.map((part) => {
    if (part.kind === 'image') {
      return `## 输入：${part.label}\n[图像输入]`;
    }
    return `## 输入：${part.label}\n${normalizeLineBreaks(part.content).trim()}`;
  });

  const taskSection = `## 任务\n${normalizeLineBreaks(userPrompt).trim()}`;
  return [...sections, taskSection].filter((item) => item.trim().length > 0).join('\n\n');
}

export function buildOpenAiChatPayload(args: {
  model?: string | null;
  agentPrompt: string;
  userPrompt: string;
  parts: AiTextInputPart[];
}): AiTextOpenAiChatPayload {
  const normalizedModel = args.model?.trim() || DEFAULT_TEXT_MODEL;
  const compiledPrompt = buildAiTextUserPrompt(args.parts, args.userPrompt);
  const imageParts = args.parts
    .filter((part): part is AiTextInputImagePart => part.kind === 'image')
    .map((part) => ({
      type: 'image_url' as const,
      image_url: {
        url: part.imageUrl,
      },
    }));

  return {
    model: normalizedModel,
    messages: [
      {
        role: 'system',
        content: args.agentPrompt.trim(),
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: compiledPrompt,
          },
          ...imageParts,
        ],
      },
    ],
  };
}

export function computeAiTextInputHash(args: {
  agentId?: string | null;
  providerId?: string | null;
  model?: string | null;
  agentPrompt: string;
  userPrompt: string;
  parts: AiTextInputPart[];
}): string {
  const signature = safeStringify({
    agentId: args.agentId ?? null,
    providerId: args.providerId ?? null,
    model: args.model?.trim() || DEFAULT_TEXT_MODEL,
    agentPrompt: normalizeLineBreaks(args.agentPrompt.trim()),
    userPrompt: normalizeLineBreaks(args.userPrompt.trim()),
    parts: args.parts.map((part) =>
      part.kind === 'image'
        ? {
          kind: part.kind,
          label: part.label,
          imageUrl: part.imageUrl,
        }
        : {
          kind: part.kind,
          label: part.label,
          content: normalizeLineBreaks(part.content),
          jsonPath: part.jsonPath ?? null,
        }),
  });

  let hash = 0;
  for (let index = 0; index < signature.length; index += 1) {
    hash = ((hash << 5) - hash) + signature.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function resolveAiTextResult(raw: string): AiTextResolvedResult {
  const normalized = normalizeLineBreaks(raw).trim();
  if (!normalized) {
    return {
      kind: 'markdown',
      rawContent: '',
      markdownContent: '',
    };
  }

  try {
    return {
      kind: 'json',
      rawContent: normalized,
      parsedJson: JSON.parse(normalized) as unknown,
      parseError: null,
    };
  } catch {
    // Ignore and continue to fenced parsing.
  }

  const fencedMatch = normalized.match(JSON_FENCE_PATTERN);
  if (fencedMatch?.[1]) {
    const fencedContent = fencedMatch[1].trim();
    try {
      return {
        kind: 'json',
        rawContent: normalized,
        parsedJson: JSON.parse(fencedContent) as unknown,
        parseError: null,
      };
    } catch (error) {
      return {
        kind: 'markdown',
        rawContent: normalized,
        markdownContent: normalized,
        parseError: error instanceof Error ? error.message : 'JSON 解析失败',
      };
    }
  }

  return {
    kind: 'markdown',
    rawContent: normalized,
    markdownContent: normalized,
  };
}

export function resolveJsonCardDisplayFields(
  agent: TextAgentConfig | null | undefined,
  parsedJson: unknown
): JsonCardDisplayField[] {
  if (!agent?.jsonFields?.length) {
    return [];
  }

  return agent.jsonFields
    .filter((field) => field.enabled)
    .map((field) => {
      const value = Array.isArray(parsedJson)
        ? getValueByJsonPath(parsedJson[0], field.path)
        : getValueByJsonPath(parsedJson, field.path);
      if (value === undefined) {
        return null;
      }
      return {
        path: field.path,
        label: field.label,
        value: formatJsonPathValue(value),
      };
    })
    .filter((field): field is JsonCardDisplayField => Boolean(field));
}

export const AI_TEXT_MODEL_OPTIONS = [
  'gpt-4.1-mini',
  'gpt-4.1',
  'gpt-4o-mini',
  'gpt-4o',
];
