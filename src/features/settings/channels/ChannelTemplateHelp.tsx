import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { operationKinds, RATIO_PARAM_KEYS, SIZE_PARAM_KEYS, type ChannelProfileV2, type ModeSpec, type OperationKind, type OperationSpec, type ParamSpec, type Template } from '@/features/channels/domain/profile';

const operationLabels: Record<OperationKind, string> = {
  chat: 'chat', 'image.generate': 'imageGenerate', 'image.edit': 'imageEdit', 'video.generate': 'videoGenerate',
  'audio.generate': 'audioGenerate', 'model.generate': 'modelGenerate', 'models.list': 'modelsList',
};

interface ParameterReference { param: ParamSpec; fields: string[]; contexts: string[] }

function endpointIdentity(operation: OperationKind, endpoint: OperationSpec): string {
  return JSON.stringify([operation, endpoint.method, endpoint.path, endpoint.body,
    endpoint.response.mode === 'async' ? [endpoint.response.poll.method, endpoint.response.poll.path] : null]);
}

/** Show the actual HTTP field, including nested paths and compound parameter members. */
function parameterFields(template: Template | undefined, key: string, path = ''): string[] {
  if (typeof template === 'string') return [...template.matchAll(/{{\s*param\.([\w-]+)(?:\.([\w.-]+))?\s*}}/g)]
    .filter(match => match[1] === key).map(match => `${path}${match[2] ? ` ← ${key}.${match[2]}` : ''}`);
  if (Array.isArray(template)) return template.flatMap((child, index) => parameterFields(child, key, `${path}[${index}]`));
  if (template && typeof template === 'object') return Object.entries(template)
    .flatMap(([field, child]) => parameterFields(child, key, path ? `${path}.${field}` : field));
  return [];
}

function templateReferences(profile: ChannelProfileV2): { endpoints: { operation: OperationKind; endpoint: OperationSpec }[]; parameters: ParameterReference[] } {
  const endpoints = new Map<string, { operation: OperationKind; endpoint: OperationSpec }>();
  const parameters = new Map<string, ParameterReference>();
  const addEndpoint = (operation: OperationKind, endpoint: OperationSpec) => {
    endpoints.set(endpointIdentity(operation, endpoint), { operation, endpoint });
  };
  for (const operation of operationKinds) {
    const endpoint = profile.operations[operation];
    if (endpoint) addEndpoint(operation, endpoint);
  }
  for (const model of profile.models) {
    const variants: ModeSpec[] = model.modes ?? model.operations.map(operation => ({ id: operation, label: '', operation }));
    for (const mode of variants) {
      const endpoint = mode.endpoint ?? profile.operations[mode.operation];
      if (endpoint) addEndpoint(mode.operation, endpoint);
      const params = new Map([...model.params, ...(mode.params ?? [])].map(param => [param.key, param]));
      for (const param of params.values()) {
        const fields = parameterFields(endpoint?.template, param.key);
        const identity = JSON.stringify([param, fields]);
        const context = [model.label ?? model.id, mode.label].filter(Boolean).join(' · ');
        const existing = parameters.get(identity);
        if (existing) {
          if (!existing.contexts.includes(context)) existing.contexts.push(context);
        } else parameters.set(identity, { param, fields, contexts: [context] });
      }
    }
  }
  return { endpoints: [...endpoints.values()], parameters: [...parameters.values()] };
}

