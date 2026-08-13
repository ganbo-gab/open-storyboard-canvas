import { resolveImageOutputGeometry } from '@/features/canvas/application/imageOutputGeometry';
import { buildGenerateImageDebugPreview } from '@/features/canvas/infrastructure/tauriAiGateway';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  getGenerationJobRecord,
  listGenerationJobs,
  type GenerationJobStatus,
} from '@/commands/ai';
import { redactSensitiveValue, scanForSensitiveOutput } from './agentRedaction';

export type DiagnosisClass = 'input' | 'configuration' | 'upstream' | 'network' | 'application-bug' | 'unknown';
export type DiagnosisEvidenceSource = 'validator' | 'provider' | 'runtime' | 'canvas';
export type DiagnosisEvidenceSeverity = 'blocking' | 'warning' | 'info';

export interface DiagnosisEvidence {
  code: string;
  message: string;
  source: DiagnosisEvidenceSource;
  severity: DiagnosisEvidenceSeverity;
  nodeIds?: string[];
  edgeIds?: string[];
  fieldPaths?: string[];
}

export interface SafeDiagnosticEvent {
  timestamp?: number;
  source: DiagnosisEvidenceSource;
  code?: string;
  status?: string;
  message: string;
  nodeIds?: string[];
}

export interface DiagnosticConfigDiff {
  path: string;
  before: unknown;
  after: unknown;
}

export interface DiagnosisReport {
  classification: DiagnosisClass[];
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  evidence: DiagnosisEvidence[];
  userWorkaround?: string;
  configFix?: { kind: 'provider' | 'model' | 'settings'; description: string; patch: Record<string, unknown> };
  softwareFix?: string;
  unknowns: string[];
  eventTimeline: SafeDiagnosticEvent[];
  configSnapshotDiff: DiagnosticConfigDiff[];
}

export interface AgentDiagnosticErrorInput {
  message?: string;
  status?: number;
  statusCode?: number;
  code?: string;
  capability?: 'vision' | 'tools';
  phase?: 'request' | 'response' | 'runtime';
}

export interface CanvasHealthOptions {
  nodeIds?: string[];
  now?: number;
  stalledAfterMs?: number;
}

export interface GenerationPreflightInput extends CanvasHealthOptions {
  width?: number;
  height?: number;
  aspectRatio?: string;
  resolution?: string;
  maxPixels?: number;
  requiresVision?: boolean;
  supportsVision?: boolean;
  requiresTools?: boolean;
  supportsTools?: boolean;
  accessState?: 'configured' | 'missing';
  endpointValid?: boolean;
}

export interface DiagnosticEvidenceInput {
  events?: readonly unknown[];
  lastKnownGoodConfig?: unknown;
  currentConfig?: unknown;
}

export interface DiagnosticBundlePreview {
  version: 1;
  createdAt: number;
  publication: 'draft-only';
  report: DiagnosisReport;
  canvasHealth: DiagnosisReport;
  runtimeSnapshot?: unknown;
  configSnapshot: {
    current: unknown;
    lastKnownGood?: unknown;
    diff: DiagnosticConfigDiff[];
  };
  reproductionSteps: string[];
  issueDraft: {
    title: string;
    body: string;
  };
  security: {
    passed: boolean;
    findings: string[];
  };
}

export interface SafeGenerationJobDiagnostic {
  jobId: string;
  status: GenerationJobStatus['status'];
  mediaType: GenerationJobStatus['media_type'];
  providerId: string | null;
  modelId: string | null;
  phase: string | null;
  errorCategory: string | null;
  error: string | null;
  networkRoute: GenerationJobStatus['network_route'] | null;
  externalTaskId: string | null;
  hasResultUrl: boolean;
  safeRecoveryAvailable: boolean;
  automaticResubmitAllowed: false;
  billingRisk: 'possible' | 'not-indicated';
  submitAttempts: number;
  consecutiveNetworkErrors: number;
  createdAt: number | null;
  updatedAt: number | null;
}

const DEFAULT_STALLED_JOB_MS = 30 * 60_000;
const MAX_SAFE_COLLECTION_ITEMS = 100;
const SENSITIVE_FIELD = /(?:api.?key|authorization|cookie|token|secret|password|credential|private.?key)/i;
const VALID_ASPECT_RATIO = /^(?:auto|original|source|adaptive|\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?)$/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const redacted = redactSensitiveValue(value).slice(0, 2_000);
  return scanForSensitiveOutput(redacted).length > 0 ? '[redacted-sensitive-value]' : redacted;
}

function safeLocationId(value: string): string {
  const safe = safeText(value);
  return safe && !safe.startsWith('[redacted') ? safe.slice(0, 160) : '[redacted-id]';
}

