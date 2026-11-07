import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiSelect } from '@/components/ui';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { getComfyChannelRecoveryConnection, switchComfyChannelJobRoute } from '@/features/channels/runtime/comfyExecution';

/** Explicitly changes only the query/download route of an already accepted task. */
export function ComfyRecoveryControl({ jobId, onRecovered }: { jobId: string; onRecovered(): Promise<void> }) {
  const { t } = useTranslation();
  const providers = useCustomProvidersStore((state) => state.providers).filter((provider) => provider.apiStyle === 'comfyui');
  const [connection, setConnection] = useState<{ originalBaseUrl: string; selectedBaseUrl: string; providerId: string; externalTaskId: string } | null>(null);
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [revision, refresh] = useState(0);
  useEffect(() => {
    let active = true; setConnection(null); setTarget(''); setError('');
    void getComfyChannelRecoveryConnection(jobId).then((value) => { if (active) setConnection(value); }, (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [jobId, revision]);
  if (!connection) return error ? <div className="mt-3 rounded-lg border border-line p-3"><p role="alert" className="text-xs text-danger">{error}</p><UiButton size="sm" className="mt-2" onClick={() => refresh((value) => value + 1)}>{t('rework.retryQuery')}</UiButton></div> : null;
  const recover = async () => {
    if (!target || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await switchComfyChannelJobRoute(jobId, { externalTaskId: connection.externalTaskId, originalBaseUrl: connection.originalBaseUrl, targetProviderId: target }); await onRecovered(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <details className="mt-3 rounded-lg border border-line p-3"><summary className="cursor-pointer text-xs font-medium">{t('ui.workbench.changeConnection')}</summary><div className="mt-3 space-y-3">
    <p className="text-xs text-text-muted">{t('ui.workbench.connectionHint')}</p><p className="break-all text-xs text-text-subtle">{connection.originalBaseUrl}<br />ID: {connection.externalTaskId}</p>
    <UiSelect aria-label={t('ui.workbench.changeConnection')} value={target} onChange={(event) => setTarget(event.target.value)}><option value="">{t('ui.workbench.chooseConnection')}</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label} · {provider.baseUrl}</option>)}</UiSelect>
    <UiButton variant="secondary" size="sm" icon={<RefreshCw />} disabled={!target || busy} loading={busy} onClick={() => void recover()}>{t('ui.workbench.recoverOriginal')}</UiButton>{error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </div></details>;
}
