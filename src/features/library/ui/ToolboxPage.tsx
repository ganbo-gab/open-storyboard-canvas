import { useEffect, useMemo, useState } from 'react';
import { Boxes, Palette, Pencil, Search, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiConfirm, UiField, UiIconButton, UiInput, UiModal } from '@/components/ui';
import { useToolboxStore } from '../toolbox/toolboxStore';
import { ToolboxError, type ToolboxTemplate } from '../toolbox/toolbox';
import { ProjectLibraryDialog } from './ProjectLibraryDialog';

/** Template management is independent of the current project; the caller owns the explicit destination. */
export function ToolboxPage({ onUse, compact = false }: { onUse?(template: ToolboxTemplate): Promise<void>; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const templates = useToolboxStore(state => state.templates);
  const initialized = useToolboxStore(state => state.initialized);
  const storage = useToolboxStore(state => state.storageStatus);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ToolboxTemplate | null>(null);
  const [deleting, setDeleting] = useState<ToolboxTemplate | null>(null);
  const [sending, setSending] = useState<ToolboxTemplate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { void useToolboxStore.getState().initialize().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }, []);
  const visible = useMemo(() => templates.filter(template => template.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [query, templates]);
  const mutate = (operation: () => void) => {
    try { operation(); setError(''); }
    catch (cause) { setError(cause instanceof ToolboxError ? t(`rework.toolbox.errors.${cause.code}`) : String(cause)); }
  };
  const apply = async (template: ToolboxTemplate) => {
    if (busy) return;
    if (!onUse) { setSending(template); return; }
    setBusy(template.id); setError(''); setNotice('');
    try { await onUse(template); setNotice(t('rework.toolbox.applied', { name: template.name })); }
    catch (cause) { setError(cause instanceof ToolboxError ? t(`rework.toolbox.errors.${cause.code}`) : cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  return <div className={compact ? 'ui-scrollbar h-full overflow-y-auto p-1' : 'studio-page ui-scrollbar h-full overflow-y-auto px-6 py-8 sm:px-10'}>
    <div className="mx-auto max-w-[1180px] space-y-5"><header><h1 className={compact ? 'text-lg font-semibold text-text-dark' : 'text-2xl font-semibold tracking-tight text-text-dark'}>{t('rework.toolbox.title')}</h1><p className="mt-1.5 max-w-xl text-xs leading-5 text-text-muted">{t('rework.toolbox.subtitle')}</p></header>
      <label className="relative block max-w-md"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-subtle" /><UiInput aria-label={t('rework.toolbox.search')} placeholder={t('rework.toolbox.search')} value={query} onChange={event => setQuery(event.target.value)} className="w-full rounded-full pl-9" /></label>
      {storage.mode === 'memory' && <p role="alert" className="rounded-lg border border-warning/30 p-3 text-xs text-warning">{t('rework.toolbox.storageWarning', { reason: storage.reason })}</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}{notice && <p role="status" className="text-xs text-success">{notice}</p>}
      {!initialized ? <p role="status" className="py-10 text-center text-sm text-text-muted">{t('common.loading')}</p> : !visible.length ? <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center"><span className="studio-tool__icon"><Boxes className="h-6 w-6" /></span><p className="text-sm text-text-muted">{t(query ? 'rework.noMatches' : 'rework.toolbox.empty')}</p><p className="max-w-md text-xs leading-5 text-text-subtle">{t('rework.toolbox.emptyHint')}</p></div> : <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{visible.map(template => <article key={template.id} className="overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--field-bg)]">
        <div className="relative flex aspect-[16/8] items-center justify-center overflow-hidden bg-[var(--hover)]"><TemplatePreview template={template} /></div>
        <div className="space-y-3 p-3"><h2 className="truncate text-sm font-medium text-text-dark">{template.name}</h2><p className="text-xs text-text-muted">{t('rework.toolbox.contents', { nodes: template.nodes.length, edges: template.edges.length })}</p><p className="text-[10.5px] text-text-subtle">{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(template.createdAt)}</p><div className="flex items-center justify-between gap-2"><UiButton size="sm" variant="primary" loading={busy === template.id} disabled={Boolean(busy && busy !== template.id)} onClick={() => void apply(template)}>{t('rework.toolbox.use')}</UiButton><div className="flex gap-1"><UiIconButton aria-label={t('common.edit')} onClick={() => setEditing(template)}><Pencil className="h-4 w-4" /></UiIconButton><UiIconButton aria-label={t('common.delete')} disabled={Boolean(busy)} onClick={() => setDeleting(template)}><Trash2 className="h-4 w-4" /></UiIconButton></div></div></div>
      </article>)}</div>}
    </div>
    {editing && <TemplateEditor template={editing} onClose={() => setEditing(null)} />}
    {sending && <ProjectLibraryDialog action={{ kind: 'template', template: sending }} onClose={() => setSending(null)} />}
    <UiConfirm isOpen={Boolean(deleting)} title={t('rework.toolbox.deleteTitle')} description={t('rework.toolbox.deleteDescription', { name: deleting?.name ?? '' })} onClose={() => setDeleting(null)} onConfirm={() => { if (deleting) mutate(() => useToolboxStore.getState().remove(deleting.id)); }} />
  </div>;
}

