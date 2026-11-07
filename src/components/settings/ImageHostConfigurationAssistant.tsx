import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { UiButton, UiField, UiModal, UiSelect, UiTextArea } from '@/components/ui';
import { useChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import type { ImageHostSettings } from '@/features/settings/imageHostSettings';
import { applyImageHostSuggestion, suggestImageHostConfiguration, type ImageHostConfigurationSuggestion } from '@/features/settings/imageHostConfigurationAssistant';

export function ImageHostConfigurationAssistant({ value, onChange }: { value: ImageHostSettings; onChange(value: ImageHostSettings): void }) {
  const models = useChatModelCatalog().filter((model) => model.usable);
  const [open, setOpen] = useState(false); const [modelId, setModelId] = useState(''); const [docs, setDocs] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [suggestion, setSuggestion] = useState<ImageHostConfigurationSuggestion | null>(null);
  const epoch = useRef(0); const active = useRef(false); const latest = useRef(value); latest.current = value;
  const baseline = useRef<ImageHostSettings | null>(null);
  useEffect(() => { epoch.current++; setSuggestion(null); setError(''); }, [value, docs, modelId]);
  useEffect(() => () => { epoch.current++; }, []);
  const analyze = async () => {
    if (active.current || !docs.trim() || !models.some((model) => model.id === modelId)) return;
    const current = epoch.current; const source = value;
    active.current = true; setBusy(true); setError(''); setSuggestion(null);
    try {
      const result = await suggestImageHostConfiguration(modelId, docs, source);
      if (epoch.current === current && latest.current === source) { baseline.current = source; setSuggestion(result); }
    } catch { if (epoch.current === current) setError('未得到可用草稿。请检查模型与文档：仅支持单次 multipart 上传和 JSON 结果链接。'); }
    finally { active.current = false; setBusy(false); }
  };
  return <><UiButton size="sm" icon={<Sparkles />} onClick={() => setOpen(true)}>AI 帮我配置图床</UiButton>
    <UiModal isOpen={open} title="AI 辅助配置图床" widthClassName="w-[640px]" onClose={() => { if (!busy) setOpen(false); }}
      footer={<><UiButton disabled={busy} onClick={() => setOpen(false)}>关闭</UiButton>{suggestion
        ? <UiButton variant="primary" onClick={() => {
          if (baseline.current !== latest.current) { setSuggestion(null); setError('配置已变更，请重新分析后再应用。'); return; }
          onChange(applyImageHostSuggestion(value, suggestion)); setOpen(false);
        }}>应用到配置草稿</UiButton>
        : <UiButton variant="primary" disabled={busy || !modelId || !docs.trim()} onClick={() => void analyze()}>{busy ? '正在分析…' : '确认并分析一次'}</UiButton>}</>}>
      <div className="space-y-4">
        <p className="text-sm leading-6 text-text-muted">粘贴公开上传文档或无密钥示例，AI 会整理上传地址、文件字段和结果路径。此次文本模型调用可能计费；结果先预览，再应用为未启用的草稿。</p>
        <UiField label="公开文档或无密钥示例"><UiTextArea aria-label="公开图床文档" rows={7} value={docs} disabled={busy} onChange={(event) => setDocs(event.target.value)} placeholder="粘贴 POST 上传接口、文件字段与 JSON 响应示例；不要粘贴密钥。" /></UiField>
        <UiField label="用于分析的文本模型"><UiSelect value={modelId} disabled={busy} onChange={(event) => setModelId(event.target.value)}><option value="">选择模型…</option>{models.map((model) => <option key={model.id} value={model.id}>{model.providerLabel} · {model.modelLabel}</option>)}</UiSelect></UiField>
        {!models.length && <p className="text-xs text-warning">请先在渠道与模型中接入文本模型。</p>}
        {suggestion && <><p className="whitespace-pre-wrap text-sm leading-6">{suggestion.explanation}</p><dl className="space-y-2 rounded-lg bg-(--field-bg) p-3 text-xs">
          <div><dt className="text-text-muted">上传地址</dt><dd className="break-all">{suggestion.uploadUrl}</dd></div>
          <div><dt className="text-text-muted">文件字段 / 结果路径</dt><dd>{suggestion.fileField} / {suggestion.responseUrlPath}</dd></div>
          <div><dt className="text-text-muted">需自行填写的请求头</dt><dd>{suggestion.headerNames.join('、') || '无'}</dd></div>
        </dl><p className="text-xs leading-5 text-text-muted">应用会保留已有请求头值，并关闭上传开关。补充凭据、检查后再启用；不会自动上传。</p></>}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </div>
    </UiModal></>;
}