export function projectSafeGenerationJobDiagnostic(
  job: GenerationJobStatus,
): SafeGenerationJobDiagnostic {
  const externalTaskId = typeof job.external_task_id === 'string' && job.external_task_id.trim()
    ? safeLocationId(job.external_task_id.trim())
    : null;
  const hasResultUrl = typeof job.result_url === 'string' && job.result_url.trim().length > 0;
  return {
    jobId: safeLocationId(job.job_id),
    status: job.status,
    mediaType: job.media_type ?? 'unknown',
    providerId: job.provider_id ? safeLocationId(job.provider_id) : null,
    modelId: job.model_id ? safeLocationId(job.model_id) : null,
    phase: job.phase ? safeText(job.phase) : null,
    errorCategory: job.error_category ? safeText(job.error_category) : null,
    error: job.error ? safeText(job.error) : null,
    networkRoute: job.network_route ?? null,
    externalTaskId,
    hasResultUrl,
    safeRecoveryAvailable: job.resumable !== false && Boolean(externalTaskId || hasResultUrl),
    automaticResubmitAllowed: false,
    billingRisk: job.status === 'unknown' ? 'possible' : 'not-indicated',
    submitAttempts: Math.max(0, Math.min(1, job.submit_attempts ?? 0)),
    consecutiveNetworkErrors: Math.max(0, job.consecutive_network_errors ?? 0),
    createdAt: typeof job.created_at === 'number' ? job.created_at : null,
    updatedAt: typeof job.updated_at === 'number' ? job.updated_at : null,
  };
}

export async function inspectPersistedGenerationJobs(input: {
  jobId?: string;
  limit?: number;
} = {}): Promise<{
  desktopPersistenceAvailable: boolean;
  jobs: SafeGenerationJobDiagnostic[];
  recoveryPolicy: string;
}> {
  const jobId = typeof input.jobId === 'string' ? input.jobId.trim() : '';
  const limit = Math.max(1, Math.min(50, Math.round(input.limit ?? 20)));
  try {
    const jobs = jobId
      ? [await getGenerationJobRecord(jobId)]
      : await listGenerationJobs(limit);
    return {
      desktopPersistenceAvailable: true,
      jobs: jobs.map(projectSafeGenerationJobDiagnostic),
      recoveryPolicy: 'unknown 不会自动重提；只有已保存上游 task id 或结果 URL 的任务才能安全恢复。',
    };
  } catch (error) {
    return {
      desktopPersistenceAvailable: false,
      jobs: [],
      recoveryPolicy: safeText(error instanceof Error ? error.message : String(error)),
    };
  }
}

export function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 7) return '[redacted-depth]';
  if (typeof value === 'string') return safeText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_SAFE_COLLECTION_ITEMS)
      .map((item) => sanitizeDiagnosticValue(item, depth + 1));
  }
  if (!isPlainRecord(value)) return '[redacted-non-json-value]';
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_SAFE_COLLECTION_ITEMS)) {
    if (SENSITIVE_FIELD.test(key)) continue;
    const safeKey = safeText(key);
    if (!safeKey || safeKey.startsWith('[redacted')) continue;
    result[safeKey] = sanitizeDiagnosticValue(child, depth + 1);
  }
  return result;
}

function report(input: Omit<DiagnosisReport, 'eventTimeline' | 'configSnapshotDiff'> & Partial<Pick<DiagnosisReport, 'eventTimeline' | 'configSnapshotDiff'>>): DiagnosisReport {
  return {
    ...input,
    eventTimeline: input.eventTimeline ?? [],
    configSnapshotDiff: input.configSnapshotDiff ?? [],
  };
}

function errorDescriptor(error: unknown): Required<Pick<AgentDiagnosticErrorInput, 'message'>> & AgentDiagnosticErrorInput {
  if (error instanceof Error) {
    const candidate = error as Error & { status?: unknown; statusCode?: unknown; code?: unknown };
    return {
      message: error.message,
      status: typeof candidate.status === 'number' ? candidate.status : undefined,
      statusCode: typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined,
      code: typeof candidate.code === 'string' ? candidate.code : undefined,
    };
  }
  if (isPlainRecord(error)) {
    const nestedResponse = isPlainRecord(error.response) ? error.response : null;
    const status = [error.status, error.statusCode, nestedResponse?.status]
      .find((value): value is number => typeof value === 'number' && Number.isInteger(value));
    const message = [error.message, error.error, nestedResponse?.message]
      .find((value): value is string => typeof value === 'string') ?? '未知错误';
    return {
      message,
      status,
      statusCode: status,
      code: typeof error.code === 'string' ? error.code : undefined,
      capability: error.capability === 'vision' || error.capability === 'tools' ? error.capability : undefined,
      phase: error.phase === 'request' || error.phase === 'response' || error.phase === 'runtime' ? error.phase : undefined,
    };
  }
  return { message: String(error ?? '未知错误') };
}

function evidence(code: string, message: string, source: DiagnosisEvidenceSource, severity: DiagnosisEvidenceSeverity = 'blocking'): DiagnosisEvidence {
  return { code, message, source, severity };
}