export function ChannelTemplateHelp({ profile }: { profile: ChannelProfileV2 }) {
  const { t } = useTranslation();
  const { endpoints, parameters } = templateReferences(profile);
  const list = profile.operations['models.list'];
  const pixels = parameters.filter(({ param }) => param.options?.some(option => typeof option.value === 'string' && /^\d+\s*[x×]\s*\d+$/i.test(option.value)));
  const ratios = parameters.filter(({ param }) => RATIO_PARAM_KEYS.includes(param.key));
  const resolutions = parameters.filter(({ param }) => SIZE_PARAM_KEYS.includes(param.key) && !pixels.some(entry => entry.param === param));
  const hasTime = parameters.some(({ param, fields }) => /seconds|duration/i.test(param.key) || fields.some(field => /seconds|duration/i.test(field)));
  return <div className="space-y-5">
    <p className="text-sm leading-6 text-text-muted">{t('ui.channels.templateHelp.intro')}</p>
    <ol className="space-y-4">
      {(['connect', 'models', 'review'] as const).map((step, index) => <li key={step} className="flex gap-3">
        <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent">{index + 1}</span>
        <div className="min-w-0 space-y-1"><h4 className="text-sm font-medium">{t(`ui.channels.templateHelp.${step}Title`)}</h4><p className="text-xs leading-6 text-text-muted">{t(`ui.channels.templateHelp.${step}Body`)}</p>
          {step === 'models' && <p className="text-xs leading-6 text-text-muted">{list ? t('ui.channels.templateHelp.modelList', { path: `${list.method} ${list.path}` }) : t('ui.channels.templateHelp.manualModels')}</p>}
        </div>
      </li>)}
    </ol>
    <section className="space-y-3 border-t border-line pt-4" aria-label={t('ui.channels.templateHelp.routesTitle')}>
      <h4 className="text-sm font-medium">{t('ui.channels.templateHelp.routesTitle')}</h4>
      <p className="text-xs leading-6 text-text-muted">{t('ui.channels.templateHelp.routesHint')}</p>
      <dl className="space-y-3">{endpoints.map(({ operation, endpoint }) => <div key={endpointIdentity(operation, endpoint)} className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <dt className="text-xs text-text-muted">{t(`ui.channels.operation.${operationLabels[operation]}`)}</dt>
        <dd className="min-w-0 space-y-1"><code className="block break-all text-xs">{endpoint.method} {endpoint.path}</code><span className="block text-[11px] text-text-muted">{t('ui.channels.templateHelp.body', { format: endpoint.body })}</span>
          {endpoint.response.mode === 'async' && <code className="block break-all text-[11px] text-text-muted">{t('ui.channels.templateHelp.poll', { path: `${endpoint.response.poll.method} ${endpoint.response.poll.path}` })}</code>}
        </dd>
      </div>)}</dl>
    </section>
    {(pixels.length > 0 || ratios.length > 0 || resolutions.length > 0 || hasTime) && <section className="space-y-2 rounded-lg bg-surface-dark p-3">
      <h4 className="text-xs font-medium">{t('ui.channels.templateHelp.sizeTimeTitle')}</h4>
      {pixels.length > 0 && <p className="text-xs leading-6 text-text-muted">{t('ui.channels.templateHelp.pixels', { fields: [...new Set(pixels.flatMap(entry => entry.fields.length ? entry.fields : [entry.param.key]))].join(' / ') })}</p>}
      {(ratios.length > 0 || resolutions.length > 0) && <p className="text-xs leading-6 text-text-muted">{t('ui.channels.templateHelp.nativeSize', { fields: [...new Set([...ratios, ...resolutions].flatMap(entry => entry.fields.length ? entry.fields : [entry.param.key]))].join(' / ') })}</p>}
      {hasTime && <p className="text-xs leading-6 text-text-muted">{t('ui.channels.templateHelp.time')}</p>}
    </section>}
    {parameters.length > 0 && <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-sm font-medium">{t('ui.channels.templateHelp.parametersTitle')}</summary>
      <p className="mt-2 text-xs leading-6 text-text-muted">{t('ui.channels.templateHelp.parametersHint')}</p>
      <dl className="mt-3 space-y-4">{parameters.map(({ param, fields, contexts }, index) => <div key={index}>
        <dt className="text-xs font-medium">{param.label} <code className="text-text-muted">{param.key}</code></dt>
        <dd className="mt-1 space-y-1 text-xs leading-5 text-text-muted">
          <p>{t('ui.channels.templateHelp.appliesTo', { contexts: contexts.join(' / ') })}</p>
          {fields.length > 0 && <code className="block break-all">{fields.join(' / ')}</code>}
          {param.options?.length ? <p className="break-words font-mono">{param.options.map(option => `${option.label} = ${JSON.stringify(option.value)}`).join(' · ')}</p> : <p>{t(`ui.channels.templateHelp.valueType.${param.type}`)}{param.min !== undefined || param.max !== undefined ? ` · ${param.min ?? '…'}–${param.max ?? '…'}` : ''}</p>}
          {param.description && <p>{param.description}</p>}
        </dd>
      </div>)}</dl>
    </details>}
    <p className="text-xs leading-6 text-text-muted">{t('ui.channels.templateHelp.customize')}</p>
    {!!profile.notes?.length && <details className="text-xs text-text-muted"><summary className="cursor-pointer">{t('ui.channels.templateHelp.notesTitle')}</summary><div className="mt-2 space-y-2">{profile.notes.map(note => <p key={note} className="leading-6">{note}</p>)}</div></details>}
    {profile.docsUrl && <a href={profile.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm text-accent"><ExternalLink size={14} />{t('ui.channels.catalog.docs')}</a>}
  </div>;
}
