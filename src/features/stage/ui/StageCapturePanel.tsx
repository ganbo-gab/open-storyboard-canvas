import { useEffect, useRef, useState } from 'react';
import { Aperture, Grid2X2, ImagePlus, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiInput, UiSegmented } from '@/components/ui';
import { AssetMedia } from '@/features/assets/ui/AssetMedia';
import { resolveAsset, type AssetRecord } from '@/features/assets/application/assetCatalog';
import { openMediaViewer } from '@/features/viewer/viewerStore';
import { stageCommands } from '../application/stageCommands';
import { publishStageCaptures } from '../application/publishStageCaptures';

export function StageCapturePanel({ nodeId, duration, currentTime }: { nodeId: string; duration: number; currentTime: () => number }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'current' | 'exact'>('current');
  const [time, setTime] = useState(() => currentTime());
  const [images, setImages] = useState<Array<{ asset: AssetRecord; label: string }>>([]);
  const [busy, setBusy] = useState(false); const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const sendingRef = useRef(false);
  useEffect(() => () => active.current?.abort(), [nodeId]);
  const capture = async (four: boolean) => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError(''); setNotice('');
    try {
      const at = mode === 'exact' ? time : undefined;
      const result = four ? (await stageCommands.captureFourViews(nodeId, at, controller.signal)).images
        : [{ ...(await stageCommands.capture(nodeId, at, controller.signal)), view: undefined }];
      const next = await Promise.all(result.map(async (entry) => {
        const asset = await resolveAsset(entry.assetId);
        if (!asset) throw new Error(t('ui.stage.capture.error'));
        return { asset, label: entry.view ? t(`ui.stage.capture.${entry.view}`) : t('ui.stage.capture.current') };
      }));
      controller.signal.throwIfAborted(); setImages(next);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('ui.stage.capture.error')); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  };
  const send = async (ids = images.map((entry) => entry.asset.id)) => {
    if (sendingRef.current || ids.length === 0) return; sendingRef.current = true; setSending(true); setError('');
    try { await publishStageCaptures(nodeId, ids); setNotice(t('ui.stage.capture.sent')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('ui.stage.capture.error')); }
    finally { sendingRef.current = false; setSending(false); }
  };
  const open = (index: number) => openMediaViewer(images.map(({ asset, label }) => ({ id: asset.id, kind: 'image', source: asset.source, title: label,
    primaryActions: [{ id: 'send', label: t('ui.stage.capture.send'), run: () => send([asset.id]) }] })), index);
  return <section className="space-y-3 border-b border-line p-3" aria-label={t('ui.stage.capture.title')}>
    <h3 className="text-sm font-medium">{t('ui.stage.capture.title')}</h3>
    <UiSegmented value={mode} onChange={setMode} size="sm" options={[{ value: 'current', label: t('ui.stage.capture.current') }, { value: 'exact', label: t('ui.stage.capture.exact') }]} />
    {mode === 'exact' ? <label className="flex items-center gap-2 text-xs text-text-muted">{t('ui.stage.capture.time')}<UiInput type="number" min={0} max={duration} step={1 / 24} value={time} onChange={(event) => setTime(Number(event.target.value))} className="h-8 min-w-0 flex-1" /></label> : null}
    <div className="flex gap-2"><UiButton size="sm" disabled={busy || (mode === 'exact' && (!Number.isFinite(time) || time < 0 || time > duration))} onClick={() => void capture(false)}><Aperture className="h-4 w-4" />{t('ui.stage.capture.capture')}</UiButton>
      <UiButton size="sm" variant="primary" disabled={busy || (mode === 'exact' && (!Number.isFinite(time) || time < 0 || time > duration))} onClick={() => void capture(true)}><Grid2X2 className="h-4 w-4" />{t('ui.stage.capture.four')}</UiButton></div>
    {busy ? <div role="status" className="flex items-center justify-between text-xs text-text-muted"><span className="flex gap-2"><Loader2 className="h-4 w-4 animate-spin" />{t('ui.stage.capture.busy')}</span><UiButton size="sm" onClick={() => active.current?.abort()}>{t('ui.stage.capture.cancel')}</UiButton></div> : null}
    {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    {notice ? <p role="status" className="text-xs text-success">{notice}</p> : null}
    {images.length ? <><div className="grid grid-cols-2 gap-2">{images.map(({ asset, label }, index) => <button type="button" key={asset.id} onClick={() => open(index)} className="overflow-hidden rounded-lg border border-line bg-raised text-left" aria-label={`${label} · ${t('ui.stage.capture.open')}`}><AssetMedia kind="image" source={asset.source} alt={label} className="aspect-video w-full object-cover" /><span className="block p-2 text-xs">{label}</span></button>)}</div><UiButton size="sm" disabled={sending} onClick={() => void send()}><ImagePlus className="h-4 w-4" />{t('ui.stage.capture.send')}</UiButton></> : <p className="text-xs leading-5 text-text-subtle">{t('ui.stage.capture.empty')}</p>}
  </section>;
}
