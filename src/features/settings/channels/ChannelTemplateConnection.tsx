import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Download, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiCheckbox, UiField, UiInput, UiSelect, UiTextArea } from '@/components/ui';
import type { ChannelProfileV2, ModelSpec } from '@/features/channels/domain/profile';
import { channelProfileSchema } from '@/features/channels/domain/profile';
import { testChannelModels } from '@/features/channels/application/channelService';
import { suggestModelCapability } from '@/features/channels/application/modelDiscovery';
import { channelCapabilities, modelCapabilities, type ChannelCapability } from '@/features/channels/application/channelCapabilities';
import { copyModelConnection, modelConnectionHeadersCompatible } from '@/features/channels/application/modelConnection';
import { findModelCapabilityPreset, initializeModelCapabilities } from '@/features/channels/application/modelCapabilityPresets';
import { builtInPresets } from '@/features/channels/presets';

type Candidate = { id: string; selected: boolean; kind: ChannelCapability; contract: string };

export function ChannelTemplateConnection({ template, onChoose }: { template: ChannelProfileV2; onChoose(profile: ChannelProfileV2, credential: string): void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(template.name);
  const [url, setUrl] = useState('');
  const [credential, setCredential] = useState('');
  const [manual, setManual] = useState('');
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const [listPath, setListPath] = useState(template.operations['models.list']?.path ?? '/v1/models');
  const identity = JSON.stringify([url, credential, listPath]);
  const identityRef = useRef(identity); identityRef.current = identity;
  useEffect(() => { request.current++; setBusy(false); setCandidates([]); }, [identity]);
  useEffect(() => () => { request.current++; }, []);
  const contracts = useMemo(() => [template, ...builtInPresets.filter((profile) => profile.id !== template.id)]
    .filter((profile) => modelConnectionHeadersCompatible(template, profile))
    .flatMap((profile) => profile.models.map((model, index) => ({ key: `${profile.id}:${index}`, profile, model, kinds: modelCapabilities(model) }))), [template]);
  const draft = (): ChannelProfileV2 => ({ ...structuredClone(template), name: name.trim() || template.name, baseUrl: url.trim().replace(/\/+$/, ''), models: [], operations: { ...template.operations,
    'models.list': { method: 'GET', path: listPath.trim(), body: 'none', response: { mode: 'sync', outputs: [] } } } });
  const validateConnection = () => {
    channelProfileSchema.parse(draft());
    if (template.auth.type !== 'none' && !credential.trim()) throw new Error('请先填写 API Key。密钥仅保存到你的本机凭据存储。');
  };
  const addCandidates = (ids: string[]) => setCandidates((previous) => {
    const next = [...previous];
    for (const id of ids.map((item) => item.trim()).filter(Boolean)) {
      if (next.some((item) => item.id === id)) continue;
      const exact = contracts.find((item) => item.profile.id === template.id && item.model.id === id);
      const kind = exact?.kinds[0] ?? suggestModelCapability(id);
      const preferred = exact ?? contracts.find((item) => item.profile.id === template.id && item.kinds.includes(kind));
      next.push({ id, kind, contract: preferred?.key ?? '', selected: false });
    }
    return next;
  });
  const discover = async () => {
    const current = ++request.current; const connection = identityRef.current;
    setError('');
    try {
      validateConnection(); setBusy(true);
      const result = await testChannelModels(draft(), credential.trim());
      if (request.current !== current || identityRef.current !== connection) return;
      if (!result.ok) throw new Error(result.error.message);
      addCandidates(result.models);
      if (!result.models.length) setError('接口未返回模型。你可以手动填写模型 ID，或在下方检查模型列表路径。');
    } catch (cause) {
      if (request.current === current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (request.current === current) setBusy(false); }
  };
  const update = (id: string, patch: Partial<Candidate>) => setCandidates((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const selected = candidates.filter((item) => item.selected);
  const next = () => {
    setError('');
    try {
      validateConnection();
      if (!selected.length) throw new Error('先勾选要接入的模型。');
      const target = draft();
      const models: ModelSpec[] = selected.map((item) => {
        const source = contracts.find((contract) => contract.key === item.contract && contract.kinds.includes(item.kind));
        if (!source) throw new Error(`请为 ${item.id} 选择实际支持的请求接口。`);
        const model = copyModelConnection(source.profile, source.model, item.id, target);
        return initializeModelCapabilities(model);
      });
      onChoose({ ...target, models }, credential.trim());
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="space-y-6">
    <header><h3 className="text-lg font-semibold">连接 {template.name}</h3><p className="mt-2 text-sm text-text-muted">填写地址和密钥 → 选择你的模型 → 审阅参数并保存</p></header>
    <div className="grid gap-4 lg:grid-cols-2">
      <UiField label="渠道名称"><UiInput value={name} onChange={(event) => setName(event.target.value)} /></UiField>
      <UiField label="API 根地址" hint="填写服务商给你的根地址；下方路径会拼接在地址后面。"><UiInput placeholder={template.baseUrl} value={url} onChange={(event) => setUrl(event.target.value)} /></UiField>
      {template.auth.type !== 'none' && <UiField label="API Key"><UiInput type="password" autoComplete="off" placeholder="粘贴你的密钥" value={credential} onChange={(event) => setCredential(event.target.value)} /></UiField>}
    </div>
    <section className="space-y-3 rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center gap-3"><h4 className="flex-1 text-sm font-medium">读取或添加模型</h4><UiButton icon={<Download />} disabled={busy || !url.trim() || (template.auth.type !== 'none' && !credential.trim())} onClick={() => void discover()}>{busy ? '正在读取…' : '获取模型列表'}</UiButton></div>
      <p className="text-xs leading-5 text-text-muted">只读取列表，不发起生成。若渠道不支持列表接口，可直接填模型 ID，每行一个。</p>
      <div className="flex items-end gap-3"><UiTextArea aria-label="手动填写模型 ID" className="min-h-20 flex-1 font-mono text-xs" placeholder="每行一个模型 ID" value={manual} onChange={(event) => setManual(event.target.value)} /><UiButton icon={<Plus />} disabled={!manual.trim() || !url.trim()} onClick={() => { addCandidates(manual.split(/[\n,，]+/)); setManual(''); }}>加入列表</UiButton></div>
      <details className="text-xs text-text-muted"><summary className="cursor-pointer">模型列表接口设置</summary><UiField className="mt-3" label="GET 路径"><UiInput value={listPath} onChange={(event) => setListPath(event.target.value)} /></UiField></details>
    </section>
    {candidates.length > 0 && <section className="space-y-3">
      <div className="flex items-center justify-between"><h4 className="text-sm font-medium">选择接入哪些模型 · 已选 {selected.length} / {candidates.length}</h4><UiButton size="sm" variant="ghost" onClick={() => setCandidates((items) => items.map((item) => ({ ...item, selected: selected.length !== items.length })))}>{selected.length === candidates.length ? '取消全选' : '全选'}</UiButton></div>
      <p className="text-xs leading-5 text-text-muted">类别根据名称给出建议，你可以修改。识别类别不会验证接口；跨类别模型需要选择对应协议，下一步可核对请求与高级参数。</p>
      <label className="ui-input flex items-center gap-2 px-3"><Search size={15} /><input aria-label="筛选模型" className="min-w-0 flex-1 bg-transparent py-2 outline-none" placeholder="筛选模型" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="max-h-96 space-y-2 overflow-auto">{candidates.filter((item) => item.id.toLowerCase().includes(query.toLowerCase())).map((item) => <div key={item.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
        <UiCheckbox aria-label={`接入 ${item.id}`} checked={item.selected} onCheckedChange={(checked) => update(item.id, { selected: checked })} />
        <span className="min-w-36 flex-1 break-all text-sm">{item.id}{item.kind === 'chat' && findModelCapabilityPreset(item.id) && <span className="mt-1 block text-[11px] text-text-muted">已匹配能力预设 · 下一步可调整</span>}</span>
        <div className="w-28"><UiSelect aria-label={`${item.id} 模型类别`} value={item.kind} onChange={(event) => {
          const kind = channelCapabilities.find((value) => value === event.target.value); if (!kind) return;
          update(item.id, { kind, contract: contracts.find((contract) => contract.profile.id === template.id && contract.kinds.includes(kind))?.key ?? '' });
        }}>{channelCapabilities.map((kind) => <option key={kind} value={kind}>{t(`ui.channels.cap.${kind}.long`)}</option>)}</UiSelect></div>
        <div className="w-56"><UiSelect aria-label={`${item.id} 请求协议`} value={item.contract} onChange={(event) => update(item.id, { contract: event.target.value })}><option value="">选择请求协议…</option>{contracts.filter((contract) => contract.kinds.includes(item.kind)).map((contract) => <option key={contract.key} value={contract.key}>{contract.profile.name} · {contract.model.operations.join(' / ')}</option>)}</UiSelect></div>
      </div>)}</div>
    </section>}
    {error && <p role="alert" className="whitespace-pre-wrap break-words rounded-lg bg-danger/10 p-3 text-xs text-danger">{error}</p>}
    <div className="flex justify-end border-t border-line pt-4"><UiButton variant="primary" icon={<ArrowRight />} disabled={!selected.length || busy} onClick={next}>下一步：审阅模型与参数</UiButton></div>
  </div>;
}
