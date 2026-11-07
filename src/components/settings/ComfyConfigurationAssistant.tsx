import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { UiButton, UiField, UiModal, UiSelect } from '@/components/ui';
import { useChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import { suggestComfyConfiguration, validateComfyConfigurationSuggestion, type ComfyConfigurationSuggestion } from '@/features/channels/application/comfyConfigurationAssistant';

export function ComfyConfigurationAssistant({ workflowText, onBindings, onOutputs }: { workflowText: string; onBindings(text: string): void; onOutputs(text: string): void }) {
  const models = useChatModelCatalog().filter((model) => model.usable);
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [suggestion, setSuggestion] = useState<ComfyConfigurationSuggestion | null>(null);
  const epoch = useRef(0); const active = useRef(false);
  const latestWorkflow = useRef(workflowText); latestWorkflow.current = workflowText;
  const sourceWorkflow = useRef('');
  useEffect(() => { epoch.current++; setSuggestion(null); setError(''); }, [workflowText]);
  useEffect(() => () => { epoch.current++; }, []);
  const generate = async () => {
    if (active.current || !models.some((model) => model.id === modelId)) return;
    const current = epoch.current; active.current = true; setBusy(true); setError(''); setSuggestion(null);
    try {
      const result = await suggestComfyConfiguration(modelId, JSON.parse(workflowText));
      if (epoch.current === current && latestWorkflow.current === workflowText) { sourceWorkflow.current = workflowText; setSuggestion(result); }
    } catch (cause) { if (epoch.current === current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { active.current = false; setBusy(false); }
  };
  return <><UiButton size="sm" icon={<Sparkles />} disabled={!workflowText.trim()} onClick={() => setOpen(true)}>AI 帮我配置输入与输出</UiButton>
    <UiModal isOpen={open} title="AI 辅助配置 ComfyUI" onClose={() => { if (!busy) setOpen(false); }} widthClassName="w-[640px]"
      footer={<><UiButton disabled={busy} onClick={() => setOpen(false)}>关闭</UiButton>{suggestion ? <UiButton variant="primary" onClick={() => {
        if (sourceWorkflow.current !== latestWorkflow.current) { setSuggestion(null); setError('工作流已变更，请重新分析后再应用。'); return; }
        const checked = validateComfyConfigurationSuggestion(suggestion, JSON.parse(workflowText));
        onBindings(JSON.stringify(checked.bindings, null, 2)); onOutputs(JSON.stringify(checked.outputNodeIds, null, 2)); setOpen(false);
      }}>应用到配置草稿</UiButton> : <UiButton variant="primary" disabled={busy || !modelId} onClick={() => void generate()}>{busy ? '正在分析…' : '确认并分析一次'}</UiButton>}</>}>
      <div className="space-y-4"><p className="text-sm leading-6 text-text-muted">将工作流的节点类型、输入字段和连线交给你选择的模型，帮助判断提示词、参考图和输出节点。不会发送提示词正文、文件路径或连接密钥。此次模型调用可能计费；结果先预览，再由你应用。</p>
        <UiField label="用于分析的文本模型"><UiSelect value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={busy}><option value="">选择模型…</option>{models.map((model) => <option key={model.id} value={model.id}>{model.providerLabel} · {model.modelLabel}</option>)}</UiSelect></UiField>
        {!models.length && <p className="text-xs text-warning">请先在渠道与模型中接入文本模型。</p>}
        {suggestion && <><p className="whitespace-pre-wrap text-sm leading-6">{suggestion.explanation}</p><pre className="max-h-72 overflow-auto rounded-lg bg-(--field-bg) p-3 text-xs">{JSON.stringify({ bindings: suggestion.bindings, outputNodeIds: suggestion.outputNodeIds }, null, 2)}</pre><p className="text-xs text-text-muted">应用后请检查绑定并运行依赖预检；不会自动执行工作流。</p></>}
        {error && <p role="alert" className="whitespace-pre-wrap text-xs text-danger">{error}</p>}
      </div>
    </UiModal></>;
}
