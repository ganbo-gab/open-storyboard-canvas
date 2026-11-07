import { openUrl } from '@tauri-apps/plugin-opener';
import { isTauri } from '@tauri-apps/api/core';
import { applyModelCapabilityPreset, findModelCapabilityPreset } from '@/features/channels/application/modelCapabilityPresets';
import { UiButton, UiField, UiInput, UiSelect } from '@/components/ui';
import type { ModelSpec } from '@/features/channels/domain/profile';

export function ModelCapabilitiesFields({ model, onChange }: { model: ModelSpec; onChange(model: ModelSpec): void }) {
  const preset = findModelCapabilityPreset(model.id);
  const caps = model.capabilities ?? {};
  const patch = (next: ModelSpec['capabilities']) => onChange({ ...model, capabilities: { ...caps, ...next } });
  return <section className="space-y-3 rounded-lg border border-line p-3">
    <h4 className="text-sm font-medium">文本模型能力</h4>
    <p className="text-xs leading-5 text-text-muted">预设来自官方资料，渠道可能有不同限制，可逐项修改。未声明的能力保持未知。</p>
    {preset && <div className="flex flex-wrap items-center gap-2 rounded-md bg-(--field-bg) p-2 text-xs"><span className="flex-1">{preset.label} · 核对于 {preset.reviewedAt}</span><UiButton size="sm" variant="ghost" onClick={() => onChange(applyModelCapabilityPreset(model))}>补全未填写项</UiButton><a href={preset.source} target="_blank" rel="noreferrer" className="text-accent" onClick={event => { if (isTauri()) { event.preventDefault(); void openUrl(preset.source); } }}>官方依据</a></div>}
    <div className="grid grid-cols-2 gap-3">
      <UiField label="上下文窗口（token）"><UiInput type="number" min={1} step={1} placeholder="未声明" value={caps.contextWindow ?? ''} onChange={(event) => patch({ contextWindow: event.target.value ? Math.max(1, Math.floor(Number(event.target.value))) : undefined })} /></UiField>
      <UiField label="最大输出（token）"><UiInput type="number" min={1} step={1} placeholder="未声明" value={caps.maxOutputTokens ?? ''} onChange={(event) => patch({ maxOutputTokens: event.target.value ? Math.max(1, Math.floor(Number(event.target.value))) : undefined })} /></UiField>
    </div>
    {([{ key: 'supportsMultimodal', label: '可理解图片（多模态）' }, { key: 'supportsTools', label: '支持工具调用（Agent）' }, { key: 'supportsStreaming', label: '支持流式输出' }] as const).map(({ key, label }) => <div key={key} className="flex items-center justify-between gap-3 text-xs"><span>{label}</span><div className="w-32"><UiSelect aria-label={label} value={caps[key] === undefined ? 'unknown' : String(caps[key])} onChange={event => patch({ [key]: event.target.value === 'unknown' ? undefined : event.target.value === 'true' })}><option value="unknown">未声明</option><option value="true">支持</option><option value="false">不支持</option></UiSelect></div></div>)}
  </section>;
}
