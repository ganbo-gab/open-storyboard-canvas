import type { ModelSpec } from '../domain/profile';

type Capabilities = NonNullable<ModelSpec['capabilities']>;
export interface ModelCapabilityPreset {
  ids: readonly string[];
  label: string;
  capabilities: Capabilities;
  source: string;
  reviewedAt: string;
}
const reviewedAt = '2026-11-05';
const entry = (ids: string[], label: string, contextWindow: number, supportsMultimodal: boolean, source: string, maxOutputTokens?: number): ModelCapabilityPreset => ({
  ids, label, source, reviewedAt,
  capabilities: { contextWindow, supportsMultimodal, supportsTools: true, supportsStreaming: true, ...(maxOutputTokens ? { maxOutputTokens } : {}) },
});
/** Official model metadata only. These suggestions neither add a model nor verify a gateway's limits. */
export const modelCapabilityPresets: readonly ModelCapabilityPreset[] = [
  ...['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra'].map(id => entry([id], id, 1_050_000, true, `https://developers.openai.com/api/docs/models/${id}`, 128_000)),
  ...['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(id => entry([id], id, 1_000_000, true, 'https://platform.claude.com/docs/en/models/overview', 128_000)),
  ...['gemini-3.8-flash', 'gemini-3.5-flash-lite'].map(id => entry([id], id, 1_048_576, true, `https://ai.google.dev/gemini-api/docs/models/${id}`, 65_536)),
  entry(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'], 'DeepSeek V4.1 Flash', 1_000_000, true, 'https://api-docs.deepseek.com/quick_start/pricing', 393_216),
  entry(['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017'], 'DeepSeek V4.1 Flash', 1_000_000, true, 'https://help.aliyun.com/zh/model-studio/deepseek-v4-1-flash', 393_216),
  entry(['deepseek-v4-pro', 'deepseek-v4-pro-0813'], 'DeepSeek V4 Pro', 1_000_000, false, 'https://api-docs.deepseek.com/quick_start/pricing', 393_216),
  entry(['qwen3.8-flash'], 'Qwen 3.8 Flash', 1_000_000, true, 'https://help.aliyun.com/zh/model-studio/qwen3-8-flash', 131_072),
  entry(['qwen3.8-max'], 'Qwen 3.8 Max', 1_000_000, true, 'https://www.alibabacloud.com/help/tc/model-studio/qwen3-8-max', 131_072),
  entry(['glm-5.3'], 'GLM 5.3', 1_048_576, false, 'https://help.aliyun.com/zh/model-studio/glm-5-3', 131_072),
  entry(['MiniMax-M3.1-Flash'], 'MiniMax M3.1 Flash', 1_000_000, true, 'https://platform.minimax.io/docs/m-plan/codex'),
  entry(['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed'], 'Kimi K3.1 Pro', 1_000_000, true, 'https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart'),
  entry(['doubao-seed-2-1-pro-260915', 'doubao-seed-2-1-lite-260915'], '豆包 Seed 2.1', 1_048_576, true, 'https://www.volcengine.com/docs/ark/model-list', 262_144),
  entry(['doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628'], '豆包 Seed 2.1 · 256K', 262_144, true, 'https://www.volcengine.com/docs/ark/model-list', 262_144),
  entry(['grok-4.20-0309-reasoning', 'grok-4.20-reasoning-latest', 'grok-4.20', 'grok-4.20-reasoning', 'grok-4.20-0309'], 'Grok 4.20', 1_000_000, true, 'https://docs.x.ai/developers/models/grok-4.20-0309-reasoning'),
  entry(['grok-4.5', 'grok-4.5-latest', 'grok-build-latest'], 'Grok 4.5', 500_000, true, 'https://docs.x.ai/developers/models/grok-4.5'),
];

/** Exact IDs and documented aliases only; a similar name is not a capability contract. */
export function findModelCapabilityPreset(id: string): ModelCapabilityPreset | undefined {
  const normalized = id.trim().toLowerCase();
  return modelCapabilityPresets.find(preset => preset.ids.some(alias => alias.toLowerCase() === normalized));
}

/** Only missing metadata is filled, so manual edits and gateway-specific limits win. */
export function applyModelCapabilityPreset(model: ModelSpec): ModelSpec {
  if (!model.operations.includes('chat') && !model.modes?.some(mode => mode.operation === 'chat')) return model;
  const preset = findModelCapabilityPreset(model.id);
  if (!preset) return model;
  const existing = Object.fromEntries(Object.entries(model.capabilities ?? {}).filter(([, value]) => value !== undefined));
  return { ...model, capabilities: { ...preset.capabilities, ...existing } };
}

/** Copying a request protocol must not inherit another model's capability values. */
export function initializeModelCapabilities(model: ModelSpec): ModelSpec {
  return applyModelCapabilityPreset({ ...model, capabilities: undefined });
}
