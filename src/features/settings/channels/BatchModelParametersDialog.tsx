import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiField, UiModal, UiSelect } from '@/components/ui';
import { RATIO_PARAM_KEYS, SIZE_PARAM_KEYS, type ChannelProfileV2, type ParamSpec } from '@/features/channels/domain/profile';
import { applyBatchModelParameters, listBatchModelParameterContexts, previewBatchModelParameters } from '@/features/channels/application/batchModelParameters';

interface Props {
  profile: ChannelProfileV2;
  initialModelId?: string;
  onApply(profile: ChannelProfileV2): void;
  onClose(): void;
}
const contextId = (context: { modelId: string; modeId: string }) => JSON.stringify([context.modelId, context.modeId]);
const contextLabel = (context: { modelId: string; modelLabel: string; modeLabel: string }) => `${context.modelLabel || context.modelId} · ${context.modeLabel}`;
const defaultKeys = (params: ParamSpec[]) => params.filter(param => SIZE_PARAM_KEYS.includes(param.key) || RATIO_PARAM_KEYS.includes(param.key)).map(param => param.key);

/** A reviewed copy into the current draft. No save, credential access or generation is performed here. */
export function BatchModelParametersDialog({ profile, initialModelId, onApply, onClose }: Props) {
  const { t } = useTranslation();
  const contexts = listBatchModelParameterContexts(profile);
  const initialSource = contexts.find(context => context.modelId === initialModelId) ?? contexts[0];
  const [sourceId, setSourceId] = useState(initialSource ? contextId(initialSource) : '');
  const source = contexts.find(context => contextId(context) === sourceId);
  const [keys, setKeys] = useState(() => defaultKeys(initialSource?.params ?? []));
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [copyDefaults, setCopyDefaults] = useState(false);
  const [search, setSearch] = useState('');
  const [reviewedProfile, setReviewedProfile] = useState<ChannelProfileV2 | null>(null);
  const [error, setError] = useState('');
  const targets = contexts.filter(context => contextId(context) !== sourceId);
  const selection = {
    source: { modelId: source?.modelId ?? '', modeId: source?.modeId ?? '' },
    targets: targets.map(target => ({ modelId: target.modelId, modeId: target.modeId })),
    selectedKeys: keys, copyDefaults,
  };
  const previews = source ? previewBatchModelParameters(profile, selection) : [];
  const selected = previews.filter(preview => preview.compatible && targetIds.includes(contextId(preview.target)));
  const canReview = keys.length > 0 && selected.length > 0 && selected.every(preview => preview.compatible);
  const stale = reviewedProfile !== null && reviewedProfile !== profile;
  const isReview = reviewedProfile !== null;
  const describe = (param: ParamSpec | undefined) => {
    if (!param) return t('ui.channels.batch.notDeclared');
    const options = param.options?.map(option => option.size ? `${option.size.ratio} + ${option.size.resolution}` : option.label).join('、');
    const value = param.default === undefined ? t('ui.channels.batch.unset') : JSON.stringify(param.default);
    const bounds = param.type === 'number' ? ` · ${param.min ?? '…'}–${param.max ?? '…'}${param.step === undefined ? '' : ` / ${param.step}`}` : '';
    return `${param.label} · ${param.type}${bounds}${options ? ` · ${options}` : ''} · ${t('ui.channels.batch.defaultValue', { value })}${param.sizeDisplay ? ` · ${t(`ui.channels.sizeGuide.${param.sizeDisplay}`)}` : ''}`;
  };
  const apply = () => {
    if (!canReview || stale) return;
    try {
      const next = applyBatchModelParameters(profile, { ...selection, targets: selected.map(preview => preview.target) });
      onApply(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.channels.batch.failed')); }
  };
  return <UiModal isOpen title={t('ui.channels.batch.title')} onClose={onClose} widthClassName="w-[760px]"
    footer={<><UiButton variant="ghost" onClick={onClose}>{t('common.cancel')}</UiButton>
      {isReview ? <><UiButton onClick={() => { setReviewedProfile(null); setError(''); }}>{t('ui.channels.batch.back')}</UiButton>
        <UiButton variant="primary" disabled={!canReview || stale} onClick={apply}>{t('ui.channels.batch.apply', { count: selected.length })}</UiButton></>
        : <UiButton variant="primary" disabled={!canReview} onClick={() => setReviewedProfile(profile)}>{t('ui.channels.batch.review', { count: selected.length })}</UiButton>}</>}>
    <div className="space-y-5">
      <p className="text-xs leading-6 text-text-muted">{t('ui.channels.batch.hint')}</p>
      {!isReview ? <>
        <UiField label={t('ui.channels.batch.source')}><UiSelect aria-label={t('ui.channels.batch.source')} value={sourceId} onChange={event => {
          setSourceId(event.target.value); setTargetIds([]); setError('');
          setKeys(defaultKeys(contexts.find(context => contextId(context) === event.target.value)?.params ?? []));
        }}>{contexts.map(context => <option key={contextId(context)} value={contextId(context)}>{contextLabel(context)} · {context.operation}</option>)}</UiSelect></UiField>
        {source && <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{t('ui.channels.batch.parameters')}</legend>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-2">{source.params.map(param => <label key={param.key} className="flex min-w-0 cursor-pointer items-center gap-3 rounded-lg border border-line bg-surface p-3 text-xs">
            <input type="checkbox" className="h-4 w-4 shrink-0 accent-accent" aria-label={`${t('ui.channels.batch.parameter')} ${param.label}`} checked={keys.includes(param.key)} onChange={event => setKeys(event.target.checked ? [...keys, param.key] : keys.filter(key => key !== param.key))} />
            <span className="min-w-0"><span className="block break-words font-medium">{param.label}</span><code className="mt-1 block break-all text-text-subtle">{param.key}</code></span>
          </label>)}</div>
          {!source.params.length && <p className="text-xs text-text-muted">{t('ui.channels.batch.noParameters')}</p>}
        </fieldset>}
        <label className="flex cursor-pointer items-start gap-3 text-xs leading-5"><input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-accent" checked={copyDefaults} onChange={event => setCopyDefaults(event.target.checked)} />
          <span>{t('ui.channels.batch.copyDefaults')}<small className="block text-text-muted">{t('ui.channels.batch.defaultHint')}</small></span></label>
        <fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">{t('ui.channels.batch.targets')}</legend>
          <div className="flex flex-wrap items-center gap-2"><input type="search" className="ui-input min-w-0 flex-1 basis-48" value={search} aria-label={t('ui.channels.batch.search')} placeholder={t('ui.channels.batch.search')} onChange={event => setSearch(event.target.value)} />
            <UiButton size="sm" disabled={!keys.length} onClick={() => setTargetIds(previews.filter(preview => preview.compatible).map(preview => contextId(preview.target)))}>{t('ui.channels.batch.selectCompatible')}</UiButton>
            <UiButton size="sm" variant="ghost" onClick={() => setTargetIds([])}>{t('ui.channels.batch.clear')}</UiButton></div>
          <div className="ui-scrollbar max-h-64 space-y-2 overflow-y-auto">{previews.map(preview => {
            const target = targets.find(context => contextId(context) === contextId(preview.target));
            if (!target || !`${target.modelId} ${target.modelLabel} ${target.modeLabel}`.toLowerCase().includes(search.toLowerCase())) return null;
            return <label key={contextId(target)} className="flex items-start gap-3 rounded-lg border border-line p-3 text-xs">
              <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-accent" aria-label={`${t('ui.channels.batch.target')} ${contextLabel(target)}`} disabled={!preview.compatible || !keys.length} checked={preview.compatible && targetIds.includes(contextId(target))} onChange={event => setTargetIds(event.target.checked ? [...targetIds, contextId(target)] : targetIds.filter(id => id !== contextId(target)))} />
              <span className="min-w-0 flex-1"><strong className="block break-words font-medium">{contextLabel(target)}</strong><code className="mt-1 block break-all text-text-subtle">{target.modelId} · {target.operation}</code>
                {!preview.compatible && <span className="mt-1 block leading-5 text-text-muted">{preview.reasons.join('；')}</span>}
              </span>
            </label>;
          })}</div>
          {!targets.length && <p className="text-xs text-text-muted">{t('ui.channels.batch.noTargets')}</p>}
        </fieldset>
      </> : <>
        <p className="rounded-lg border border-line bg-surface p-3 text-sm">{t('ui.channels.batch.reviewSummary', { source: source ? contextLabel(source) : '', count: selected.length, params: keys.length })}</p>
        <p className="text-xs leading-5 text-text-muted">{t('ui.channels.batch.supportHint')}</p>
        {selected.map(preview => {
          const target = targets.find(context => contextId(context) === contextId(preview.target));
          return <section key={contextId(preview.target)} className="rounded-lg border border-line p-3">
            <h4 className="break-words text-sm font-medium">{target ? contextLabel(target) : preview.target.modelId}</h4>
            <p className="mt-1 text-xs text-text-muted">{t('ui.channels.batch.preserved', { count: preview.preservedExtraCount })}</p>
            <div className="mt-3 space-y-3">{preview.changes.map(change => <details key={change.key} className="rounded-md bg-surface p-2 text-xs">
              <summary className="cursor-pointer break-words">{change.after.label} <code className="ml-2 text-text-muted">{change.key}</code></summary>
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 leading-5"><dt>{t('ui.channels.batch.before')}</dt><dd className="break-words">{describe(change.before)}</dd><dt>{t('ui.channels.batch.after')}</dt><dd className="break-words">{describe(change.after)}</dd></dl>
            </details>)}</div>
          </section>;
        })}
      </>}
      {stale && <p role="alert" className="text-xs text-warning">{t('ui.channels.batch.stale')}</p>}
      {error && <p role="alert" className="text-xs text-warning">{error}</p>}
    </div>
  </UiModal>;
}
