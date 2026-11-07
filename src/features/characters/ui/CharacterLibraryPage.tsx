import { useMemo, useRef, useState } from 'react';
import { ImagePlus, Plus, Search, SendToBack, Trash2, Upload, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiChipButton, UiConfirm, UiInput } from '@/components/ui';
import { AssetPickerDialog } from '@/features/assets/ui/AssetPickerDialog';
import { saveAsset } from '@/features/assets/application/assetCatalog';
import { readReferenceFile } from '@/features/workbench/application/readReferenceFile';
import { ProjectLibraryDialog } from '@/features/library/ui/ProjectLibraryDialog';
import { writeStudioMediaDrag } from '@/features/studio/mediaDrag';
import { filterCharacters } from '../application/characterLibrary';
import type { Character } from '../domain/types';
import { useCharacterLibraryStore } from '../store/characterLibraryStore';
import { useCharacters } from '../store/useCharacters';
import { CharacterEditor, CharacterMedia } from './CharacterEditor';

/** Shared by the studio page and canvas library dialog; character edits never mutate source assets. */
export function CharacterLibraryPage({ onApply, compact = false }: {
  onApply?(character: Character): Promise<void>;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const characters = useCharacters();
  const initialized = useCharacterLibraryStore(state => state.initialized);
  const pending = useCharacterLibraryStore(state => state.pendingCount > 0);
  const storeError = useCharacterLibraryStore(state => state.error);
  const storageStatus = useCharacterLibraryStore(state => state.storageStatus);
  const issues = useCharacterLibraryStore(state => state.issues);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Character | null>(null);
  const [sending, setSending] = useState<Character | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const tags = useMemo(() => [...new Set(characters.flatMap(character => character.tags))].sort(), [characters]);
  const filtered = useMemo(() => filterCharacters(characters, { search: query, tags: tag ? [tag] : [] }), [characters, query, tag]);
  const createFromAsset = async (assetId: string) => {
    const character = await useCharacterLibraryStore.getState().createFromAsset(assetId);
    if (character) setEditing(character.id);
  };
  const uploadImage = async (file: File) => {
    setBusy(true); setError('');
    try {
      const reference = await readReferenceFile(file);
      if (reference.kind !== 'image') throw new Error(t('characters.errors.imageRequired'));
      const asset = await saveAsset({ kind: 'image', name: file.name.replace(/\.[^.]+$/, ''), source: reference.source, origin: 'uploaded', metadata: {} });
      await createFromAsset(asset.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const apply = async (character: Character) => {
    if (!character.mainImage) return;
    if (!onApply) { setSending(character); return; }
    setBusy(true); setError(''); setNotice('');
    try { await onApply(character); setNotice(t('characters.applied', { name: character.name })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className={compact ? 'ui-scrollbar h-full overflow-y-auto p-1' : 'studio-page ui-scrollbar h-full overflow-y-auto px-6 py-8 sm:px-10'}>
    <div className="mx-auto max-w-[1180px] space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className={compact ? 'text-lg font-semibold text-text-dark' : 'text-2xl font-semibold tracking-tight text-text-dark'}>{t('characters.title')}</h1><p className="mt-1.5 max-w-xl text-xs leading-5 text-text-muted">{t('characters.subtitle')}</p></div>
        <div className="flex flex-wrap gap-2"><UiButton icon={<Upload />} loading={busy} disabled={pending || !initialized} onClick={() => upload.current?.click()}>{t('characters.upload')}</UiButton><UiButton variant="primary" icon={<Plus />} disabled={pending || busy || !initialized} onClick={() => setCreating(true)}>{t('characters.create')}</UiButton></div>
      </header>
      <input ref={upload} type="file" accept="image/*" className="hidden" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadImage(file); }} />
      {storageStatus.mode === 'memory' && <p role="alert" className="rounded-[var(--r-md)] border border-warning/30 bg-warning/5 p-3 text-xs text-warning">{t('characters.storageWarning', { reason: storageStatus.reason })}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-48 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-subtle" /><UiInput aria-label={t('characters.search')} placeholder={t('characters.search')} value={query} onChange={event => setQuery(event.target.value)} className="w-full rounded-full pl-9" /></label>
        <div className="flex max-w-full flex-wrap gap-1.5" role="radiogroup" aria-label={t('characters.tags')}><UiChipButton role="radio" aria-checked={!tag} active={!tag} onClick={() => setTag('')}>{t('characters.all')}</UiChipButton>{tags.map(entry => <UiChipButton key={entry} role="radio" aria-checked={tag === entry} active={tag === entry} onClick={() => setTag(entry)}>{entry}</UiChipButton>)}</div>
      </div>
      {(error || storeError) && <p role="alert" className="text-xs leading-5 text-danger">{error || (storeError ? t(storeError.messageKey, { defaultValue: storeError.message }) : '')}</p>}
      {notice && <p role="status" className="text-xs text-success">{notice}</p>}
      {issues.length > 0 && <details className="rounded-[var(--r-md)] border border-[var(--line)] p-3 text-xs text-text-muted"><summary className="cursor-pointer">{t('characters.migrationIssues', { count: issues.length })}</summary><ul className="mt-2 list-inside list-disc space-y-1">{issues.map((issue, index) => <li key={`${issue.characterId ?? issue.index}:${issue.field}:${index}`}>{issue.characterId ?? issue.index} · {issue.field}: {issue.reason}</li>)}</ul></details>}
      {!initialized ? <div aria-label={t('common.loading')} className="grid grid-cols-2 gap-3 sm:grid-cols-3">{[0, 1, 2].map(index => <div key={index} className="studio-skeleton aspect-square" />)}</div>
        : !filtered.length ? <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center"><span className="studio-tool__icon"><Users className="h-6 w-6" /></span><p className="text-sm text-text-muted">{t(query || tag ? 'characters.noMatches' : 'characters.empty')}</p><p className="max-w-md text-xs leading-5 text-text-subtle">{t('characters.emptyHint')}</p>{!query && !tag && <UiButton icon={<ImagePlus />} onClick={() => setCreating(true)}>{t('characters.create')}</UiButton>}</div>
          : <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">{filtered.map(character => <article key={character.id} className="studio-card-host" draggable={Boolean(character.mainImage)} onDragStart={event => { if (character.mainImage) writeStudioMediaDrag(event.dataTransfer, { kind: 'asset', assetIds: [character.mainImage.assetId] }); }}>
            <button type="button" className="studio-card w-full text-left" onClick={() => { useCharacterLibraryStore.getState().clearError(); setEditing(character.id); }}>
              <span className="studio-card__media block aspect-[4/3]"><CharacterMedia assetId={character.mainImage?.assetId} className="h-full w-full object-cover" /></span>
              <span className="block px-3 pb-1 pt-2.5 text-sm font-medium text-text-dark">{character.name}</span>
              <span className="block truncate px-3 pb-3 text-[11px] text-text-muted">{character.tags.length ? character.tags.join(' · ') : t('characters.imageCount', { count: character.images.length })}</span>
            </button>
            <div className="mt-1.5 flex items-center justify-between gap-2"><UiButton size="sm" variant="ghost" icon={<SendToBack />} disabled={busy || !character.mainImage} onClick={() => void apply(character)}>{t('characters.apply')}</UiButton><UiButton size="sm" variant="ghost" aria-label={t('characters.deleteNamed', { name: character.name })} icon={<Trash2 />} disabled={pending || busy} onClick={() => setDeleting(character)} /></div>
          </article>)}</div>}
    </div>
    {creating && <AssetPickerDialog title={t('characters.createTitle')} confirmLabel={t('characters.createConfirm')} accept={['image']} remaining={{ image: 1 }} onPick={assets => { if (assets[0]) void createFromAsset(assets[0].id); }} onClose={() => setCreating(false)} />}
    {editing && <CharacterEditor characterId={editing} onClose={() => setEditing(null)} />}
    {sending && <ProjectLibraryDialog action={{ kind: 'character', character: sending }} onClose={() => setSending(null)} />}
    <UiConfirm isOpen={Boolean(deleting)} title={t('characters.deleteTitle')} description={t('characters.deleteDescription', { name: deleting?.name ?? '' })}
      tone="danger" confirmLabel={t('common.delete')} onClose={() => setDeleting(null)} onConfirm={() => { if (deleting) void useCharacterLibraryStore.getState().deleteCharacter(deleting.id); }} />
  </div>;
}
