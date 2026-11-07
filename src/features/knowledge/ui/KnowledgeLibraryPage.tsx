import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { File, FileText, Folder, FolderOpen, NotebookPen, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiCheckbox, UiChipButton, UiConfirm, UiField, UiIconButton, UiInput, UiModal, UiSegmented } from '@/components/ui';
import { SidebarResizeHandle, useSidebarWidth } from '@/components/ui/SidebarResizeHandle';
import { resolveAsset } from '@/features/assets/application/assetCatalog';
import { readStudioMediaDrag } from '@/features/studio/mediaDrag';
import { useWorkbenchStore } from '@/features/workbench/store/workbenchStore';
import { useKnowledgeStore } from '../application/knowledgeStore';
import type { KnowledgeIngestInput, VaultEntry, VaultNote } from '../domain/types';
import { KnowledgeNoteEditor } from './KnowledgeNoteEditor';
import { KnowledgeOrganizeDialog } from './KnowledgeOrganizeDialog';

export function KnowledgeLibraryPage() {
  const { t } = useTranslation();
  const sidebar = useSidebarWidth('knowledge-notes', 256, 200, 480);
  const state = useKnowledgeStore();
  const [displayNote, setDisplayNote] = useState<VaultNote | null>(() => state.activeNote);
  const [dirty, setDirty] = useState(false);
  const [pane, setPane] = useState<'notes' | 'editor'>('notes');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dropping, setDropping] = useState(false);
  const [editing, setEditing] = useState<{ kind: 'new' | 'rename'; value: string; path?: string } | null>(null);
  const [deleting, setDeleting] = useState<VaultEntry | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const ready = state.status === 'ready';
  const disabled = busy || state.organizing;
  useEffect(() => {
    if (isTauri() && useKnowledgeStore.getState().status === 'unset') void useKnowledgeStore.getState().initialize().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  useEffect(() => { if (ready) return useKnowledgeStore.getState().startPolling(3000); }, [ready, state.vaultPath]);
  useEffect(() => {
    if (state.activeNote) { setDisplayNote(state.activeNote); setPane('editor'); }
    else if (!dirty) setDisplayNote(null);
  }, [state.activeNote, dirty]);
  useEffect(() => { setSelected(current => { const valid = current.filter(path => state.tree.some(entry => entry.path === path && entry.kind === 'note')); return valid.length === current.length ? current : valid; }); }, [state.tree]);
  const paths = useMemo(() => state.tree.map(entry => entry.path), [state.tree]);
  const run = async (operation: () => Promise<unknown>) => {
    if (disabled) return false;
    setBusy(true); setError(''); state.clearError();
    try { await operation(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setBusy(false); }
  };
  const open = (path: string) => { void run(() => useKnowledgeStore.getState().openNote(path)); };
  const ingest = async (input: KnowledgeIngestInput) => { await useKnowledgeStore.getState().ingest(input); };
  const addFiles = (files: File[]) => run(async () => { for (const file of files) await ingest({ kind: 'file', name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }); });
  const drop = async (event: DragEvent) => {
    setDropping(false);
    if (!ready || disabled) return;
    const files = Array.from(event.dataTransfer.files);
    const payload = readStudioMediaDrag(event.dataTransfer);
    const text = event.dataTransfer.getData('text/uri-list').split(/\r?\n/).find(line => line && !line.startsWith('#')) || event.dataTransfer.getData('text/plain');
    if (!files.length && !payload && !text.trim()) return;
    if (!files.length && !payload && event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]')) return;
    event.preventDefault();
    if (files.length) { await addFiles(files); return; }
    await run(async () => {
      if (payload) {
        const media: Array<{ kind: string; source: string; name: string; prompt?: string }> = [];
        if (payload.kind === 'asset') {
          for (const id of payload.assetIds) {
            const asset = await resolveAsset(id);
            if (!asset) throw new Error(t('rework.knowledge.assetMissing'));
            media.push({ kind: asset.kind, source: asset.source, name: asset.name, prompt: typeof asset.metadata.sourcePrompt === 'string' ? asset.metadata.sourcePrompt : undefined });
          }
        } else {
          await useWorkbenchStore.getState().initialize();
          const task = useWorkbenchStore.getState().tasks[payload.taskId];
          const result = task?.results[payload.resultIndex];
          if (!result) throw new Error(t('rework.knowledge.assetMissing'));
          media.push({ kind: result.kind, source: result.source, name: task.input.prompt.slice(0, 80), prompt: task.input.prompt });
        }
        for (const item of media) {
          if (item.kind === 'text') await ingest({ kind: 'text', text: item.source, title: item.name });
          else await ingest({ kind: 'canvas', snapshot: { kind: item.kind, title: item.name, prompt: item.prompt ?? '', params: {}, media: [{ reference: item.source, name: item.name }] } });
        }
      } else if (/^https?:\/\/\S+$/i.test(text.trim())) await ingest({ kind: 'url', url: text.trim() });
      else await ingest({ kind: 'text', text });
    });
  };
  const toggle = (path: string) => setSelected(current => current.includes(path) ? current.filter(value => value !== path) : [...current, path]);
  return <div className="studio-page flex h-full min-h-0 flex-col" data-drop-target={dropping || undefined}
    onDragOver={event => { if (ready && !disabled) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropping(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null)) setDropping(false); }} onDrop={event => void drop(event)}
    onPaste={event => { if (ready && event.clipboardData.files.length) { event.preventDefault(); void addFiles(Array.from(event.clipboardData.files)); } }}>
    <header className="shrink-0 space-y-3 border-b border-[var(--line)] px-6 pb-4 pt-6 sm:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight text-text-dark">{t('rework.knowledge.title')}</h1><p className="mt-1 max-w-2xl text-xs leading-5 text-text-muted">{t('rework.knowledge.subtitle')}</p>{state.vaultPath && <p className="mt-1 max-w-2xl truncate text-[11px] text-text-subtle" title={state.vaultPath}>{state.vaultPath}</p>}</div><div className="flex flex-wrap gap-2"><UiButton size="sm" icon={<FolderOpen />} disabled={disabled || !isTauri()} onClick={() => void run(() => state.chooseVault())}>{t(state.vaultPath ? 'rework.knowledge.changeVault' : 'rework.knowledge.chooseVault')}</UiButton><UiButton size="sm" icon={<RefreshCw />} disabled={!ready || disabled} onClick={() => void run(() => state.refresh(true))}>{t('rework.knowledge.refresh')}</UiButton></div></div>
      {ready && <div className="flex flex-wrap items-center gap-2"><UiButton size="sm" icon={<Plus />} disabled={disabled} onClick={() => { setError(''); setEditing({ kind: 'new', value: '' }); }}>{t('rework.knowledge.newNote')}</UiButton><UiButton size="sm" icon={<Upload />} disabled={disabled} onClick={() => upload.current?.click()}>{t('rework.knowledge.import')}</UiButton><UiButton size="sm" icon={<Trash2 />} disabled={disabled} onClick={() => { void run(async () => { await state.refreshTrash(); setTrashOpen(true); }); }}>{t('rework.knowledge.trash')}</UiButton><UiButton size="sm" icon={<Sparkles />} disabled={disabled || !selected.length || selected.length > 20} onClick={() => setOrganizeOpen(true)}>{t('rework.knowledge.organize', { count: selected.length })}</UiButton><p className="ml-auto text-[10.5px] text-text-subtle">{t('rework.knowledge.dropHint')}</p></div>}
      {(error || state.error) && <p role="alert" className="break-words text-xs leading-5 text-danger">{error || (state.error ? t(`rework.knowledge.errors.${state.error.code}`, { defaultValue: state.error.message }) : '')}</p>}
      {notice && <p role="status" className="text-xs text-success">{notice}</p>}
      {state.ingestProgress && state.ingestProgress.stage !== 'done' && <p role="status" className="text-xs text-text-muted">{t('rework.knowledge.importProgress', { count: state.ingestProgress.completed, total: state.ingestProgress.total })}</p>}
    </header>
    <input type="file" multiple ref={upload} className="hidden" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void addFiles(files); }} />
    {!ready ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center"><span className="studio-tool__icon"><NotebookPen className="h-7 w-7" /></span><h2 className="text-base font-medium text-text-dark">{t(state.status === 'loading' ? 'common.loading' : 'rework.knowledge.emptyTitle')}</h2><p className="max-w-lg text-xs leading-6 text-text-muted">{t(isTauri() ? 'rework.knowledge.emptyHint' : 'rework.knowledge.desktopOnly')}</p>{state.status === 'error' && <UiButton onClick={() => void run(() => state.initialize())}>{t('rework.knowledge.retry')}</UiButton>}</div> : <>
      <div className="px-4 pt-3 md:hidden"><UiSegmented value={pane} onChange={setPane} options={[{ value: 'notes', label: t('rework.knowledge.notes') }, { value: 'editor', label: t('rework.knowledge.editor') }]} /></div>
      <div className={`flex min-h-0 flex-1 ${dropping ? 'ring-2 ring-inset ring-accent' : ''}`}>
        <aside ref={sidebar.ref} className={`${pane === 'notes' ? 'flex' : 'hidden'} relative min-h-0 w-full shrink-0 flex-col border-r border-[var(--line)] md:flex md:w-64`}>
          <div className="space-y-2 border-b border-[var(--line)] p-3"><label className="relative block"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-subtle" /><UiInput value={state.searchQuery} onChange={event => state.setSearchQuery(event.target.value)} placeholder={t('rework.knowledge.search')} aria-label={t('rework.knowledge.search')} className="h-8 w-full pl-8 text-xs" /></label>{state.tags.length > 0 && <div className="ui-scrollbar flex max-h-20 flex-wrap gap-1 overflow-y-auto">{state.tags.map(tag => <UiChipButton key={tag} className="text-[10px]" onClick={() => state.setSearchQuery(`#${tag}`)}>#{tag}</UiChipButton>)}</div>}</div>
          <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-2">{state.searchQuery.trim() ? <div className="space-y-1">{state.searchResults.map(result => <div key={result.path} className="rounded-lg border border-[var(--line)] p-2"><button type="button" className="w-full text-left" onClick={() => open(result.path)}><span className="block text-xs font-medium text-text-dark">{result.title}</span><span className="mt-1 line-clamp-2 block text-[11px] leading-5 text-text-muted">{result.snippet}</span></button><label className="mt-2 flex items-center gap-2 text-[10px] text-text-subtle"><UiCheckbox checked={selected.includes(result.path)} onCheckedChange={() => toggle(result.path)} />{t('rework.knowledge.selectNote')}</label></div>)}{!state.searchResults.length && <p className="p-4 text-center text-xs text-text-muted">{t('rework.noMatches')}</p>}</div> : <KnowledgeTree entries={state.tree} selected={selected} activePath={displayNote?.path} disabled={disabled} onOpen={open} onToggle={toggle} onRename={entry => { setError(''); setEditing({ kind: 'rename', value: entry.path, path: entry.path }); }} onTrash={setDeleting} />}</div>
          <SidebarResizeHandle {...sidebar} label="知识目录宽度" />
        </aside>
        <section className={`${pane === 'editor' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col md:flex`}>
          {displayNote && state.vaultPath ? <KnowledgeNoteEditor key={`${state.vaultPath}:${displayNote.path}`} note={displayNote} vaultPath={state.vaultPath} paths={paths} missing={!state.tree.some(entry => entry.path === displayNote.path)} onOpen={open} onDirtyChange={setDirty} onError={setError} onSave={async content => {
            if (!state.tree.some(entry => entry.path === displayNote.path)) await useKnowledgeStore.getState().createNote(displayNote.path.split('/').at(-1)?.replace(/\.md$/i, '') || t('rework.knowledge.untitled'), content);
            else await useKnowledgeStore.getState().saveNote(content);
          }} /> : <div className="flex min-h-48 flex-1 items-center justify-center p-6 text-sm text-text-muted">{t('rework.knowledge.chooseNote')}</div>}
          {state.backlinks.length > 0 && <div className="max-h-36 shrink-0 overflow-y-auto border-t border-[var(--line)] px-4 py-3"><h3 className="mb-2 text-[11px] font-medium text-text-muted">{t('rework.knowledge.backlinks')}</h3><div className="flex flex-wrap gap-2">{state.backlinks.map(link => <UiButton key={link.path} size="sm" variant="ghost" onClick={() => open(link.path)}>{link.title}</UiButton>)}</div></div>}
        </section>
      </div>
    </>}
    {editing && <UiModal isOpen title={t(editing.kind === 'new' ? 'rework.knowledge.newNote' : 'rework.knowledge.rename')} onClose={() => { if (!busy) setEditing(null); }} footer={<><UiButton variant="ghost" disabled={busy} onClick={() => setEditing(null)}>{t('common.cancel')}</UiButton><UiButton variant="primary" loading={busy} disabled={!editing.value.trim()} onClick={() => { void run(async () => { if (editing.kind === 'new') await state.createNote(editing.value); else if (editing.path) await state.rename(editing.path, editing.value); setEditing(null); }); }}>{t('common.save')}</UiButton></>}><UiField label={t(editing.kind === 'new' ? 'rework.knowledge.noteTitle' : 'rework.knowledge.relativePath')}><UiInput autoFocus value={editing.value} onChange={event => setEditing({ ...editing, value: event.target.value })} /></UiField>{error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}</UiModal>}
    <UiConfirm isOpen={Boolean(deleting)} title={t('rework.knowledge.trashTitle')} description={t('rework.knowledge.trashDescription', { name: deleting?.path ?? '' })} onClose={() => setDeleting(null)} onConfirm={() => { if (deleting) void run(async () => { await state.trash(deleting.path); setNotice(t('rework.knowledge.trashed')); }); }} />
    {trashOpen && <UiModal isOpen title={t('rework.knowledge.trash')} onClose={() => setTrashOpen(false)}><div className="space-y-2">{state.trashEntries.map(entry => <div key={entry.path} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--line)] p-2"><span className="min-w-0 truncate text-xs text-text-muted" title={entry.path}>{entry.name}</span><UiButton size="sm" disabled={disabled} onClick={() => { void run(async () => { await state.restore(entry.path); setNotice(t('rework.knowledge.restored')); }); }}>{t('rework.knowledge.restore')}</UiButton></div>)}{!state.trashEntries.length && <p className="py-6 text-center text-xs text-text-muted">{t('rework.knowledge.trashEmpty')}</p>}{error && <p role="alert" className="text-xs text-danger">{error}</p>}</div></UiModal>}
    {organizeOpen && <KnowledgeOrganizeDialog paths={selected} onClose={() => setOrganizeOpen(false)} />}
  </div>;
}

