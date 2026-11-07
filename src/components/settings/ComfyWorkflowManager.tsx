import { useRef, useState } from 'react';
import { Check, Copy, Pencil, PlugZap, Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiConfirm, UiIconButton, UiSelect } from '@/components/ui';
import { RenameDialog } from '@/features/project/RenameDialog';
import { useCustomProvidersStore, type CustomProviderConfig } from '@/stores/customProvidersStore';
import { readComfyUIWorkflows, type ComfyUIWorkflowDefinition } from '@/features/channels/application/comfyWorkflows';
import { cloneWorkflow } from '@/features/channels/adapters/comfyui/workflow';
import { inspectComfyUIConnection, type ComfyUIConnectionStats } from '@/features/channels/application/comfyConnection';
import { preflightComfyUIWorkflow } from '@/features/channels/adapters/comfyui/preflight';
import { createComfyProviderTransport } from '@/features/canvas/infrastructure/comfyProviderTransport';
import { suggestComfyUIBindings, suggestComfyUIOutputNodes } from '@/features/canvas/infrastructure/comfyuiGateway';

export function ComfyWorkflowManager({ provider, onEdit }: { provider: CustomProviderConfig; onEdit(): void }) {
  const { t } = useTranslation();
  const upload = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stats, setStats] = useState<ComfyUIConnectionStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<ComfyUIWorkflowDefinition | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [media, setMedia] = useState<'image' | 'video'>('image');
  let workflows: ComfyUIWorkflowDefinition[] = [];
  let selected: string | null = null;
  try { const collection = readComfyUIWorkflows(provider); workflows = collection.workflows; selected = collection.selectedWorkflowId; } catch { /* The connection editor remains available to repair an incomplete legacy workflow. */ }
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  const check = async () => {
    const transport = createComfyProviderTransport(provider);
    const next = await inspectComfyUIConnection(transport); setStats(next);
    const workflow = workflows.find((entry) => entry.id === selected);
    if (!next.reachable || !workflow) return;
    const info = await transport.json('/object_info', 'GET');
    const result = preflightComfyUIWorkflow(info, workflow.config.workflow);
    setNotice(result.ok ? t('ui.comfy.preflightPassed') : t('ui.comfy.missingDependencies', { nodes: result.missingNodeClasses.map((entry) => entry.classType).join(', ') || '—', models: result.missingModelFiles.map((entry) => entry.filename).join(', ') || '—' }));
  };
  return <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
    <header className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><h4 className="text-sm font-semibold">{provider.label}</h4><p className="mt-1 break-all text-xs text-text-subtle">{provider.baseUrl}</p></div><UiButton variant="secondary" size="sm" icon={<PlugZap />} disabled={busy} loading={busy} onClick={() => void run(check)}>{t('ui.comfy.check')}</UiButton><UiButton variant="ghost" size="sm" onClick={onEdit}>{t('settings.comfyui.edit')}</UiButton></header>
    {stats && <div role="status" className="rounded-lg bg-raised p-3 text-xs leading-6"><p>{stats.reachable ? t('ui.comfy.connected') : t('ui.comfy.unreachable')} · {stats.system?.version ?? t('ui.comfy.unknownVersion')}</p>{stats.queue && <p>{t('ui.comfy.queue', { running: stats.queue.running, pending: stats.queue.pending })}</p>}{stats.system?.devices?.map((device, index) => <p key={index}>{device.name ?? device.type}{device.vram_free !== undefined && device.vram_total ? ` · ${(device.vram_free / 1073741824).toFixed(1)} / ${(device.vram_total / 1073741824).toFixed(1)} GB` : ''}</p>)}{Object.values(stats.errors).map((message) => <p key={message} className="text-warning">{message}</p>)}</div>}
    <div className="divide-y divide-line">{workflows.map((workflow) => <div key={workflow.id} className="flex items-center gap-2 py-2"><button type="button" disabled={busy} onClick={() => void run(() => useCustomProvidersStore.getState().selectComfyWorkflow(provider.id, workflow.id))} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-line text-accent">{selected === workflow.id && <Check size={14} />}</span><span className="truncate">{workflow.name}</span><span className="text-xs text-text-subtle">{t(`rework.${workflow.mediaType}`)}</span></button><UiIconButton size="sm" title={t('rework.rename')} aria-label={`${workflow.name} · ${t('rework.rename')}`} onClick={() => setRenaming(workflow)}><Pencil /></UiIconButton><UiIconButton size="sm" disabled={busy} title={t('ui.comfy.duplicate')} aria-label={`${workflow.name} · ${t('ui.comfy.duplicate')}`} onClick={() => void run(async () => { await useCustomProvidersStore.getState().addComfyWorkflow(provider.id, { name: `${workflow.name} (${t('ui.comfy.copy')})`, mediaType: workflow.mediaType, config: workflow.config }); })}><Copy /></UiIconButton><UiIconButton size="sm" disabled={busy} title={t('rework.delete')} aria-label={`${workflow.name} · ${t('rework.delete')}`} onClick={() => setDeleting(workflow.id)}><Trash2 /></UiIconButton></div>)}</div>
    <div className="flex flex-wrap items-center gap-2"><UiSelect className="h-8 text-xs" value={media} aria-label={t('ui.comfy.outputType')} onChange={(event) => setMedia(event.target.value === 'video' ? 'video' : 'image')}><option value="image">{t('rework.image')}</option><option value="video">{t('rework.video')}</option></UiSelect><UiButton size="sm" variant="secondary" icon={<Upload />} disabled={busy} onClick={() => upload.current?.click()}>{t('ui.comfy.import')}</UiButton><span className="text-xs text-text-subtle">{t('ui.comfy.apiFormat')}</span></div>
    <input type="file" accept=".json,application/json" hidden ref={upload} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; void run(async () => { const workflow = cloneWorkflow(JSON.parse(await file.text())); await useCustomProvidersStore.getState().addComfyWorkflow(provider.id, { name: file.name.replace(/\.json$/i, ''), mediaType: media, config: { workflow, bindings: suggestComfyUIBindings(workflow), outputNodeIds: suggestComfyUIOutputNodes(workflow) } }); setNotice(t('ui.comfy.imported')); }); }} />
    {error && <p role="alert" className="text-xs leading-6 text-danger">{error}</p>}{notice && <p role="status" className="text-xs leading-6 text-text-muted">{notice}</p>}
    <RenameDialog isOpen={Boolean(renaming)} defaultValue={renaming?.name} title={t('rework.rename')} onClose={() => setRenaming(null)} onConfirm={(name) => { if (renaming) void run(() => useCustomProvidersStore.getState().updateComfyWorkflow(provider.id, renaming.id, { name })); }} />
    <UiConfirm isOpen={Boolean(deleting)} title={t('rework.delete')} description={t('ui.comfy.deleteHint')} confirmLabel={t('rework.delete')} onClose={() => setDeleting(null)} onConfirm={() => { if (deleting) void run(() => useCustomProvidersStore.getState().removeComfyWorkflow(provider.id, deleting)); }} />
  </section>;
}
