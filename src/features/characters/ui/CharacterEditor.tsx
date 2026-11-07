import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ImagePlus, ImageOff, Star, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiField, UiIconButton, UiInput, UiModal, UiSelect, UiTextArea } from '@/components/ui';
import { AssetPickerDialog, type MediaAssetRecord } from '@/features/assets/ui/AssetPickerDialog';
import { AssetMedia } from '@/features/assets/ui/AssetMedia';
import { resolveAsset, type AssetRecord } from '@/features/assets/application/assetCatalog';
import { characterVoiceCapability, type Character, type CharacterVoice } from '../domain/types';
import { useCharacterLibraryStore } from '../store/characterLibraryStore';

/** Character records own catalog ids, not display URLs. Resolve before rendering any media. */
export function CharacterMedia({ assetId, kind = 'image', className = '' }: {
  assetId?: string; kind?: 'image' | 'audio'; className?: string;
}) {
  const { t } = useTranslation();
  const [resolved, setResolved] = useState<{ id: string; asset: AssetRecord | null; error?: string } | null>(null);
  useEffect(() => {
    if (!assetId) return;
    let active = true;
    void resolveAsset(assetId).then(
      asset => { if (active) setResolved({ id: assetId, asset }); },
      (cause: unknown) => { if (active) setResolved({ id: assetId, asset: null, error: cause instanceof Error ? cause.message : String(cause) }); },
    );
    return () => { active = false; };
  }, [assetId]);
  if (!assetId) return <span className={`flex items-center justify-center bg-[var(--hover)] text-text-subtle ${className}`}><ImageOff className="h-6 w-6" aria-label={t('characters.noImage')} /></span>;
  if (resolved?.id !== assetId) return <span className={`block animate-pulse bg-[var(--hover)] ${className}`} aria-label={t('common.loading')} />;
  if (!resolved.asset) return <span role="alert" className={`flex items-center justify-center bg-[var(--hover)] p-2 text-xs text-danger ${className}`} title={resolved.error}>{t('characters.errors.assetNotFound')}</span>;
  return <AssetMedia kind={kind} source={kind === 'image' ? resolved.asset.previewUrl || resolved.asset.source : resolved.asset.source}
    alt={resolved.asset.name} controls={kind === 'audio'} className={className} draggable={false} />;
}

export function CharacterEditor({ characterId, onClose }: { characterId: string; onClose(): void }) {
  const { t } = useTranslation();
  const character = useCharacterLibraryStore(state => state.characters.find(item => item.id === characterId));
  const pending = useCharacterLibraryStore(state => state.pendingCount > 0);
  const error = useCharacterLibraryStore(state => state.error);
  if (!character) return null;
  return <CharacterEditorForm key={characterId} character={character} pending={pending} error={error ? t(error.messageKey, { defaultValue: error.message }) : ''} onClose={onClose} />;
}