export function classifyAgentError(error: unknown): DiagnosisReport {
  const descriptor = errorDescriptor(error);
  const message = descriptor.message;
  const normalized = `${descriptor.code ?? ''} ${message}`.toLowerCase();
  const status = (
    descriptor.status
    ?? descriptor.statusCode
    ?? Number(normalized.match(/(?:^|\D)([1-5]\d{2})(?:\D|$)/)?.[1] ?? 0)
  ) || undefined;

  if (/pixel|像素|尺寸|resolution|width|height|aspect|8,?294,?400|8294400/.test(normalized)) {
    return report({
      classification: ['input', 'configuration'],
      confidence: 'high',
      summary: '请求几何参数超过上游像素限制。临时输入规避、供应商映射修正和软件通用约束修复应分别处理。',
      evidence: [evidence('request-pixel-limit', '请求尺寸超过供应商声明的硬限制，可在提交前通过像素计算确定。', 'validator')],
      userWorkaround: '临时降低分辨率档位，或选择同一比例下受支持的较小像素尺寸。',
      configFix: {
        kind: 'provider',
        description: '核对供应商的比例尺寸映射与 imageOutputLimits；只有供应商文档证明上限不同时才修改映射。',
        patch: { action: 'review-image-output-mapping', constraint: 'maxPixels' },
      },
      softwareFix: '所有比例和档位统一使用通用像素约束求解与提交前阻断，不能只对 3:4 或单一模型做特判。',
      unknowns: [],
    });
  }

  const missingAccess = /(?:missing|not configured|unset|缺少|未配置|为空).{0,32}(?:api.?key|credential|密钥)|(?:api.?key|credential|密钥).{0,32}(?:missing|not configured|unset|缺少|未配置|为空)/.test(normalized)
    || /missing[_-]?(?:api[_-]?key|credential)/.test(normalized);
  if (missingAccess) {
    return report({
      classification: ['configuration'], confidence: 'high', summary: '供应商访问凭据未配置。',
      evidence: [evidence('auth-missing', '仅确认访问凭据状态为 missing；未读取凭据实值。', 'validator')],
      unknowns: [],
    });
  }

  const capability = descriptor.capability
    ?? (/\bvision\b|视觉|多模态/.test(normalized) ? 'vision' : /\btools?\b|function.?call|工具调用/.test(normalized) ? 'tools' : undefined);
  const unsupported = /unsupported|not supported|does not support|不支持|不可用|capability/.test(normalized);
  if (capability && unsupported) {
    const isVision = capability === 'vision';
    return report({
      classification: ['configuration'], confidence: 'high',
      summary: isVision ? '所选模型不支持当前请求所需的视觉输入。' : '所选模型不支持画布 Agent 所需的工具调用。',
      evidence: [evidence(isVision ? 'capability-vision-unsupported' : 'capability-tools-unsupported', isVision ? '模型 capability 声明 vision=false。' : '模型 capability 声明 tools=false。', 'validator')],
      configFix: { kind: 'model', description: isVision ? '选择明确声明视觉能力的模型。' : '选择明确声明工具调用能力的模型。', patch: { capability: isVision ? 'vision' : 'tools', required: true } },
      unknowns: [],
    });
  }

  if (/invalid[_-]?endpoint|endpoint.{0,30}(?:invalid|unreachable|not found)|base.?url.{0,30}(?:invalid|错误|无效)|错误.{0,20}(?:endpoint|base.?url)|无效.{0,20}(?:endpoint|base.?url)/.test(normalized)) {
    return report({
      classification: ['configuration'], confidence: 'high', summary: '供应商 endpoint 配置无效或与协议不匹配。',
      evidence: [evidence('endpoint-invalid', '请求路由在付费提交前未通过 endpoint 校验。', 'validator')],
      unknowns: [],
    });
  }

  if (status === 401 || status === 403 || /authentication failed|unauthorized|forbidden|鉴权失败|未授权/.test(normalized)) {
    return report({
      classification: ['configuration'], confidence: 'high', summary: '供应商拒绝了当前鉴权或权限。',
      evidence: [evidence('auth-rejected', `供应商返回 ${status ?? '鉴权拒绝'}；诊断未读取或回显凭据。`, 'provider')],
      unknowns: ['无法仅凭拒绝响应区分凭据错误、权限范围不足或账号策略限制。'],
    });
  }

  if (status === 429 || /rate.?limit|too many requests|quota|限流|配额/.test(normalized)) {
    return report({
      classification: ['upstream'], confidence: 'high', summary: '上游正在限流或拒绝当前配额。',
      evidence: [evidence('upstream-rate-limit', '供应商返回 HTTP 429 或等价的限流代码。', 'provider')],
      userWorkaround: '等待供应商给出的重试窗口；不要自动重放可能已经受理的付费请求。',
      unknowns: [],
    });
  }

  if ((status !== undefined && status >= 500 && status <= 599) || /\b(?:5\d{2})\b|internal server error|bad gateway|service unavailable|上游服务异常/.test(normalized)) {
    return report({
      classification: ['upstream'], confidence: 'high', summary: '供应商服务端发生暂时性故障。',
      evidence: [evidence('upstream-server-error', `供应商返回 ${status ?? '5xx'} 服务端错误。`, 'provider')],
      unknowns: ['无法从服务端错误确定付费请求是否已被受理；禁止自动重提。'],
    });
  }

  if (/proxy|代理|tunnel/.test(normalized)) {
    return report({
      classification: ['network', 'configuration'], confidence: 'high', summary: '代理路线或代理服务连接失败。',
      evidence: [evidence('network-proxy-failure', '错误发生在代理解析、连接或隧道阶段。', 'runtime')],
      configFix: { kind: 'settings', description: '检查生成网络路线与 HTTP/HTTPS 代理地址，或切换回系统代理后测试连接。', patch: { action: 'review-generation-network-route' } },
      unknowns: ['代理失败时无法仅凭本机错误判断付费提交是否已经到达上游。'],
    });
  }

  if (/dns|enotfound|name or service|域名.{0,12}(?:失败|解析)|解析.{0,12}域名/.test(normalized)) {
    return report({
      classification: ['network'], confidence: 'high', summary: '域名解析失败，当前路线无法定位供应商主机。',
      evidence: [evidence('network-dns-failure', '网络层报告 DNS 或主机名解析错误。', 'runtime')],
      unknowns: [],
    });
  }

  if (/tls|ssl|certificate|证书/.test(normalized)) {
    return report({
      classification: ['network', 'configuration'], confidence: 'high', summary: 'TLS 或证书校验失败。',
      evidence: [evidence('network-tls-failure', '安全连接在证书或 TLS 握手阶段失败。', 'runtime')],
      unknowns: ['需要核对系统时间、证书链、代理中间证书和供应商域名。'],
    });
  }

  if (/timeout|timed out|deadline exceeded|etimedout|aborterror|超时/.test(normalized)) {
    return report({
      classification: ['network'], confidence: 'high', summary: '请求超时，提交结果处于未知状态。',
      evidence: [evidence('network-timeout-unknown-result', '未收到确定响应，不能假设上游未受理请求。', 'runtime')],
      unknowns: ['需要使用原 jobId 或供应商查询接口确认状态；禁止自动重提付费请求。'],
    });
  }

  if (/malformed|invalid json|unexpected token|json parse|parse error|schema mismatch|decode|解析|响应格式/.test(normalized)) {
    return report({
      classification: ['upstream'], confidence: 'high', summary: '供应商响应不符合已选择的协议或 schema。',
      evidence: [evidence('provider-response-malformed', '响应边界的确定性解析器拒绝了 malformed payload。', 'provider')],
      softwareFix: '若脱敏响应证明供应商协议有效，应修正通用响应适配器并补充 fixture；不能用危险配置绕过。',
      unknowns: ['需要脱敏的响应状态、content-type 和失败字段路径来判断是上游违约还是适配器缺陷。'],
    });
  }

  if (/network|fetch failed|econnreset|enotfound|连接失败|网络/.test(normalized)) {
    return report({
      classification: ['network'], confidence: 'medium', summary: '网络连接失败，未取得确定的供应商结果。',
      evidence: [evidence('network-failure-unknown-result', '运行时未取得可验证的供应商响应。', 'runtime')],
      unknowns: ['需要连接性测试结果和请求阶段来判断请求是否到达上游。'],
    });
  }

  return report({
    classification: ['unknown'], confidence: 'low', summary: safeText(message, '未知错误'), evidence: [],
    unknowns: ['需要请求预览、稳定错误代码、响应状态或复现步骤来提高置信度。'],
  });
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  values.forEach((value) => {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  });
  return Array.from(duplicates).map(safeLocationId);
}

