import { useEffect, useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiIconButton, UiInput } from '@/components/ui';
import { listAssets, saveAsset } from '@/features/assets/application/assetCatalog';
import { AssetMedia } from '@/features/assets/ui/AssetMedia';
import { readFileAsDataUrl } from '@/features/canvas/application/imageData';

export interface StageSourceImage { id: string; source: string; name: string }

/** Uses durable library/canvas asset IDs; display blob URLs never become generation inputs. */
export function StageImagePicker({ open, value, onChange }: {
  open: boolean;
  value: StageSourceImage[];
  onChange(images: StageSourceImage[]): void;
}) {
  const { t } = useTranslation();
  const [assets, setAssets] = useState<StageSourceImage[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    if (!open) return;
    let active = true;
    void listAssets({ kind: 'image' }).then((items) => {
      if (active) setAssets(items.map(({ id, source, name }) => ({ id, source, name })));
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [open]);
  const upload = async (files: File[]) => {
    setBusy(true);
    setError('');
    try {
      const added: StageSourceImage[] = [];
      for (const file of files) {
        if (!file.type.startsWith('image/')) throw new Error(t('rework.stage.sceneBuilder.imagesOnly'));
        const asset = await saveAsset({ kind: 'image', source: await readFileAsDataUrl(file), name: file.name, origin: 'uploaded', metadata: {} });
        added.push({ id: asset.id, source: asset.source, name: asset.name });
      }
      setAssets((current) => [...added, ...current]);
      onChange([...valueRef.current, ...added]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const visible = assets.filter((image) => image.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return (
    <section className="space-y-2" aria-label={t('rework.stage.sceneBuilder.images')}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium">{t('rework.stage.sceneBuilder.images')} · {value.length}</h4>
        <UiButton size="sm" variant="ghost" loading={busy} icon={<Upload />} onClick={() => input.current?.click()}>{t('rework.stage.sceneBuilder.upload')}</UiButton>
        <input ref={input} type="file" accept="image/*" multiple hidden onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void upload(files); }} />
      </div>
      {value.length > 0 && <div className="flex flex-wrap gap-2">{value.map((image) => (
        <div key={image.id} className="relative h-16 w-20 overflow-hidden rounded-lg border border-[var(--line-strong)]" title={image.name}>
          <AssetMedia source={image.source} kind="image" alt={image.name} className="h-full w-full object-cover" />
          <UiIconButton className="absolute right-0 top-0 bg-surface/90" size="sm" aria-label={t('rework.stage.sceneBuilder.removeImage', { name: image.name })} onClick={() => onChange(value.filter((entry) => entry.id !== image.id))}><X /></UiIconButton>
        </div>
      ))}</div>}
      <details>
        <summary className="cursor-pointer text-xs text-text-muted">{t('rework.stage.sceneBuilder.chooseExisting')}</summary>
        <div className="mt-2 space-y-2">
          <UiInput aria-label={t('rework.stage.sceneBuilder.searchImages')} placeholder={t('rework.stage.sceneBuilder.searchImages')} value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="ui-scrollbar grid max-h-40 grid-cols-4 gap-1.5 overflow-y-auto">
            {visible.map((image) => {
              const selected = value.some((entry) => entry.id === image.id);
              return <button key={image.id} type="button" aria-pressed={selected} title={image.name} className="overflow-hidden rounded-lg border border-[var(--line)] text-left aria-pressed:border-[var(--accent)]" onClick={() => onChange(selected ? value.filter((entry) => entry.id !== image.id) : [...value, image])}>
                <AssetMedia source={image.source} kind="image" alt={image.name} className="h-12 w-full object-cover" />
                <span className="block truncate px-1 py-1 text-[10px]">{image.name}</span>
              </button>;
            })}
          </div>
          {!visible.length && <p className="text-xs text-text-muted">{t('rework.stage.sceneBuilder.noImages')}</p>}
        </div>
      </details>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </section>
  );
}
