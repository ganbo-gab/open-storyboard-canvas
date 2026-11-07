import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiField, UiModal, UiSelect } from '@/components/ui';
import { useChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import { createKnowledgeModelPort } from '../infrastructure/chatKnowledgeModel';
import { useKnowledgeStore } from '../application/knowledgeStore';
import type { OrganizeKind } from '../domain/organize';

const KINDS: readonly OrganizeKind[] = ['classify', 'tag', 'moc', 'summary'];

/** The primary button explicitly approves both the paid model request and resulting vault edits. */
export function KnowledgeOrganizeDialog({ paths, onClose }: { paths: string[]; onClose(): void }) {
  const { t } = useTranslation();
  const catalog = useChatModelCatalog();
  const [modelId, setModelId] = useState('');
  const [kind, setKind] = useState<OrganizeKind>('summary');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const model = catalog.find(entry => entry.id === modelId && entry.usable);
  const submit = async () => {
    if (!model || busy || attempted || paths.length < 1 || paths.length > 20) return;
    setAttempted(true); setBusy(true); setError('');
    try { await useKnowledgeStore.getState().organize(kind, paths, createKnowledgeModelPort(model)); setDone(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <UiModal isOpen title={t('rework.knowledge.organizeTitle')} onClose={() => { if (!busy) onClose(); }} widthClassName="w-[min(620px,calc(100vw-1.5rem))]"
    footer={<><UiButton variant="ghost" disabled={busy} onClick={onClose}>{t(done || attempted ? 'common.close' : 'common.cancel')}</UiButton>{!done && <UiButton variant="primary" icon={<Sparkles />} loading={busy} disabled={attempted || !model || !paths.length || paths.length > 20} onClick={() => void submit()}>{t('rework.knowledge.approveOrganize')}</UiButton>}</>}>
    {done ? <p role="status" className="text-sm text-success">{t('rework.knowledge.organized')}</p> : <div className="space-y-4">
      <p className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs leading-6 text-warning">{t('rework.knowledge.paidWarning')}</p>
      <div className="grid gap-3 sm:grid-cols-2"><UiField label={t('rework.knowledge.organizeKind')}><UiSelect value={kind} disabled={busy} onChange={event => { const value = KINDS.find(entry => entry === event.target.value); if (value) setKind(value); }}>{KINDS.map(value => <option key={value} value={value}>{t(`rework.knowledge.organizeKinds.${value}`)}</option>)}</UiSelect></UiField><UiField label={t('rework.knowledge.model')}><UiSelect value={modelId} disabled={busy} onChange={event => setModelId(event.target.value)}><option value="">{t('rework.knowledge.chooseModel')}</option>{catalog.map(entry => <option key={entry.id} value={entry.id} disabled={!entry.usable}>{entry.providerLabel} · {entry.modelLabel}{!entry.usable ? ` · ${t('rework.knowledge.modelUnavailable')}` : ''}</option>)}</UiSelect></UiField></div>
      <p className="text-xs text-text-muted">{t('rework.knowledge.organizeLimit', { count: paths.length })}</p>
      <ul className="ui-scrollbar max-h-48 space-y-1 overflow-y-auto rounded-lg border border-[var(--line)] p-3 text-xs text-text-muted">{paths.map(path => <li key={path} className="break-words">{path}</li>)}</ul>
      {error && <p role="alert" className="break-words text-xs leading-5 text-danger">{error}</p>}
      {attempted && !busy && <p className="text-xs leading-5 text-text-muted">{t('rework.knowledge.submittedNotice')}</p>}
    </div>}
  </UiModal>;
}
