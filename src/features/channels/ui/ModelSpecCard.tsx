import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ModelSpec, OperationKind, ParamSpec } from '../domain/profile';
import { listModelModes } from '../application/modelModes';
import { modelCapabilities, modelKeyParams, modelReferenceLimits } from '../application/channelCapabilities';
import { CapabilityBadge } from './CapabilityBadge';
import { UNLIMITED_REFERENCES, paramDefaultText, paramValueSummary } from './modelDisplay';

const OPERATION_KEY: Record<OperationKind, string> = {
  chat: 'chat', 'image.generate': 'imageGenerate', 'image.edit': 'imageEdit', 'video.generate': 'videoGenerate',
  'audio.generate': 'audioGenerate', 'model.generate': 'modelGenerate', 'models.list': 'modelsList',
};

/**
 * One model, in plain language: what it makes, which ways it can be driven (modes), how many
 * references it accepts, and the knobs users usually touch. Full mode/param notes on demand.
 */
export function ModelSpecCard({ model, showCapabilities = false }: { model: ModelSpec; showCapabilities?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const modes = listModelModes(model);
  const explicitModes = Boolean(model.modes?.length);
  const ways = explicitModes
    ? modes.map((mode) => mode.mode.label)
    : model.operations.filter((operation) => operation !== 'models.list').map((operation) => t(`ui.channels.operation.${OPERATION_KEY[operation]}`));
  const limits = modelReferenceLimits(model);
  const refs = (['image', 'video', 'audio'] as const).flatMap((kind) => {
    const max = limits[kind];
    if (!max) return [];
    return [t(`ui.channels.model.ref.${kind}`, { count: max >= UNLIMITED_REFERENCES ? t('ui.channels.model.unlimited') : max })];
  });
  const keyParams = modelKeyParams(model);
  const capabilities = modelCapabilities(model);
  const hasDetails = model.params.length > 0 || modes.some((mode) => mode.mode.description || mode.slots.length || mode.mode.params?.length);

  return (
    <article className="rounded-[var(--r-lg)] border border-line bg-surface px-4 py-3.5">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-[14px] font-semibold leading-6 text-text">{model.label || model.id}</h4>
          <p className="truncate font-mono text-[12px] leading-5 text-text-subtle" title={model.id}>{model.id}</p>
        </div>
        {showCapabilities && <span className="flex flex-wrap gap-1">{capabilities.map((capability) => <CapabilityBadge key={capability} capability={capability} />)}</span>}
      </header>

      {ways.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5" aria-label={t('ui.channels.model.ways')}>
          {ways.map((way, index) => (
            <span key={`${way}-${index}`} className="inline-flex h-6 items-center rounded-full bg-raised px-2.5 text-[12px] text-text">{way}</span>
          ))}
        </div>
      )}

      <dl className="mt-2.5 grid gap-1 text-[12px] leading-5 sm:grid-cols-[auto_1fr] sm:gap-x-3">
        <dt className="text-text-subtle">{t('ui.channels.model.inputs')}</dt>
        <dd className="text-text-muted">{refs.length ? refs.join(' · ') : t('ui.channels.model.textOnly')}</dd>
        {keyParams.length > 0 && <>
          <dt className="text-text-subtle">{t('ui.channels.model.keyParams')}</dt>
          <dd className="text-text-muted">
            {keyParams.map((param) => {
              const range = paramValueSummary(param);
              return range ? `${param.label} ${range}` : param.label;
            }).join(' · ')}
          </dd>
        </>}
      </dl>

      {hasDetails && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen(!open)}
            className="mt-2 inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] text-[12px] font-medium text-text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-[var(--dur-1)] ${open ? 'rotate-180' : ''}`} aria-hidden />
            {t(open ? 'ui.channels.model.hideDetails' : 'ui.channels.model.showDetails')}
          </button>
          {open && (
            <div id={detailsId} className="mt-2 space-y-3 border-t border-line pt-3">
              {model.params.length > 0 && (
                <section className="space-y-1.5">
                  <h5 className="text-[13px] font-semibold text-text">{t('ui.channels.model.sharedParams')}</h5>
                  <ParamList params={model.params} />
                </section>
              )}
              {modes.map((mode) => (mode.mode.description || mode.slots.length || mode.mode.params?.length) ? (
                <section key={mode.mode.id} className="space-y-1.5">
                  {explicitModes && <h5 className="text-[13px] font-semibold text-text">{mode.mode.label}</h5>}
                  {mode.mode.description && <p className="text-[12px] leading-5 text-text-muted">{mode.mode.description}</p>}
                  {mode.slots.some((slot) => slot.max > 0) && (
                    <ul className="flex flex-wrap gap-1.5">
                      {mode.slots.filter((slot) => slot.max > 0).map((slot) => (
                        <li key={slot.key} className="rounded-[var(--r-xs)] border border-line px-2 py-0.5 text-[12px] text-text-muted">
                          {slot.label}
                          <span className="ml-1 tabular-nums text-text-subtle">
                            {slot.max >= UNLIMITED_REFERENCES
                              ? t('ui.channels.model.slotUnlimited', { min: slot.min ?? 0 })
                              : (slot.min ?? 0) === slot.max ? `${slot.max}` : `${slot.min ?? 0}–${slot.max}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!!mode.mode.params?.length && <ParamList params={mode.mode.params} />}
                </section>
              ) : null)}
            </div>
          )}
        </>
      )}
    </article>
  );
}

function ParamList({ params }: { params: readonly ParamSpec[] }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-1 text-[12px] leading-5">
      {params.map((param) => {
        const range = paramValueSummary(param);
        const fallback = paramDefaultText(param);
        return (
          <li key={param.key} className="text-text-muted">
            <span className="font-medium text-text">{param.label}</span>
            {range && <span className="ml-1.5">{range}</span>}
            {fallback && <span className="ml-1.5 text-text-subtle">{t('ui.channels.model.default', { value: fallback })}</span>}
            {param.required && <span className="ml-1.5 text-warning">{t('ui.channels.model.required')}</span>}
            {param.description && <span className="block text-text-subtle">{param.description}</span>}
          </li>
        );
      })}
    </ul>
  );
}
