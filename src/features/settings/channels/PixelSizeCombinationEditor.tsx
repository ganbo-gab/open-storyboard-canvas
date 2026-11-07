import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiField, UiInput } from '@/components/ui';
import type { ParamSpec } from '@/features/channels/domain/profile';
import { pixelSizeChoices } from '@/features/channels/ui/sizeParameterPresentation';
import { buildPixelSizeCombinations, applyPixelSizeCombinations, findPixelSizeCombinationConflicts } from './pixelSizeCombinations';

const RATIOS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '9:21', '2:1', '1:2', '4:5', '5:4'];
const TIERS = ['1K', '2K', '4K'];
const unique = (values: string[]) => values.filter((value, index) => values.indexOf(value) === index);

/** Independent axes create explicit editable wire mappings; committing them is always a user action. */
export function PixelSizeCombinationEditor({ param, onChange }: { param: ParamSpec; onChange(param: ParamSpec): void }) {
  const { t } = useTranslation();
  const current = pixelSizeChoices(param);
  const [ratios, setRatios] = useState(() => unique(current.map(choice => choice.ratio)));
  const [tiers, setTiers] = useState(() => unique(current.map(choice => choice.resolution)));
  const [customRatio, setCustomRatio] = useState('');
  const [customTier, setCustomTier] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const choices = buildPixelSizeCombinations(param, ratios, tiers);
  const mapped = choices.map(choice => {
    const key = JSON.stringify([choice.ratio, choice.resolution]);
    const override = edits[key];
    return { ...choice, key, option: override === undefined ? choice.option : override.trim() ? {
      label: choice.option?.label ?? `${choice.ratio} · ${choice.resolution}`,
      value: override.trim(), size: { ratio: choice.ratio, resolution: choice.resolution },
    } : undefined };
  });
  const options = mapped.flatMap(choice => choice.option ? [choice.option] : []);
  const conflicts = findPixelSizeCombinationConflicts(options);
  const missing = options.length !== mapped.length;
  const toggle = (value: string, selected: string[], setSelected: (values: string[]) => void) => {
    setSelected(selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value]);
    setError('');
  };
  const axis = (kind: 'ratio' | 'resolution', all: string[], selected: string[], setSelected: (values: string[]) => void) => <fieldset className="min-w-0 space-y-2">
    <legend className="mb-2 text-xs font-medium">{t(`ui.channels.sizeGuide.${kind}`)}</legend>
    <div className="channel-frame-axis">{all.map(value => <label key={value} className="channel-frame-option" data-checked={selected.includes(value) || undefined}>
      <input type="checkbox" checked={selected.includes(value)} aria-label={`${t(`ui.channels.sizeGuide.${kind}`)} ${value}`} onChange={() => toggle(value, selected, setSelected)} />
      <strong>{value}</strong>
    </label>)}</div>
  </fieldset>;
  return <div className="space-y-4">
    <p className="text-xs leading-5 text-text-muted">{t('ui.channels.combinations.hint')}</p>
    {axis('resolution', unique([...TIERS, ...current.map(choice => choice.resolution), ...tiers]), tiers, setTiers)}
    {axis('ratio', unique([...RATIOS, ...current.map(choice => choice.ratio), ...ratios]), ratios, setRatios)}
    <details className="channel-frame-more"><summary>{t('ui.channels.combinations.custom')}</summary>
      <div className="channel-frame-custom mt-3">
        <UiField label={t('ui.channels.sizeGuide.resolution')}><div className="flex gap-2"><UiInput aria-label={t('ui.channels.combinations.customTier')} value={customTier} placeholder="1536px / HD" onChange={event => setCustomTier(event.target.value)} /><UiButton size="sm" disabled={!customTier.trim()} onClick={() => { setTiers(unique([...tiers, customTier.trim()])); setCustomTier(''); }}>{t('ui.channels.combinations.addTier')}</UiButton></div></UiField>
        <UiField label={t('ui.channels.sizeGuide.ratio')}><div className="flex gap-2"><UiInput aria-label={t('ui.channels.combinations.customRatio')} value={customRatio} placeholder="2.39:1" onChange={event => setCustomRatio(event.target.value)} /><UiButton size="sm" disabled={!/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(customRatio.trim())} onClick={() => { setRatios(unique([...ratios, customRatio.trim()])); setCustomRatio(''); }}>{t('ui.channels.combinations.addRatio')}</UiButton></div></UiField>
      </div>
    </details>
    <details className="channel-frame-more" open={missing || conflicts.length > 0 || undefined}><summary>{t('ui.channels.combinations.mapping', { count: mapped.length })}</summary>
      <p className="my-3 text-xs leading-5 text-text-muted">{t('ui.channels.combinations.mappingHint')}</p>
      <div className="channel-combination-mappings ui-scrollbar">{mapped.map(choice => <label key={choice.key} className="channel-combination-row">
        <span className="text-xs">{choice.ratio} · {choice.resolution}<small className="mt-1 block text-text-subtle">{t(choice.suggested ? 'ui.channels.combinations.suggested' : 'ui.channels.combinations.existing')}</small></span>
        <UiInput aria-label={`${choice.ratio} ${choice.resolution} ${t('ui.channels.frameOptions.wireValue')}`} value={choice.option ? String(choice.option.value) : ''} placeholder={t('ui.channels.combinations.enterSize')} onChange={event => { setEdits({ ...edits, [choice.key]: event.target.value }); setError(''); }} />
      </label>)}</div>
    </details>
    <p className="text-xs leading-5 text-text-muted">{t('ui.channels.combinations.reviewHint', { ratios: ratios.length, tiers: tiers.length, count: mapped.length })}</p>
    {missing && <p role="alert" className="text-xs text-warning">{t('ui.channels.combinations.missing')}</p>}
    {conflicts.length > 0 && <p role="alert" className="text-xs text-warning">{t('ui.channels.combinations.conflict')}</p>}
    {error && <p role="alert" className="text-xs text-warning">{error}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <UiButton size="sm" disabled={!mapped.length || missing || conflicts.length > 0} onClick={() => {
        try { onChange(applyPixelSizeCombinations(param, options)); setError(''); }
        catch { setError(t('ui.channels.combinations.conflict')); }
      }}>{t('ui.channels.combinations.apply', { count: mapped.length })}</UiButton>
    </div>
  </div>;
}
