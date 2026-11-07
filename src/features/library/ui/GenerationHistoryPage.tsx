import { openGenerationDetails } from './GenerationDetailsDialog';
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, FileClock, FileText, RotateCcw, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiChipButton, UiField, UiInput, UiSelect } from '@/components/ui';
import { AssetMedia } from '@/features/assets/ui/AssetMedia';
import { useProjectStore } from '@/stores/projectStore';
import { useGenerationHistoryStore } from '../history/historyStore';
import { filterGenerationHistory, jumpToHistorySource, reuseParams, type GenerationHistoryRecord, type HistoryReuseDraft, type HistorySource } from '../history/history';

const SURFACES = ['canvas', 'workbench', 'agent'] as const;

export function GenerationHistoryPage({ onJump, onReuse, compact = false }: {
  onJump(source: Exclude<HistorySource, { surface: 'unavailable' }>): void | Promise<void>;
  onReuse(draft: HistoryReuseDraft): void | Promise<void>;
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const records = useGenerationHistoryStore(state => state.records);
  const initialized = useGenerationHistoryStore(state => state.initialized);
  const storage = useGenerationHistoryStore(state => state.storageStatus);
  const storeError = useGenerationHistoryStore(state => state.error);
  const projects = useProjectStore(state => state.projects);
  const [surface, setSurface] = useState<GenerationHistoryRecord['surface'] | ''>('');
  const [query, setQuery] = useState('');
  const [model, setModel] = useState('');
  const [status, setStatus] = useState<GenerationHistoryRecord['status'] | ''>('');
  const [projectId, setProjectId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [visibleCount, setVisibleCount] = useState(80);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { void useGenerationHistoryStore.getState().initialize().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }, []);
  useEffect(() => setVisibleCount(80), [surface, query, model, status, projectId, from, to]);
  const models = useMemo(() => [...new Set(records.map(record => record.modelRef))].sort(), [records]);
  const statuses = useMemo(() => [...new Set(records.map(record => record.status))].sort(), [records]);
  const filtered = useMemo(() => filterGenerationHistory(records, { surface: surface || undefined, text: query, model: model || undefined,
    status: status || undefined, projectId: projectId || undefined,
    from: from ? new Date(`${from}T00:00:00`).getTime() : undefined, to: to ? new Date(`${to}T23:59:59.999`).getTime() : undefined,
  }), [records, surface, query, model, status, projectId, from, to]);
  const run = async (id: string, action: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(id); setError(''); setNotice('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  const jump = (record: GenerationHistoryRecord) => {
    const source = jumpToHistorySource(record);
    if (source.surface !== 'unavailable') void run(record.id, () => onJump(source));
  };
  return <div className={compact ? 'ui-scrollbar h-full overflow-y-auto p-1' : 'studio-page ui-scrollbar h-full overflow-y-auto px-6 py-8 sm:px-10'}><div className="mx-auto max-w-[1180px] space-y-5">
    <header><h1 className={compact ? 'text-lg font-semibold text-text-dark' : 'text-2xl font-semibold tracking-tight text-text-dark'}>{t('rework.generationHistory.title')}</h1><p className="mt-1.5 text-xs leading-5 text-text-muted">{t('rework.generationHistory.subtitle')}</p></header>
    <div className="flex flex-wrap items-center gap-3"><div role="radiogroup" aria-label={t('rework.generationHistory.source')} className="flex flex-wrap gap-1.5"><UiChipButton role="radio" aria-checked={!surface} active={!surface} onClick={() => setSurface('')}>{t('rework.generationHistory.allSources')}</UiChipButton>{SURFACES.map(value => <UiChipButton key={value} role="radio" aria-checked={surface === value} active={surface === value} onClick={() => setSurface(value)}>{t(`rework.generationHistory.surfaces.${value}`)}</UiChipButton>)}</div>
      <label className="relative min-w-48 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-subtle" /><UiInput value={query} onChange={event => setQuery(event.target.value)} placeholder={t('rework.generationHistory.search')} aria-label={t('rework.generationHistory.search')} className="w-full rounded-full pl-9" /></label></div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5"><UiField label={t('rework.generationHistory.model')}><UiSelect value={model} onChange={event => setModel(event.target.value)}><option value="">{t('rework.generationHistory.allModels')}</option>{models.map(value => <option key={value} value={value}>{value}</option>)}</UiSelect></UiField><UiField label={t('rework.generationHistory.status')}><UiSelect value={status} onChange={event => setStatus(statuses.find(value => value === event.target.value) ?? '')}><option value="">{t('rework.generationHistory.allStatuses')}</option>{statuses.map(value => <option key={value} value={value}>{t(`generationJob.status.${value}`, { defaultValue: value })}</option>)}</UiSelect></UiField><UiField label={t('rework.generationHistory.project')}><UiSelect value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">{t('rework.generationHistory.allProjects')}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</UiSelect></UiField><UiField label={t('rework.generationHistory.from')}><UiInput type="date" value={from} max={to || undefined} onChange={event => setFrom(event.target.value)} /></UiField><UiField label={t('rework.generationHistory.to')}><UiInput type="date" value={to} min={from || undefined} onChange={event => setTo(event.target.value)} /></UiField></div>
    {storage.mode === 'memory' && <p role="alert" className="rounded-lg border border-warning/30 p-3 text-xs text-warning">{t('rework.generationHistory.storageWarning', { reason: storage.reason })}</p>}
    {(error || storeError) && <p role="alert" className="text-xs text-danger">{error || storeError}</p>}{notice && <p role="status" className="text-xs text-success">{notice}</p>}
    {!initialized ? <p role="status" className="py-10 text-center text-sm text-text-muted">{t('common.loading')}</p> : !filtered.length ? <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center"><span className="studio-tool__icon"><FileClock className="h-6 w-6" /></span><p className="text-sm text-text-muted">{t(records.length ? 'rework.noMatches' : 'rework.generationHistory.empty')}</p></div> : <div className="space-y-3">{filtered.slice(0, visibleCount).map(record => <article key={record.id} className="flex flex-col gap-3 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--field-bg)] p-3 sm:flex-row">
      <button type="button" className="flex h-28 w-full shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--hover)] text-text-subtle sm:w-36" onClick={() => openGenerationDetails({ recordId: record.id })} aria-label={t('rework.generationHistory.details')}><HistoryOutput output={record.outputs[0]} /></button>
      <div className="min-w-0 flex-1"><div className="mb-1.5 flex flex-wrap items-center gap-2 text-[10.5px] text-text-subtle"><span>{t(`rework.generationHistory.surfaces.${record.surface}`)}</span><time dateTime={new Date(record.createdAt).toISOString()}>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(record.createdAt)}</time><span>{t(`generationJob.status.${record.status}`, { defaultValue: record.status })}</span></div><button type="button" className="line-clamp-2 text-left text-sm leading-6 text-text-dark" onClick={() => openGenerationDetails({ recordId: record.id })}>{record.prompt || t('rework.generationHistory.noPrompt')}</button><p className="mt-1 truncate text-xs text-text-muted">{record.modelRef}{record.modeId ? ` · ${record.modeId}` : ''} · {t('rework.generationHistory.outputCount', { count: record.outputs.length })}</p>{record.error && <p className="mt-2 line-clamp-2 break-words text-xs text-danger">{record.error}</p>}
        <div className="mt-3 flex flex-wrap gap-2"><UiButton size="sm" variant="ghost" icon={<ArrowUpRight />} disabled={Boolean(busy) || jumpToHistorySource(record).surface === 'unavailable'} onClick={() => jump(record)}>{t('rework.generationHistory.jump')}</UiButton><UiButton size="sm" icon={<RotateCcw />} loading={busy === record.id} disabled={Boolean(busy && busy !== record.id)} onClick={() => void run(record.id, () => onReuse(reuseParams(record)))}>{t('rework.generationHistory.reuse')}</UiButton></div>
      </div>
    </article>)}{filtered.length > visibleCount && <UiButton className="mx-auto flex" onClick={() => setVisibleCount(count => count + 80)}>{t('rework.generationHistory.loadMore')}</UiButton>}</div>}
  </div>

  </div>;
}

function HistoryOutput({ output, controls = false }: { output?: GenerationHistoryRecord['outputs'][number]; controls?: boolean }) {
  const { t } = useTranslation();
  if (!output) return <FileClock className="h-8 w-8" />;
  if (output.kind === 'text') return <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-3 text-left text-xs leading-5 text-text-muted">{controls ? output.source : output.source.slice(0, 180)}</pre>;
  if (output.kind === 'model') return <span className="flex items-center gap-2 p-4 text-xs text-text-muted"><FileText className="h-5 w-5" />{t('rework.generationHistory.modelOutput')}</span>;
  return <AssetMedia source={output.source} kind={output.kind} controls={controls} className={controls ? 'max-h-80 w-full object-contain' : 'h-full w-full object-cover'} />;
}
