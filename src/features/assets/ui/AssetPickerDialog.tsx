import { useEffect, useMemo, useState } from 'react';
import { AudioLines, Check, Film } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiInput, UiModal, UiSelect } from '@/components/ui';
import { useProjectStore } from '@/stores/projectStore';
import { filterAssets, listAssets, type AssetRecord } from '../application/assetCatalog';
import { AssetMedia } from './AssetMedia';

type MediaKind = 'image' | 'video' | 'audio';
export type MediaAssetRecord = AssetRecord & { kind: MediaKind };
export type AssetPickerSource = 'assets' | 'canvas';
const KINDS: readonly MediaKind[] = ['image', 'video', 'audio'];
function isMedia(asset: AssetRecord): asset is MediaAssetRecord {
  return asset.kind === 'image' || asset.kind === 'video' || asset.kind === 'audio';
}

/** One asset picker for composer references and library editors; returns durable catalog records. */
export function AssetPickerDialog({ source = 'assets', accept = KINDS, remaining = {}, title, confirmLabel, onPick, onClose }: {
  source?: AssetPickerSource;
  accept?: readonly MediaKind[];
  remaining?: Partial<Record<MediaKind, number>>;
  title?: string;
  confirmLabel?: string;
  onPick(assets: MediaAssetRecord[]): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const projects = useProjectStore(state => state.projects);
  const [assets, setAssets] = useState<MediaAssetRecord[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MediaKind | ''>('');
  const [project, setProject] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    void listAssets().then(
      items => { if (active) setAssets(items.filter(isMedia)); },
      (cause: unknown) => { if (active) { setAssets([]); setError(cause instanceof Error ? cause.message : String(cause)); } },
    );
    return () => { active = false; };
  }, []);
  const visible = useMemo(() => filterAssets((assets ?? []).filter(asset => accept.includes(asset.kind)
    && (source === 'assets' || (asset.nodeId && asset.projectId && (!project || asset.projectId === project)))),
  { kind: kind || undefined, text: query }).filter(isMedia), [accept, assets, kind, project, query, source]);
  const byId = useMemo(() => new Map((assets ?? []).map(asset => [asset.id, asset])), [assets]);
  const canvasProjects = projects.filter(entry => assets?.some(asset => asset.nodeId && asset.projectId === entry.id));
  const countOf = (target: MediaKind) => selected.filter(id => byId.get(id)?.kind === target).length;
  const toggle = (asset: MediaAssetRecord) => {
    if (selected.includes(asset.id)) { setSelected(selected.filter(id => id !== asset.id)); return; }
    const limit = remaining[asset.kind];
    if (limit !== undefined && countOf(asset.kind) >= limit) return;
    setSelected([...selected, asset.id]);
  };
  return <UiModal isOpen title={title ?? t(source === 'assets' ? 'rework.refPicker.assetsTitle' : 'rework.refPicker.canvasTitle')}
    onClose={onClose} widthClassName="w-[min(760px,calc(100vw-1.5rem))]"
    footer={<>
      <span className="mr-auto text-xs text-text-muted">{t('rework.refPicker.selected', { count: selected.length })}</span>
      <UiButton variant="ghost" onClick={onClose}>{t('common.cancel')}</UiButton>
      <UiButton variant="primary" disabled={!selected.length} onClick={() => {
        onPick(selected.flatMap(id => { const asset = byId.get(id); return asset ? [asset] : []; }));
        onClose();
      }}>{confirmLabel ?? t('rework.refPicker.add')}</UiButton>
    </>}>
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <UiInput aria-label={t('rework.assetSearch')} placeholder={t('rework.assetSearch')} value={query}
          onChange={event => setQuery(event.target.value)} className="h-8 min-w-40 flex-1 text-xs" />
        {accept.length > 1 && <div role="radiogroup" aria-label={t('rework.refPicker.kind')} className="flex gap-1">
          {(['', ...accept] as const).map(entry => <button key={entry || 'all'} type="button" role="radio"
            aria-checked={kind === entry} data-active={kind === entry || undefined} className="ui-chip" onClick={() => setKind(entry)}>
            {entry ? t(`rework.${entry}`) : t('rework.refPicker.allKinds')}
          </button>)}
        </div>}
        {source === 'canvas' && <UiSelect aria-label={t('rework.refPicker.project')} value={project}
          onChange={event => setProject(event.target.value)} className="h-8 w-auto max-w-56 text-xs">
          <option value="">{t('rework.refPicker.allProjects')}</option>
          {canvasProjects.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </UiSelect>}
      </div>
      {Object.values(remaining).some(value => value !== undefined) && <p className="text-[11px] text-text-subtle">
        {accept.filter(entry => remaining[entry] !== undefined).map(entry => t('rework.refPicker.remaining', {
          kind: t(`rework.${entry}`), count: Math.max(0, (remaining[entry] ?? 0) - countOf(entry)),
        })).join(' · ')}
      </p>}
      <div className="ui-scrollbar grid max-h-[52vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4 md:grid-cols-5" aria-busy={assets === null}>
        {visible.map(asset => {
          const chosen = selected.includes(asset.id);
          const limit = remaining[asset.kind];
          return <button key={asset.id} type="button" aria-pressed={chosen}
            disabled={!chosen && limit !== undefined && countOf(asset.kind) >= limit} title={asset.name} onClick={() => toggle(asset)}
            className="group relative overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--field-bg)] text-left transition-colors aria-pressed:border-[var(--accent)] disabled:opacity-40">
            <span className="flex aspect-square items-center justify-center overflow-hidden">
              {asset.kind === 'image' ? <AssetMedia source={asset.previewUrl || asset.source} kind="image" alt={asset.name} className="h-full w-full object-cover" />
                : asset.kind === 'video' ? <Film className="h-6 w-6 text-text-muted" /> : <AudioLines className="h-6 w-6 text-text-muted" />}
            </span>
            <span className="block truncate px-1.5 py-1 text-[10.5px] text-text-muted">{asset.name}</span>
            {chosen && <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-[rgb(var(--accent-rgb))] text-white"><Check className="h-3 w-3" /></span>}
          </button>;
        })}
      </div>
      {assets !== null && !visible.length && <p className="py-6 text-center text-xs text-text-muted">{t(source === 'canvas' ? 'rework.refPicker.emptyCanvas' : 'rework.noMatches')}</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  </UiModal>;
}