function nodeRecord(node: CanvasNode): Record<string, unknown> {
  return node.data as Record<string, unknown>;
}

function missingMediaPaths(node: CanvasNode, nodeIndex: number): string[] {
  const data = nodeRecord(node);
  const base = `nodes[${nodeIndex}].data`;
  if (node.type === CANVAS_NODE_TYPES.upload && !(typeof data.imageUrl === 'string' && data.imageUrl.trim())) return [`${base}.imageUrl`];
  if (node.type === CANVAS_NODE_TYPES.exportImage && data.isGenerating !== true && !(typeof data.imageUrl === 'string' && data.imageUrl.trim())) return [`${base}.imageUrl`];
  if (node.type === CANVAS_NODE_TYPES.video && data.isGenerating !== true && ![data.localVideoUrl, data.videoUrl].some((value) => typeof value === 'string' && value.trim())) return [`${base}.videoUrl`];
  if (node.type === CANVAS_NODE_TYPES.audio && data.isGenerating !== true && ![data.localAudioUrl, data.audioUrl].some((value) => typeof value === 'string' && value.trim())) return [`${base}.audioUrl`];
  if (node.type === CANVAS_NODE_TYPES.storyboardSplit && Array.isArray(data.frames)) {
    return data.frames.flatMap((frame, frameIndex) => {
      const record = isPlainRecord(frame) ? frame : null;
      return record && typeof record.imageUrl === 'string' && record.imageUrl.trim() ? [] : [`${base}.frames[${frameIndex}].imageUrl`];
    });
  }
  if (node.type === CANVAS_NODE_TYPES.blueprint && Array.isArray(data.referenceImages)) {
    return data.referenceImages.flatMap((item, itemIndex) => {
      const record = isPlainRecord(item) ? item : null;
      return record && typeof record.url === 'string' && record.url.trim() ? [] : [`${base}.referenceImages[${itemIndex}].url`];
    });
  }
  return [];
}

function invalidNodeParameterPaths(node: CanvasNode, nodeIndex: number): string[] {
  const data = nodeRecord(node);
  const paths: string[] = [];
  const base = `nodes[${nodeIndex}]`;
  if (!Number.isFinite(node.position?.x)) paths.push(`${base}.position.x`);
  if (!Number.isFinite(node.position?.y)) paths.push(`${base}.position.y`);
  if (data.aspectRatio !== undefined && (typeof data.aspectRatio !== 'string' || !VALID_ASPECT_RATIO.test(data.aspectRatio.trim()))) paths.push(`${base}.data.aspectRatio`);
  for (const field of ['width', 'height', 'generationDurationMs', 'generationElapsedMs']) {
    const value = data[field];
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) paths.push(`${base}.data.${field}`);
  }
  if (data.generationStartedAt !== undefined && data.generationStartedAt !== null
    && (typeof data.generationStartedAt !== 'number' || !Number.isFinite(data.generationStartedAt) || data.generationStartedAt < 0)) paths.push(`${base}.data.generationStartedAt`);
  if (data.isGenerating !== undefined && typeof data.isGenerating !== 'boolean') paths.push(`${base}.data.isGenerating`);
  if (data.extraParams !== undefined && !isPlainRecord(data.extraParams)) paths.push(`${base}.data.extraParams`);
  if (node.type === CANVAS_NODE_TYPES.storyboardSplit || node.type === CANVAS_NODE_TYPES.storyboardGen) {
    for (const field of ['gridRows', 'gridCols']) {
      const value = data[field];
      if (!Number.isInteger(value) || Number(value) <= 0) paths.push(`${base}.data.${field}`);
    }
    if (!Array.isArray(data.frames)) paths.push(`${base}.data.frames`);
  }
  return paths;
}