function KnowledgeTree({ entries, selected, activePath, disabled, onOpen, onToggle, onRename, onTrash }: {
  entries: VaultEntry[]; selected: string[]; activePath?: string; disabled: boolean;
  onOpen(path: string): void; onToggle(path: string): void; onRename(entry: VaultEntry): void; onTrash(entry: VaultEntry): void;
}) {
  const { t } = useTranslation();
  const children = useMemo(() => {
    const map = new Map<string, VaultEntry[]>();
    for (const entry of entries) { const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''; const group = map.get(parent) ?? []; group.push(entry); map.set(parent, group); }
    for (const group of map.values()) group.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name));
    return map;
  }, [entries]);
  const branch = (parent: string, depth: number) => <ul className="space-y-0.5">{(children.get(parent) ?? []).map(entry => <li key={entry.path}>
    {entry.kind === 'folder' ? <details open={depth === 0}><summary className="group flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-1.5 text-xs text-text-muted hover:bg-[var(--hover)]"><Folder className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">{entry.name}</span><UiIconButton size="sm" aria-label={t('rework.knowledge.rename')} disabled={disabled} onClick={event => { event.preventDefault(); onRename(entry); }}><Pencil className="h-3 w-3" /></UiIconButton><UiIconButton size="sm" aria-label={t('common.delete')} disabled={disabled} onClick={event => { event.preventDefault(); onTrash(entry); }}><Trash2 className="h-3 w-3" /></UiIconButton></summary><div className="ml-3 border-l border-[var(--line)] pl-2">{branch(entry.path, depth + 1)}</div></details>
      : <div className={`group flex min-w-0 items-center gap-1 rounded-md px-1 py-1 ${activePath === entry.path ? 'bg-[var(--press)]' : 'hover:bg-[var(--hover)]'}`}>{entry.kind === 'note' ? <UiCheckbox aria-label={t('rework.knowledge.selectNamed', { name: entry.name })} checked={selected.includes(entry.path)} disabled={disabled} onCheckedChange={() => onToggle(entry.path)} /> : <File className="h-3.5 w-3.5 shrink-0 text-text-subtle" />}<button type="button" disabled={disabled || entry.kind !== 'note'} onClick={() => onOpen(entry.path)} className="min-w-0 flex-1 truncate py-1 text-left text-xs text-text-muted" title={entry.path}>{entry.kind === 'note' && <FileText className="mr-1 inline h-3 w-3" />}{entry.name}</button><UiIconButton size="sm" aria-label={t('rework.knowledge.rename')} disabled={disabled} onClick={() => onRename(entry)}><Pencil className="h-3 w-3" /></UiIconButton><UiIconButton size="sm" aria-label={t('common.delete')} disabled={disabled} onClick={() => onTrash(entry)}><Trash2 className="h-3 w-3" /></UiIconButton></div>}
  </li>)}</ul>;
  return entries.length ? branch('', 0) : <p className="p-4 text-center text-xs leading-5 text-text-muted">{t('rework.knowledge.noNotes')}</p>;
}