function CharacterEditorForm({ character, pending, error, onClose }: {
  character: Character; pending: boolean; error: string; onClose(): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(character.name);
  const [description, setDescription] = useState(character.description ?? '');
  const [tags, setTags] = useState(character.tags.join(', '));
  const [voiceKind, setVoiceKind] = useState<CharacterVoice['kind']>(character.voice?.kind ?? 'none');
  const [sampleId, setSampleId] = useState(character.voice?.kind === 'sample' ? character.voice.sampleAssetId : '');
  const [providerId, setProviderId] = useState(character.voice?.kind === 'provider' ? character.voice.providerId : '');
  const [voiceId, setVoiceId] = useState(character.voice?.kind === 'provider' ? character.voice.voiceId : '');
  const [picker, setPicker] = useState<'image' | 'audio' | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = pending || saving;
  const invalid = !name.trim() || (voiceKind === 'sample' && !sampleId) || (voiceKind === 'provider' && (!providerId.trim() || !voiceId.trim()));
  const save = async () => {
    if (busy || invalid) return;
    setSaving(true);
    try {
      const voice: CharacterVoice = voiceKind === 'sample' ? { kind: 'sample', sampleAssetId: sampleId }
        : voiceKind === 'provider' ? { kind: 'provider', providerId: providerId.trim(), voiceId: voiceId.trim() } : { kind: 'none' };
      const store = useCharacterLibraryStore.getState();
      if (!await store.updateCharacter(character.id, { name, description: description || null, voice })) return;
      if (!await store.setTags(character.id, tags.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean))) return;
      onClose();
    } finally { setSaving(false); }
  };
  const pick = async (assets: MediaAssetRecord[]) => {
    if (picker === 'audio') { setSampleId(assets[0]?.id ?? ''); return; }
    for (const asset of assets) {
      if (!await useCharacterLibraryStore.getState().addImage(character.id, asset.id)) break;
    }
  };
  const moveImage = (assetId: string, offset: number) => {
    const ids = character.images.map(image => image.assetId);
    const index = ids.indexOf(assetId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void useCharacterLibraryStore.getState().reorderImages(character.id, ids);
  };
  return <>
    <UiModal isOpen title={t('characters.editTitle')} onClose={() => { if (!busy) onClose(); }} widthClassName="w-[min(780px,calc(100vw-1.5rem))]"
      footer={<><UiButton variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</UiButton><UiButton variant="primary" disabled={invalid || pending} loading={saving} onClick={() => void save()}>{t('common.save')}</UiButton></>}>
      <div className="space-y-5" aria-busy={busy}>
        <UiField label={t('characters.name')}><UiInput autoFocus value={name} maxLength={200} onChange={event => setName(event.target.value)} /></UiField>
        <UiField label={t('characters.description')}><UiTextArea value={description} rows={3} onChange={event => setDescription(event.target.value)} /></UiField>
        <section className="space-y-2" aria-label={t('characters.images')}>
          <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium text-text-dark">{t('characters.images')}</h3><UiButton size="sm" disabled={busy} icon={<ImagePlus />} onClick={() => setPicker('image')}>{t('characters.addImages')}</UiButton></div>
          <p className="text-xs leading-5 text-text-muted">{t('characters.imagesHint')}</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {character.images.map((image, index) => <div key={image.assetId} className="overflow-hidden rounded-[var(--r-md)] border border-[var(--line)]">
              <CharacterMedia assetId={image.assetId} className="aspect-square w-full object-cover" />
              <div className="flex items-center justify-between gap-0.5 p-1">
                <UiIconButton aria-label={t('characters.setMain')} title={t('characters.setMain')} active={character.mainImage?.assetId === image.assetId} disabled={busy} onClick={() => void useCharacterLibraryStore.getState().setMainImage(character.id, image.assetId)}><Star className="h-3.5 w-3.5" /></UiIconButton>
                <UiIconButton aria-label={t('characters.moveEarlier')} disabled={busy || index === 0} onClick={() => moveImage(image.assetId, -1)}><ArrowUp className="h-3.5 w-3.5" /></UiIconButton>
                <UiIconButton aria-label={t('characters.moveLater')} disabled={busy || index === character.images.length - 1} onClick={() => moveImage(image.assetId, 1)}><ArrowDown className="h-3.5 w-3.5" /></UiIconButton>
                <UiIconButton aria-label={t('characters.removeImage')} disabled={busy} onClick={() => void useCharacterLibraryStore.getState().removeImage(character.id, image.assetId)}><Trash2 className="h-3.5 w-3.5" /></UiIconButton>
              </div>
            </div>)}
          </div>
        </section>
        <UiField label={t('characters.tags')}><UiInput value={tags} placeholder={t('characters.tagsHint')} onChange={event => setTags(event.target.value)} /></UiField>
        <div className="space-y-3 rounded-[var(--r-md)] border border-[var(--line)] p-3">
          <UiField label={t('characters.voice')}><UiSelect value={voiceKind} onChange={event => {
            const value = event.target.value;
            if (value === 'none' || value === 'sample' || value === 'provider') setVoiceKind(value);
          }}><option value="none">{t('characters.voiceNone')}</option><option value="sample">{t('characters.voiceSample')}</option><option value="provider">{t('characters.voiceProvider')}</option></UiSelect></UiField>
          {voiceKind === 'sample' && <div className="space-y-2"><UiButton size="sm" onClick={() => setPicker('audio')}>{t('characters.chooseSample')}</UiButton>{sampleId && <CharacterMedia assetId={sampleId} kind="audio" className="w-full" />}</div>}
          {voiceKind === 'provider' && <div className="grid gap-3 sm:grid-cols-2"><UiField label={t('characters.providerId')}><UiInput value={providerId} onChange={event => setProviderId(event.target.value)} /></UiField><UiField label={t('characters.voiceId')}><UiInput value={voiceId} onChange={event => setVoiceId(event.target.value)} /></UiField></div>}
          {!characterVoiceCapability.voiceCloneAvailable && <p className="text-xs leading-5 text-text-muted">{t(characterVoiceCapability.reasonKey)}</p>}
        </div>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </div>
    </UiModal>
    {picker && <AssetPickerDialog title={t(picker === 'audio' ? 'characters.chooseSample' : 'characters.addImages')} confirmLabel={t('common.confirm')} accept={[picker]} remaining={picker === 'audio' ? { audio: 1 } : {}} onPick={assets => void pick(assets)} onClose={() => setPicker(null)} />}
  </>;
}