function nestedDuplicateIdPaths(node: CanvasNode, nodeIndex: number): string[] {
  const data = nodeRecord(node);
  const result: string[] = [];
  for (const field of ['frames', 'items', 'referenceImages', 'directorStudioProjects']) {
    const collection = data[field];
    if (!Array.isArray(collection)) continue;
    const ids = collection.map((item) => isPlainRecord(item) && typeof item.id === 'string' ? item.id : '').filter(Boolean);
    if (duplicateValues(ids).length > 0) result.push(`nodes[${nodeIndex}].data.${field}`);
  }
  return result;
}

function healthEvidence(nodes: CanvasNode[], edges: CanvasEdge[], options: CanvasHealthOptions): DiagnosisEvidence[] {
  const now = options.now ?? Date.now();
  const stalledAfterMs = Math.max(1, options.stalledAfterMs ?? DEFAULT_STALLED_JOB_MS);
  const scopeIds = options.nodeIds?.length ? new Set(options.nodeIds) : null;
  const scopedNodes = nodes.map((node, index) => ({ node, index })).filter(({ node }) => !scopeIds || scopeIds.has(node.id));
  const scopedIds = new Set(scopedNodes.map(({ node }) => node.id));
  const result: DiagnosisEvidence[] = [];
  const allNodeIds = new Set(nodes.map((node) => node.id));

  const duplicateNodeIds = duplicateValues(scopedNodes.map(({ node }) => node.id));
  if (duplicateNodeIds.length > 0) result.push({ ...evidence('duplicate-node-ids', `${duplicateNodeIds.length} 个节点标识重复。`, 'canvas'), nodeIds: duplicateNodeIds });
  const scopedEdges = edges.filter((edge) => !scopeIds || scopedIds.has(edge.source) || scopedIds.has(edge.target));
  const duplicateEdgeIds = duplicateValues(scopedEdges.map((edge) => edge.id));
  if (duplicateEdgeIds.length > 0) result.push({ ...evidence('duplicate-edge-ids', `${duplicateEdgeIds.length} 个连线标识重复。`, 'canvas'), edgeIds: duplicateEdgeIds });

  const dangling = scopedEdges.filter((edge) => !allNodeIds.has(edge.source) || !allNodeIds.has(edge.target));
  if (dangling.length > 0) result.push({ ...evidence('dangling-edges', `${dangling.length} 条连线引用了不存在的节点。`, 'canvas'), edgeIds: dangling.map((edge) => safeLocationId(edge.id)) });

  for (const { node, index } of scopedNodes) {
    const nodeId = safeLocationId(node.id);
    const mediaPaths = missingMediaPaths(node, index);
    if (mediaPaths.length > 0) result.push({ ...evidence('missing-media', '节点包含缺失的必需媒体引用。', 'canvas'), nodeIds: [nodeId], fieldPaths: mediaPaths });
    const invalidPaths = invalidNodeParameterPaths(node, index);
    if (invalidPaths.length > 0) result.push({ ...evidence('invalid-node-parameters', '节点参数未通过确定性校验。', 'validator'), nodeIds: [nodeId], fieldPaths: invalidPaths });
    const duplicatePaths = nestedDuplicateIdPaths(node, index);
    if (duplicatePaths.length > 0) result.push({ ...evidence('duplicate-nested-ids', '节点内部集合包含重复标识。', 'canvas'), nodeIds: [nodeId], fieldPaths: duplicatePaths });
    const data = nodeRecord(node);
    if (data.isGenerating === true && typeof data.generationStartedAt === 'number'
      && Number.isFinite(data.generationStartedAt) && now - data.generationStartedAt >= stalledAfterMs) {
      result.push({ ...evidence('stalled-generation-job', '生成任务超过停滞阈值，需使用原任务标识查询，不能自动重提。', 'runtime', 'warning'), nodeIds: [nodeId], fieldPaths: [`nodes[${index}].data.generationStartedAt`] });
    }
  }
  return result;
}

export function inspectCanvasHealth(options: CanvasHealthOptions = {}): DiagnosisReport {
  const { nodes, edges } = useCanvasStore.getState();
  const health = healthEvidence(nodes, edges, options);
  return report({
    classification: health.length > 0 ? ['input'] : [],
    confidence: 'high',
    summary: health.length > 0 ? '画布体检发现可定位的结构、媒体、参数或任务问题。' : '画布结构和运行状态体检通过。',
    evidence: health,
    unknowns: [],
  });
}

