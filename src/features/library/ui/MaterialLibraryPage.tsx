import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Camera, Download, ImagePlus, Palette, Pencil, Plus, RotateCcw, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiCheckbox, UiChipButton, UiConfirm, UiField, UiIconButton, UiInput, UiModal, UiSelect, UiTextArea } from '@/components/ui';
import { AssetMedia, downloadAssetSource } from '@/features/assets/ui/AssetMedia';
import { AssetPickerDialog } from '@/features/assets/ui/AssetPickerDialog';
import { PROMPT_TEMPLATE_DEFINITIONS } from '@/features/canvas/application/promptTemplates';
import { useMaterialLibraryStore } from '../materials/materialStore';
import { MaterialError, type MaterialEntry, type MaterialInput, type MaterialKind } from '../materials/materials';

const KINDS: readonly MaterialKind[] = ['style', 'effect', 'cameraMotion', 'preset'];
const ICONS = { style: Palette, effect: Sparkles, cameraMotion: Camera, preset: Pencil };

export function MaterialLibraryPage({ onUse, compact = false }: { onUse(entry: MaterialEntry): void | Promise<void>; compact?: boolean }) {
  const { t } = useTranslation();
  const entries = useMaterialLibraryStore(state => state.entries);
  const initialized = useMaterialLibraryStore(state => state.initialized);
  const storage = useMaterialLibraryStore(state => state.storageStatus);
  const [kind, setKind] = useState<MaterialKind>('style');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [using, setUsing] = useState<string | null>(null);
  const [editing, setEditing] = useState<MaterialEntry | 'new' | null>(null);
  const [deleting, setDeleting] = useState<MaterialEntry | null>(null);
  const [resetting, setResetting] = useState<MaterialEntry | 'all' | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const describeError = (cause: unknown) => cause instanceof MaterialError ? t(`rework.materialLibrary.errors.${cause.code}`) : cause instanceof Error ? cause.message : String(cause);
  useEffect(() => { void useMaterialLibraryStore.getState().initialize().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }, []);
  const nameOf = (entry: MaterialEntry) => {
    if (entry.source.type !== 'promptTemplate' || entry.name !== entry.source.id) return entry.name;
    const id = entry.source.id;
    const definition = PROMPT_TEMPLATE_DEFINITIONS.find(item => item.id === id);
    return definition ? t(definition.titleKey) : entry.name;
  };
  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return entries.filter(entry => entry.kind === kind && (!search || `${nameOf(entry)} ${entry.prompt} ${entry.tags.join(' ')}`.toLocaleLowerCase().includes(search)));
  }, [entries, kind, query, t]);
  const mutate = (operation: () => void) => {
    try { operation(); setError(''); }
    catch (cause) { setError(describeError(cause)); }
  };
  const move = (entry: MaterialEntry, offset: number) => {
    const neighbor = visible[visible.findIndex(item => item.id === entry.id) + offset];
    if (!neighbor) return;
    const ids = entries.map(item => item.id);
    const a = ids.indexOf(entry.id), b = ids.indexOf(neighbor.id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    mutate(() => useMaterialLibraryStore.getState().reorder(ids));
  };
  const apply = async (entry: MaterialEntry) => {
    if (using || !entry.enabled) return;
    setUsing(entry.id); setError(''); setNotice('');
    try { await onUse(entry); setNotice(t('rework.materialLibrary.applied', { name: nameOf(entry) })); }
    catch (cause) { setError(describeError(cause)); }
    finally { setUsing(null); }
  };
  const exportJSON = async () => {
    const url = URL.createObjectURL(new Blob([useMaterialLibraryStore.getState().exportJSON()], { type: 'application/json' }));
    try { await downloadAssetSource(url, 'storyboard-materials.json'); setNotice(t('rework.materialLibrary.exported')); }
    catch (cause) { setError(describeError(cause)); }
    finally { URL.revokeObjectURL(url); }
  };
  return <div className={compact ? 'ui-scrollbar h-full overflow-y-auto p-1' : 'studio-page ui-scrollbar h-full overflow-y-auto px-6 py-8 sm:px-10'}>
    <div className="mx-auto max-w-[1180px] space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className={compact ? 'text-lg font-semibold text-text-dark' : 'text-2xl font-semibold tracking-tight text-text-dark'}>{t('rework.materialLibrary.title')}</h1><p className="mt-1.5 max-w-xl text-xs leading-5 text-text-muted">{t('rework.materialLibrary.subtitle')}</p></div>
        <div className="flex flex-wrap gap-2"><UiButton size="sm" icon={<Upload />} disabled={!initialized} onClick={() => upload.current?.click()}>{t('rework.materialLibrary.import')}</UiButton><UiButton size="sm" icon={<Download />} disabled={!initialized} onClick={() => void exportJSON()}>{t('rework.materialLibrary.export')}</UiButton><UiButton variant="primary" icon={<Plus />} disabled={!initialized} onClick={() => setEditing('new')}>{t('rework.materialLibrary.create')}</UiButton></div></header>
      <input ref={upload} className="hidden" type="file" accept="application/json,.json" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (file) void file.text().then(json => mutate(() => { useMaterialLibraryStore.getState().importJSON(json); setNotice(t('rework.materialLibrary.imported')); }), (cause: unknown) => setError(describeError(cause)));
      }} />
      {storage.mode === 'memory' && <p role="alert" className="rounded-[var(--r-md)] border border-warning/30 p-3 text-xs text-warning">{t('rework.materialLibrary.storageWarning', { reason: storage.reason })}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3"><div role="radiogroup" aria-label={t('rework.materialLibrary.kind')} className="flex flex-wrap gap-1.5">{KINDS.map(value => { const Icon = ICONS[value]; return <UiChipButton key={value} role="radio" aria-checked={kind === value} active={kind === value} onClick={() => setKind(value)}><Icon className="h-3.5 w-3.5" />{t(`rework.materialLibrary.kinds.${value}`)}<span className="text-[11px] opacity-60">{entries.filter(entry => entry.kind === value).length}</span></UiChipButton>; })}</div>
        <label className="relative min-w-48"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-subtle" /><UiInput value={query} onChange={event => setQuery(event.target.value)} placeholder={t('rework.materialLibrary.search')} aria-label={t('rework.materialLibrary.search')} className="rounded-full pl-9" /></label></div>
      <div className="flex items-center justify-between gap-3 text-xs text-text-muted"><span>{t('rework.materialLibrary.enabledHint')}</span><UiButton variant="ghost" size="sm" icon={<RotateCcw />} disabled={!initialized} onClick={() => setResetting('all')}>{t('rework.materialLibrary.resetAll')}</UiButton></div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}{notice && <p role="status" className="text-xs text-success">{notice}</p>}
      {!initialized ? <p role="status" className="py-8 text-center text-sm text-text-muted">{t('common.loading')}</p> : !visible.length ? <p className="py-16 text-center text-sm text-text-muted">{t('rework.noMatches')}</p> : <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{visible.map((entry, index) => {
        const Icon = ICONS[entry.kind];
        return <article key={entry.id} className="overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--field-bg)]" data-disabled={!entry.enabled || undefined}>
          {entry.previewAsset ? <AssetMedia kind="image" source={entry.previewAsset} alt={nameOf(entry)} className="aspect-[16/7] w-full object-cover" /> : <div className="flex aspect-[16/7] items-center justify-center bg-[var(--hover)] text-text-subtle"><Icon className="h-8 w-8" /></div>}
          <div className="space-y-3 p-3"><div className="flex items-start justify-between gap-2"><h2 className="text-sm font-medium text-text-dark">{nameOf(entry)}</h2>{entry.builtIn && <span className="shrink-0 text-[10px] text-text-subtle">{t('rework.materialLibrary.builtIn')}</span>}</div>
            <p className="line-clamp-3 min-h-14 whitespace-pre-wrap text-xs leading-5 text-text-muted">{entry.prompt}</p>
            <div className="flex flex-wrap gap-1">{entry.tags.map(tag => <span key={tag} className="rounded-full bg-[var(--hover)] px-2 py-0.5 text-[10px] text-text-muted">{tag}</span>)}</div>
            <div className="flex flex-wrap items-center justify-between gap-2"><UiButton size="sm" variant="primary" loading={using === entry.id} disabled={!entry.enabled || Boolean(using && using !== entry.id)} onClick={() => void apply(entry)}>{t('rework.materialLibrary.use')}</UiButton><label className="flex cursor-pointer items-center gap-2 text-xs text-text-muted"><UiCheckbox aria-label={t('rework.materialLibrary.enabled')} checked={entry.enabled} onCheckedChange={enabled => mutate(() => useMaterialLibraryStore.getState().setEnabled(entry.id, enabled))} />{t('rework.materialLibrary.enabled')}</label></div>
            <div className="flex items-center gap-1 border-t border-[var(--line)] pt-2"><UiButton size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(entry)}>{t('common.edit')}</UiButton><span className="flex-1" /><UiIconButton aria-label={t('rework.materialLibrary.moveEarlier')} disabled={index === 0} onClick={() => move(entry, -1)}><ArrowUp className="h-3.5 w-3.5" /></UiIconButton><UiIconButton aria-label={t('rework.materialLibrary.moveLater')} disabled={index === visible.length - 1} onClick={() => move(entry, 1)}><ArrowDown className="h-3.5 w-3.5" /></UiIconButton>{entry.builtIn && <UiIconButton aria-label={t('rework.materialLibrary.reset')} onClick={() => setResetting(entry)}><RotateCcw className="h-3.5 w-3.5" /></UiIconButton>}<UiIconButton aria-label={t('common.delete')} onClick={() => setDeleting(entry)}><Trash2 className="h-3.5 w-3.5" /></UiIconButton></div>
          </div>
        </article>;
      })}</div>}
    </div>
    {editing && <MaterialEditor key={editing === 'new' ? 'new' : editing.id} entry={editing === 'new' ? undefined : editing} initialKind={kind} onClose={() => setEditing(null)} />}
    <UiConfirm isOpen={Boolean(deleting)} title={t('rework.materialLibrary.deleteTitle')} description={t('rework.materialLibrary.deleteDescription')} onClose={() => setDeleting(null)} onConfirm={() => { if (deleting) mutate(() => useMaterialLibraryStore.getState().remove(deleting.id)); }} />
    <UiConfirm isOpen={Boolean(resetting)} title={t('rework.materialLibrary.resetTitle')} description={t('rework.materialLibrary.resetDescription')} onClose={() => setResetting(null)} onConfirm={() => { if (resetting) mutate(() => useMaterialLibraryStore.getState().resetBuiltIn(resetting === 'all' ? undefined : resetting.id)); }} />
  </div>;
}

