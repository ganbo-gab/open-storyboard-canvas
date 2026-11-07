import { useState } from 'react';
import { Bookmark, ImagePlus, Search, Settings2, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiInput, UiModal, UiSegmented } from '@/components/ui';
import { AssetMedia } from '@/features/assets/ui/AssetMedia';
import { openSettingsDialog } from '@/features/settings/settingsEvents';
import type { ComposerReference } from './useNodeReferences';
import type { ComposerPromptOption } from './useSourceCommands';

export function ComposerPromptPicker({ options, initialGroup, initialSearch = '', images, onApply, onEditImage, onClose }: {
  options: readonly ComposerPromptOption[];
  initialGroup: 'preset' | 'image';
  initialSearch?: string;
  images: readonly ComposerReference[];
  onApply(option: ComposerPromptOption, replace: boolean, reference?: ComposerReference): void;
  onEditImage(reference: ComposerReference): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [group, setGroup] = useState<ComposerPromptOption['group']>(initialGroup);
  const [search, setSearch] = useState(initialSearch);
  const [writeMode, setWriteMode] = useState<'append' | 'replace'>('append');
  const [referenceToken, setReferenceToken] = useState(images.length === 1 ? images[0].token : '');
  const reference = images.find(image => image.token === referenceToken);
  const choices = options.filter(option => option.group === group && `${option.label} ${option.hint ?? ''} ${option.prompt}`.toLowerCase().includes(search.toLowerCase()));
  const tabs = [
    { value: 'preset' as const, label: t('ui.canvas.promptPresets'), icon: <Bookmark size={14} /> },
    { value: 'favorite' as const, label: t('ui.canvas.favoritePrompts'), icon: <Star size={14} /> },
    ...(options.some(option => option.group === 'image') ? [{ value: 'image' as const, label: t('ui.canvas.imageFunctions'), icon: <ImagePlus size={14} /> }] : []),
  ];
  return <UiModal isOpen title={t('ui.canvas.promptChoices')} description={t('ui.canvas.promptChoicesHint')} onClose={onClose}
    widthClassName="w-[min(700px,calc(100vw-48px))]" footer={<UiButton variant="ghost" icon={<Settings2 size={14} />} onClick={() => { onClose(); openSettingsDialog({ category: group === 'image' ? 'promptManagement' : 'promptPresets' }); }}>{t('ui.canvas.managePrompts')}</UiButton>}>
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <UiSegmented value={group} options={tabs} onChange={setGroup} aria-label={t('ui.canvas.promptCategory')} />
        <UiSegmented value={writeMode} options={[{ value: 'append', label: t('ui.canvas.appendPrompt') }, { value: 'replace', label: t('ui.canvas.replacePrompt') }]} onChange={setWriteMode} aria-label={t('ui.canvas.promptWriteMode')} />
      </div>
      {group === 'image' && <div className="rounded-xl border border-line p-3">
        <p className="mb-2 text-xs text-text-muted">{t(images.length > 1 ? 'ui.canvas.chooseReferenceImage' : 'ui.canvas.referenceImage')}</p>
        <div className="flex flex-wrap items-center gap-2">{images.map(image => <button key={image.token} type="button" className="flex max-w-48 items-center gap-2 rounded-lg border border-line p-1.5 text-xs aria-pressed:border-accent aria-pressed:bg-accent/10" aria-pressed={referenceToken === image.token} aria-label={image.label} onClick={() => setReferenceToken(image.token)}>
          {image.displayUrl && <AssetMedia source={image.displayUrl} kind="image" className="h-9 w-9 rounded object-cover" />}<span className="truncate">{image.label} · {image.title}</span>
        </button>)}{reference && <UiButton size="sm" variant="ghost" onClick={() => { onClose(); onEditImage(reference); }}>{t('ui.canvas.editReferenceImage')}</UiButton>}</div>
        {!images.length && <p className="text-xs text-text-muted">{t('ui.canvas.connectImageFirst')}</p>}
      </div>}
      <label className="flex items-center gap-2"><Search size={16} className="shrink-0 text-text-muted" /><UiInput autoFocus value={search} onChange={event => setSearch(event.target.value)} aria-label={t('ui.canvas.searchPrompts')} placeholder={t('ui.canvas.searchPrompts')} /></label>
      <div className="ui-scrollbar flex max-h-[45vh] flex-col gap-2 overflow-y-auto" aria-label={t('ui.canvas.promptChoices')}>
        {choices.map(option => <button type="button" key={option.id} disabled={group === 'image' && !reference}
          className="rounded-xl border border-line p-3 text-left transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => { onApply(option, writeMode === 'replace', group === 'image' ? reference : undefined); onClose(); }}>
          <span className="block text-sm font-medium">{option.label}</span>
          {option.hint && <span className="mt-1 block text-xs text-text-muted">{option.hint}</span>}
          <span className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-xs leading-5 text-text-muted">{option.prompt}</span>
        </button>)}
        {!choices.length && <p className="px-3 py-8 text-center text-sm text-text-muted">{t(search ? 'rework.noMatches' : group === 'favorite' ? 'ui.canvas.noFavoritePrompts' : 'ui.canvas.noPromptPresets')}</p>}
      </div>
    </div>
  </UiModal>;
}