export function preflightGeneration(input: GenerationPreflightInput): DiagnosisReport {
  const selectedSize = input.width !== undefined && input.height !== undefined ? `${input.width}x${input.height}` : input.resolution;
  const geometry = resolveImageOutputGeometry({ aspectRatio: input.aspectRatio, selectedSize, limits: { maxPixels: input.maxPixels ?? 8_294_400, alignment: 8 }, defaultTier: '2k' });
  const items: DiagnosisEvidence[] = [];
  if (!geometry.ok) items.push({ ...evidence('pixel-limit', geometry.error, 'validator'), nodeIds: input.nodeIds?.map(safeLocationId) });
  else if (geometry.diagnostic.status === 'adjusted') {
    items.push({ ...evidence('pixel-limit-adjusted', `通用几何求解器已把请求解析为 ${geometry.size}（${geometry.diagnostic.pixels ?? '未知'} 像素），确保不超过 ${geometry.diagnostic.limits.maxPixels ?? '声明的'} 像素限制。`, 'validator', 'warning'), nodeIds: input.nodeIds?.map(safeLocationId) });
  }
  if (input.accessState === 'missing') items.push(evidence('auth-missing', '供应商访问凭据状态为 missing。', 'validator'));
  if (input.endpointValid === false) items.push(evidence('endpoint-invalid', '供应商 endpoint 未通过路由校验。', 'validator'));
  if (input.requiresVision && input.supportsVision !== true) items.push(evidence('capability-vision-unsupported', '请求需要视觉输入，但所选模型 capability 声明 vision=false。', 'validator'));
  if (input.requiresTools && input.supportsTools !== true) items.push(evidence('capability-tools-unsupported', '请求需要工具调用，但所选模型 capability 声明 tools=false。', 'validator'));

  const { nodes, edges } = useCanvasStore.getState();
  const knownIds = new Set(nodes.map((node) => node.id));
  const missingNodes = (input.nodeIds ?? []).filter((id) => !knownIds.has(id)).map(safeLocationId);
  if (missingNodes.length > 0) items.push({ ...evidence('missing-node', '选中的节点已不存在。', 'canvas'), nodeIds: missingNodes });
  items.push(...healthEvidence(nodes, edges, input).filter((item) => item.code !== 'stalled-generation-job'));

  const blocking = items.some((item) => item.severity === 'blocking');
  const configurationIssue = items.some((item) => /^(?:auth|endpoint|capability|pixel-limit)/.test(item.code));
  return report({
    classification: items.length === 0 ? [] : configurationIssue ? ['input', 'configuration'] : ['input'],
    confidence: 'high',
    summary: blocking ? '提交前预检发现阻断项，未发起付费请求。' : items.length > 0 ? '提交前预检通过，但存在非阻断警告。' : '提交前预检通过。',
    evidence: items,
    userWorkaround: items.some((item) => item.code === 'pixel-limit') ? '选择较低分辨率或调整宽高。' : undefined,
    unknowns: [],
  });
}

export function inspectRedactedProviderConfig(): unknown[] {
  return useCustomProvidersStore.getState().providers.map((provider) => sanitizeDiagnosticValue({
    id: provider.id,
    label: provider.label,
    mediaType: provider.mediaType ?? 'image',
    baseUrl: provider.baseUrl,
    endpointPath: provider.endpointPath,
    modelIds: provider.models,
    apiStyle: provider.apiStyle,
    accessState: provider.apiKey.trim() ? 'configured' : 'missing',
    modelCapabilities: Object.entries(provider.modelMetadata ?? {}).map(([modelId, metadata]) => ({ modelId, ...metadata })),
  }));
}