function MaterialEditor({ entry, initialKind, onClose }: { entry?: MaterialEntry; initialKind: MaterialKind; onClose(): void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(entry?.name ?? '');
  const [kind, setKind] = useState(entry?.kind ?? initialKind);
  const [prompt, setPrompt] = useState(entry?.prompt ?? '');
  const [tags, setTags] = useState(entry?.tags.join(', ') ?? '');
  const [preview, setPreview] = useState(entry?.previewAsset ?? '');
  const [enabled, setEnabled] = useState(entry?.enabled ?? true);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState('');
  const save = () => {
    const input: MaterialInput = { kind, name, prompt, tags: tags.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean), previewAsset: preview || undefined, enabled };
    try {
      const store = useMaterialLibraryStore.getState();
      if (entry) store.update(entry.id, input); else store.create(input);
      onClose();
    } catch (cause) { setError(cause instanceof MaterialError ? t(`rework.materialLibrary.errors.${cause.code}`) : String(cause)); }
  };
  return <><UiModal isOpen title={t(entry ? 'rework.materialLibrary.edit' : 'rework.materialLibrary.create')} onClose={onClose} widthClassName="w-[min(680px,calc(100vw-1.5rem))]" footer={<><UiButton variant="ghost" onClick={onClose}>{t('common.cancel')}</UiButton><UiButton variant="primary" disabled={!name.trim() || !prompt.trim()} onClick={save}>{t('common.save')}</UiButton></>}>
    <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><UiField label={t('rework.materialLibrary.name')}><UiInput autoFocus value={name} onChange={event => setName(event.target.value)} /></UiField><UiField label={t('rework.materialLibrary.kind')}><UiSelect value={kind} disabled={Boolean(entry)} onChange={event => { const value = event.target.value; if (value === 'style' || value === 'effect' || value === 'cameraMotion' || value === 'preset') setKind(value); }}>{KINDS.map(value => <option key={value} value={value}>{t(`rework.materialLibrary.kinds.${value}`)}</option>)}</UiSelect></UiField></div>
      <UiField label={t('rework.materialLibrary.prompt')} hint={t('rework.materialLibrary.promptHint')}><UiTextArea value={prompt} rows={7} onChange={event => setPrompt(event.target.value)} /></UiField>
      <UiField label={t('rework.materialLibrary.tags')}><UiInput value={tags} onChange={event => setTags(event.target.value)} /></UiField>
      <div className="flex items-center gap-3">{preview && <AssetMedia kind="image" source={preview} className="h-16 w-24 rounded-lg object-cover" />}<UiButton size="sm" icon={<ImagePlus />} onClick={() => setPicker(true)}>{t('rework.materialLibrary.preview')}</UiButton>{preview && <UiIconButton aria-label={t('rework.materialLibrary.removePreview')} onClick={() => setPreview('')}><X className="h-4 w-4" /></UiIconButton>}</div>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-text-muted"><UiCheckbox checked={enabled} onCheckedChange={setEnabled} />{t('rework.materialLibrary.enabled')}</label>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  </UiModal>{picker && <AssetPickerDialog title={t('rework.materialLibrary.preview')} confirmLabel={t('common.confirm')} accept={['image']} remaining={{ image: 1 }} onPick={assets => setPreview(assets[0]?.source ?? '')} onClose={() => setPicker(false)} />}</>;
}