/** Authored geometry, not a fake preview image. Coordinates stay in the template's own bounds. */
function TemplatePreview({ template }: { template: ToolboxTemplate }) {
  const width = Math.max(1, template.bounds.width), height = Math.max(1, template.bounds.height);
  const byId = new Map(template.nodes.map(node => [node.id, node]));
  const absolutePosition = (id: string): { x: number; y: number } => {
    const node = byId.get(id);
    let x = node?.position.x ?? 0, y = node?.position.y ?? 0;
    const visited = new Set<string>([id]);
    let parentId = node?.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      x += parent.position.x; y += parent.position.y; parentId = parent.parentId;
    }
    return { x: x - template.bounds.x, y: y - template.bounds.y };
  };
  return <svg aria-hidden="true" viewBox={`-20 -20 ${width + 40} ${height + 40}`} className="h-full w-full p-5 text-text-muted">
    {template.edges.map(edge => { const a = absolutePosition(edge.source), b = absolutePosition(edge.target); return <line key={edge.id} x1={a.x + 30} y1={a.y + 20} x2={b.x + 30} y2={b.y + 20} stroke="currentColor" strokeWidth={2} opacity={0.5} />; })}
    {template.nodes.map(node => { const position = absolutePosition(node.id); return <rect key={node.id} x={position.x} y={position.y} width={node.measured?.width ?? node.width ?? 120} height={node.measured?.height ?? node.height ?? 80} rx={8} fill="var(--field-bg)" stroke={template.color || 'currentColor'} strokeWidth={2} />; })}
  </svg>;
}

function TemplateEditor({ template, onClose }: { template: ToolboxTemplate; onClose(): void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(template.name);
  const [color, setColor] = useState(template.color ?? '');
  const [error, setError] = useState('');
  return <UiModal isOpen title={t('rework.toolbox.edit')} onClose={onClose} footer={<><UiButton variant="ghost" onClick={onClose}>{t('common.cancel')}</UiButton><UiButton variant="primary" disabled={!name.trim()} onClick={() => {
    try { const store = useToolboxStore.getState(); store.rename(template.id, name); store.setColor(template.id, color || undefined); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }}>{t('common.save')}</UiButton></>}>
    <div className="space-y-4"><UiField label={t('rework.toolbox.name')}><UiInput autoFocus value={name} onChange={event => setName(event.target.value)} /></UiField><UiField label={t('rework.toolbox.color')}><div className="flex items-center gap-3"><Palette className="h-4 w-4 text-text-muted" /><UiInput type="color" value={/^#[a-f\d]{6}$/i.test(color) ? color : '#808080'} onChange={event => setColor(event.target.value)} className="h-9 w-14 p-1" /><UiButton size="sm" variant="ghost" onClick={() => setColor('')}>{t('rework.toolbox.defaultColor')}</UiButton></div></UiField>{error && <p role="alert" className="text-xs text-danger">{error}</p>}</div>
  </UiModal>;
}