export function inspectRedactedApplicationConfig(): unknown {
  const settings = useSettingsStore.getState();
  const apiKeyStates = Object.fromEntries(
    Object.entries(settings.apiKeys)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([providerId, apiKey]) => [providerId, apiKey.trim() ? 'configured' : 'missing'])
  );
  const dreamina = settings.dreaminaStatus;

  return sanitizeDiagnosticValue({
    access: {
      providers: apiKeyStates,
      agnes: settings.agnesApiKey.trim() ? 'configured' : 'missing',
    },
    dreamina: dreamina ? {
      installed: dreamina.installed,
      loginState: dreamina.loginState,
      credits: dreamina.credits,
      networkDegraded: dreamina.networkDegraded,
      version: dreamina.version,
      commit: dreamina.commit,
      buildTime: dreamina.buildTime,
      vipLevel: dreamina.vipLevel,
      sessionsAvailable: dreamina.sessionsAvailable,
      accountErrorState: dreamina.accountError ? 'present' : 'none',
      sessionErrorState: dreamina.sessionError ? 'present' : 'none',
    } : null,
    generation: {
      storyboardKeepStyleConsistent: settings.storyboardGenKeepStyleConsistent,
      storyboardDisableTextInImage: settings.storyboardGenDisableTextInImage,
      storyboardAutoInferEmptyFrame: settings.storyboardGenAutoInferEmptyFrame,
      appendParameterConstraintsToPrompt: settings.appendParameterConstraintsToPrompt,
      showNodePayloadPreview: settings.showNodePayloadPreview,
      aiTextStreaming: settings.enableAiTextStreaming,
      storyboardGridPreviewShortcut: settings.enableStoryboardGenGridPreviewShortcut,
      storyboardAdvancedRatioControls: settings.showStoryboardGenAdvancedRatioControls,
      networkRoute: settings.generationNetworkSettings.route,
      customProxyState: settings.generationNetworkSettings.customProxyUrl ? 'configured' : 'missing',
    },
    canvas: {
      collapseNodeActionToolbarByDefault: settings.collapseNodeActionToolbarByDefault,
      panoramaControlSensitivity: settings.panoramaControlSensitivity,
      useLegacyPanoramaControlDirection: settings.useLegacyPanoramaControlDirection,
      mouseBindingPreset: settings.canvasMouseBindingPreset,
      mouseBindings: settings.canvasMouseBindings,
      wasdPanEnabled: settings.enableCanvasWasdPan,
      wasdPanSensitivity: settings.canvasWasdPanSensitivity,
      edgeRoutingMode: settings.canvasEdgeRoutingMode,
      radiusPreset: settings.uiRadiusPreset,
      themeTonePreset: settings.themeTonePreset,
      accentColor: settings.accentColor,
    },
    prompts: {
      defaultLanguage: settings.promptDefaultLanguage,
      templateOverrideIds: Object.keys(settings.promptTemplateOverrides).sort(),
      presetCount: settings.promptPresets.length,
      legacyTextAgentCount: settings.textAgents.length,
      multiAngleTemplateState: settings.multiAnglePromptTemplate.trim() ? 'configured' : 'missing',
      lightingTemplateState: settings.lightingPromptTemplate.trim() ? 'configured' : 'missing',
    },
    audio: {
      defaultOutputMode: settings.audioGenerationSettings.defaultOutputMode,
      defaultTimeoutMs: settings.audioGenerationSettings.defaultTimeoutMs,
      voiceCount: settings.audioGenerationSettings.voices.length,
      selectedVoiceState: settings.audioGenerationSettings.selectedVoiceId ? 'configured' : 'missing',
      models: settings.audioGenerationSettings.models.map((model) => ({
        id: model.id,
        name: model.name,
        providerKind: model.providerKind,
        outputMode: model.outputMode,
        timeoutMs: model.timeoutMs,
        enabled: model.enabled,
        defaultVoiceState: model.defaultVoiceId ? 'configured' : 'missing',
      })),
    },
    imageHosting: {
      enabled: settings.imageHostSettings.enabled,
      provider: settings.imageHostSettings.provider,
    },
    panelModels: Object.entries(settings.lastModelConfigByPanel ?? {}).flatMap(([panel, config]) => config ? [{
      panel,
      entryId: config.entryId,
      ratio: config.ratio,
      hasExtraParams: Boolean(config.extraParams && Object.keys(config.extraParams).length > 0),
    }] : []),
  });
}

export function inspectDiagnosticConfigSnapshot(): unknown {
  return sanitizeDiagnosticValue({
    providers: inspectRedactedProviderConfig(),
    application: inspectRedactedApplicationConfig(),
  });
}

function diffSafeValues(before: unknown, after: unknown, path = '$', depth = 0): DiagnosticConfigDiff[] {
  if (depth > 5) return [];
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const result: DiagnosticConfigDiff[] = [];
    const length = Math.min(Math.max(before.length, after.length), MAX_SAFE_COLLECTION_ITEMS);
    for (let index = 0; index < length; index += 1) result.push(...diffSafeValues(before[index], after[index], `${path}[${index}]`, depth + 1));
    return result;
  }
  if (isPlainRecord(before) && isPlainRecord(after)) {
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).filter((key) => !SENSITIVE_FIELD.test(key)).slice(0, MAX_SAFE_COLLECTION_ITEMS);
    return keys.flatMap((key) => diffSafeValues(before[key], after[key], `${path}.${key}`, depth + 1));
  }
  return [{ path, before, after }];
}

function normalizeEvents(events: readonly unknown[] | undefined): SafeDiagnosticEvent[] {
  return (events ?? []).slice(-50).flatMap((value) => {
    if (!isPlainRecord(value)) return [];
    const source = value.source === 'validator' || value.source === 'provider' || value.source === 'runtime' || value.source === 'canvas' ? value.source : 'runtime';
    const message = safeText(value.message, 'Diagnostic event');
    const nodeIds = Array.isArray(value.nodeIds) ? value.nodeIds.filter((id): id is string => typeof id === 'string').map(safeLocationId).slice(0, 50) : undefined;
    return [{
      source,
      message,
      timestamp: typeof value.timestamp === 'number' && Number.isFinite(value.timestamp) ? value.timestamp : undefined,
      code: typeof value.code === 'string' ? safeText(value.code) : undefined,
      status: typeof value.status === 'string' ? safeText(value.status) : undefined,
      nodeIds,
    }];
  });
}

export function attachDiagnosticEvidence(baseReport: DiagnosisReport, input: DiagnosticEvidenceInput = {}): DiagnosisReport {
  const current = sanitizeDiagnosticValue(input.currentConfig ?? inspectDiagnosticConfigSnapshot());
  const previous = input.lastKnownGoodConfig === undefined ? undefined : sanitizeDiagnosticValue(input.lastKnownGoodConfig);
  return {
    ...baseReport,
    eventTimeline: normalizeEvents(input.events),
    configSnapshotDiff: previous === undefined ? [] : diffSafeValues(previous, current).slice(0, 100),
  };
}

function issueDraftFor(reportValue: DiagnosisReport, reproductionSteps: string[]): DiagnosticBundlePreview['issueDraft'] {
  const primaryCode = reportValue.evidence[0]?.code ?? 'unknown-diagnostic';
  const evidenceLines = reportValue.evidence.length > 0
    ? reportValue.evidence.map((item) => `- ${item.code}: ${item.message}`).join('\n')
    : '- No deterministic evidence captured.';
  const stepLines = reproductionSteps.length > 0
    ? reproductionSteps.map((step, index) => `${index + 1}. ${step}`).join('\n')
    : '1. Reproduction steps not provided.';
  return {
    title: `[Diagnostic] ${primaryCode}`,
    body: `## Summary\n${reportValue.summary}\n\n## Classification\n${reportValue.classification.join(', ') || 'none'} (${reportValue.confidence})\n\n## Evidence\n${evidenceLines}\n\n## Reproduction\n${stepLines}\n\n## Safety\nThis is a local redacted draft. It has not been published.`,
  };
}

export function buildDiagnosticBundlePreview(input: {
  report?: DiagnosisReport;
  error?: unknown;
  evidence?: DiagnosticEvidenceInput;
  runtimeSnapshot?: unknown;
  reproductionSteps?: string[];
  now?: number;
} = {}): DiagnosticBundlePreview {
  const health = inspectCanvasHealth({ now: input.now });
  const currentConfig = sanitizeDiagnosticValue(input.evidence?.currentConfig ?? inspectDiagnosticConfigSnapshot());
  const lastKnownGood = input.evidence?.lastKnownGoodConfig === undefined ? undefined : sanitizeDiagnosticValue(input.evidence.lastKnownGoodConfig);
  const configDiff = lastKnownGood === undefined ? [] : diffSafeValues(lastKnownGood, currentConfig).slice(0, 100);
  const baseReport = input.report ?? (input.error === undefined ? health : classifyAgentError(input.error));
  const reportWithEvidence = {
    ...baseReport,
    eventTimeline: normalizeEvents(input.evidence?.events),
    configSnapshotDiff: configDiff,
  };
  const reproductionSteps = (input.reproductionSteps ?? []).map((step) => safeText(step)).filter(Boolean).slice(0, 20);
  const unsigned = {
    version: 1 as const,
    createdAt: input.now ?? Date.now(),
    publication: 'draft-only' as const,
    report: reportWithEvidence,
    canvasHealth: health,
    runtimeSnapshot: input.runtimeSnapshot === undefined ? undefined : sanitizeDiagnosticValue(input.runtimeSnapshot),
    configSnapshot: { current: currentConfig, lastKnownGood, diff: configDiff },
    reproductionSteps,
    issueDraft: issueDraftFor(reportWithEvidence, reproductionSteps),
  };
  const safe = sanitizeDiagnosticValue(unsigned) as Omit<DiagnosticBundlePreview, 'security'>;
  const findings = scanForSensitiveOutput(safe);
  if (findings.length > 0) {
    return {
      version: 1,
      createdAt: unsigned.createdAt,
      publication: 'draft-only',
      report: reportWithEvidence,
      canvasHealth: health,
      configSnapshot: { current: [], diff: [] },
      reproductionSteps: [],
      issueDraft: { title: '[Diagnostic] redaction-blocked', body: 'The local draft was withheld because the safety scan found unsafe content. It has not been published.' },
      security: { passed: false, findings: ['unsafe-content-withheld'] },
    };
  }
  return { ...safe, security: { passed: true, findings: [] } };
}

export function extractSafeDiagnosticBundlePreview(value: unknown): DiagnosticBundlePreview | null {
  if (!isPlainRecord(value)
    || value.version !== 1
    || value.publication !== 'draft-only'
    || typeof value.createdAt !== 'number'
    || !Number.isFinite(value.createdAt)
    || !isPlainRecord(value.report)
    || !isPlainRecord(value.canvasHealth)
    || !isPlainRecord(value.configSnapshot)
    || !Array.isArray(value.reproductionSteps)
    || !isPlainRecord(value.issueDraft)
    || typeof value.issueDraft.title !== 'string'
    || typeof value.issueDraft.body !== 'string'
    || !isPlainRecord(value.security)
    || value.security.passed !== true
    || !Array.isArray(value.security.findings)
    || value.security.findings.length > 0) {
    return null;
  }

  const candidate = sanitizeDiagnosticValue({
    version: value.version,
    createdAt: value.createdAt,
    publication: value.publication,
    report: value.report,
    canvasHealth: value.canvasHealth,
    runtimeSnapshot: value.runtimeSnapshot,
    configSnapshot: value.configSnapshot,
    reproductionSteps: value.reproductionSteps,
    issueDraft: value.issueDraft,
    security: value.security,
  });
  if (scanForSensitiveOutput(candidate).length > 0) return null;
  return candidate as DiagnosticBundlePreview;
}

export function serializeSafeDiagnosticBundlePreview(value: unknown): string | null {
  const bundle = extractSafeDiagnosticBundlePreview(value);
  return bundle ? `${JSON.stringify(bundle, null, 2)}\n` : null;
}

export function formatDiagnosticIssueDraft(value: unknown): string | null {
  const bundle = extractSafeDiagnosticBundlePreview(value);
  return bundle ? `${bundle.issueDraft.title}\n\n${bundle.issueDraft.body}` : null;
}

export function diagnosticBundleFileName(value: unknown): string | null {
  const bundle = extractSafeDiagnosticBundlePreview(value);
  if (!bundle) return null;
  const timestamp = new Date(bundle.createdAt).toISOString().replace(/[:.]/g, '-');
  return `storyboard-diagnostic-${timestamp}.json`;
}

export function buildSafeGenerationPreview(payload: Parameters<typeof buildGenerateImageDebugPreview>[0]): unknown {
  return sanitizeDiagnosticValue(buildGenerateImageDebugPreview(payload));
}
