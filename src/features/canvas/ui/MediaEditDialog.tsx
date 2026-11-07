import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Crop, Film, ImageDown, Scissors, SplitSquareHorizontal, Gauge } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';

import { UiButton, UiField, UiInput, UiModal, UiSegmented } from '@/components/ui';
import { getMediaEditCapability, MediaEditError, runNodeMediaEdit, type MediaEditOperation } from '@/features/canvas/application/media';
import { useAssetDisplaySource } from '@/features/assets/ui/useAssetDisplaySource';
import { isAudioNode, isVideoNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

type EditorMedia = 'video' | 'audio';
type VideoTool = 'captureFrame' | 'trim' | 'crop' | 'separateAudio';
type AudioTool = 'slice' | 'split' | 'rate';

const useMediaEditorStore = create<{ target: { nodeId: string; media: EditorMedia } | null }>(() => ({ target: null }));

/** Open the local media editor for a video/audio node (node toolbar / menus). */
export function openMediaEditor(nodeId: string, media: EditorMedia): void {
  useMediaEditorStore.setState({ target: { nodeId, media } });
}

export function mediaEditErrorText(t: (key: string) => string, error: unknown): string {
  if (error instanceof MediaEditError) return t(`mediaEdit.errors.${error.code}`);
  return error instanceof Error ? error.message : String(error);
}

function toNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Mounted once per canvas; renders only while a node is being edited. */
export function MediaEditDialogHost() {
  const target = useMediaEditorStore((state) => state.target);
  if (!target) return null;
  return <MediaEditDialog key={`${target.nodeId}:${target.media}`} nodeId={target.nodeId} media={target.media} onClose={() => useMediaEditorStore.setState({ target: null })} />;
}

export function MediaEditDialog({ nodeId, media, onClose, source: suppliedSource, onApply }: {
  nodeId?: string; media: EditorMedia; onClose(): void; source?: string;
  onApply?(operation: MediaEditOperation, options: { signal: AbortSignal; onProgress(fraction: number): void }): Promise<{ count: number }>;
}) {
  const { t } = useTranslation();
  const node = useCanvasStore((state) => state.nodes.find((entry) => entry.id === nodeId));
  const source = suppliedSource ?? (node && isVideoNode(node) ? node.data.localVideoUrl || node.data.videoUrl || ''
    : node && isAudioNode(node) ? node.data.localAudioUrl || node.data.audioUrl || '' : '');
  const player = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [duration, setDuration] = useState(() => {
    const saved = node?.data.durationSeconds;
    return typeof saved === 'number' && Number.isFinite(saved) && saved > 0 ? saved : 0;
  });
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [videoTool, setVideoTool] = useState<VideoTool>('captureFrame');
  const [audioTool, setAudioTool] = useState<AudioTool>('slice');
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('');
  const [splits, setSplits] = useState('');
  const [rate, setRate] = useState('1.5');
  const [crop, setCrop] = useState({ x: '0', y: '0', width: '', height: '' });
  const [capability, setCapability] = useState<{ supported: boolean; reason?: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const abort = useRef<AbortController | null>(null);
  const tool = media === 'video' ? videoTool : audioTool;
  const operation = useMemo((): MediaEditOperation | null => {
    const startSeconds = toNumber(start);
    const endSeconds = toNumber(end || String(duration));
    if (media === 'video') {
      if (videoTool === 'captureFrame') return { kind: 'video.captureFrame', timeSeconds: startSeconds };
      if (videoTool === 'trim') return { kind: 'video.trim', startSeconds, endSeconds };
      if (videoTool === 'separateAudio') return { kind: 'video.separateAudio' };
      if (!videoSize?.width || !videoSize.height) return null;
      const rect = { x: toNumber(crop.x) / videoSize.width, y: toNumber(crop.y) / videoSize.height, width: toNumber(crop.width || String(videoSize.width)) / videoSize.width, height: toNumber(crop.height || String(videoSize.height)) / videoSize.height };
      return { kind: 'video.crop', rect };
    }
    if (audioTool === 'slice') return { kind: 'audio.slice', startSeconds, endSeconds };
    if (audioTool === 'rate') return { kind: 'audio.rate', rate: toNumber(rate) };
    const points = splits.split(/[,，\s]+/).filter(Boolean).map(toNumber);
    return points.length ? { kind: 'audio.split', atSeconds: points } : null;
  }, [audioTool, crop, duration, end, media, rate, splits, start, videoSize, videoTool]);
  const operationKind = operation?.kind;
  useEffect(() => {
    if (!operationKind || !source) return;
    let alive = true;
    setCapability(null);
    void getMediaEditCapability(operationKind, source).then(
      (result) => { if (alive) setCapability(result); },
      (cause: unknown) => { if (alive) setCapability({ supported: false, reason: mediaEditErrorText(t, cause) }); },
    );
    return () => { alive = false; };
  }, [operationKind, source, t]);
  useEffect(() => () => abort.current?.abort(), []);
  const busy = progress !== null;
  const run = async () => {
    if (!operation || busy || abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setError(''); setNotice(''); setProgress(0);
    try {
      const options = { signal: controller.signal, onProgress: (fraction: number) => setProgress(fraction) };
      if (onApply) {
        const result = await onApply(operation, options);
        setNotice(`已保存 ${result.count} 个编辑副本，原素材未改动。`);
      } else {
        if (!nodeId) throw new MediaEditError('missing-node');
        const result = await runNodeMediaEdit(nodeId, operation, options);
        setNotice(t('mediaEdit.done', { count: result.nodeIds.length }));
      }
    } catch (cause) {
      setError(mediaEditErrorText(t, cause));
    } finally {
      if (abort.current === controller) abort.current = null;
      setProgress(null);
    }
  };
  const useCurrentTime = (setter: (value: string) => void) => {
    const time = player.current?.currentTime;
    if (typeof time === 'number' && Number.isFinite(time)) setter(time.toFixed(2));
  };
  const timeField = (label: string, value: string, setter: (value: string) => void) => (
    <UiField label={label}>
      <div className="flex gap-1.5">
        <UiInput type="number" min={0} step={0.01} value={value} onChange={(event) => setter(event.target.value)} className="h-8 text-xs" />
        <UiButton size="sm" variant="ghost" onClick={() => useCurrentTime(setter)}>{t('mediaEdit.useCurrentTime')}</UiButton>
      </div>
    </UiField>
  );
  const updateDuration = (element: HTMLMediaElement) => {
    // MediaRecorder WebM can report Infinity at loadedmetadata, then a finite durationchange later.
    if (Number.isFinite(element.duration) && element.duration > 0) setDuration(element.duration);
  };
  const displaySource = useAssetDisplaySource(source).url ?? undefined;
  return (
    <UiModal
      isOpen
      title={t(media === 'video' ? 'mediaEdit.videoTitle' : 'mediaEdit.audioTitle')}
      onClose={() => { if (busy) abort.current?.abort(); onClose(); }}
      widthClassName="w-[min(720px,calc(100vw-1.5rem))]"
      footer={<>
        {busy ? <UiButton variant="ghost" onClick={() => abort.current?.abort()}>{t('common.cancel')}</UiButton> : <UiButton variant="ghost" onClick={onClose}>{t('common.close')}</UiButton>}
        <UiButton variant="primary" loading={busy} disabled={!operation || !source || capability?.supported === false} onClick={() => void run()}>{onApply ? '保存编辑副本' : t('mediaEdit.apply')}</UiButton>
      </>}
    >
      {!source ? <p role="alert" className="text-sm text-danger">{t('mediaEdit.errors.missing-source')}</p> : (
        <div className="space-y-3">
          {media === 'video' ? (
            <video ref={player} src={displaySource} controls playsInline className="max-h-[42vh] w-full rounded-lg bg-black"
              onDurationChange={(event) => updateDuration(event.currentTarget)}
              onLoadedMetadata={(event) => { updateDuration(event.currentTarget); setVideoSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight }); }} />
          ) : (
            <audio ref={player} src={displaySource} controls className="w-full"
              onLoadedMetadata={(event) => updateDuration(event.currentTarget)}
              onDurationChange={(event) => updateDuration(event.currentTarget)} />
          )}
          {media === 'video' ? (
            <UiSegmented<VideoTool>
              value={videoTool}
              onChange={setVideoTool}
              options={[
                { value: 'captureFrame', label: t('mediaEdit.tools.captureFrame'), icon: <ImageDown /> },
                { value: 'trim', label: t('mediaEdit.tools.trim'), icon: <Scissors /> },
                { value: 'crop', label: t('mediaEdit.tools.crop'), icon: <Crop /> },
                { value: 'separateAudio', label: t('mediaEdit.tools.separateAudio'), icon: <AudioLines /> },
              ]}
            />
          ) : (
            <UiSegmented<AudioTool>
              value={audioTool}
              onChange={setAudioTool}
              options={[
                { value: 'slice', label: t('mediaEdit.tools.slice'), icon: <Scissors /> },
                { value: 'split', label: t('mediaEdit.tools.split'), icon: <SplitSquareHorizontal /> },
                { value: 'rate', label: t('mediaEdit.tools.rate'), icon: <Gauge /> },
              ]}
            />
          )}
          <p className="text-[11px] text-text-muted">{t('mediaEdit.duration', { seconds: duration ? duration.toFixed(2) : '—' })}{videoSize ? ` · ${videoSize.width}×${videoSize.height}` : ''}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {(tool === 'captureFrame') && timeField(t('mediaEdit.time'), start, setStart)}
            {(tool === 'trim' || tool === 'slice') && <>
              {timeField(t('mediaEdit.start'), start, setStart)}
              {timeField(t('mediaEdit.end'), end, setEnd)}
            </>}
            {tool === 'split' && (
              <UiField label={t('mediaEdit.splitPoints')} hint={t('mediaEdit.splitHint')}>
                <div className="flex gap-1.5">
                  <UiInput value={splits} placeholder="1.5, 3" onChange={(event) => setSplits(event.target.value)} className="h-8 text-xs" />
                  <UiButton size="sm" variant="ghost" onClick={() => useCurrentTime((value) => setSplits((current) => (current.trim() ? `${current}, ${value}` : value)))}>{t('mediaEdit.addCurrentTime')}</UiButton>
                </div>
              </UiField>
            )}
            {tool === 'rate' && (
              <UiField label={t('mediaEdit.rate')} hint={t('mediaEdit.ratePitchNotice')}>
                <UiInput type="number" min={0.5} max={2} step={0.05} value={rate} onChange={(event) => setRate(event.target.value)} className="h-8 text-xs" />
              </UiField>
            )}
            {tool === 'crop' && (['x', 'y', 'width', 'height'] as const).map((key) => (
              <UiField key={key} label={t(`mediaEdit.crop.${key}`)}>
                <UiInput type="number" min={0} step={1} value={crop[key]} placeholder={key === 'width' ? String(videoSize?.width ?? '') : key === 'height' ? String(videoSize?.height ?? '') : '0'}
                  onChange={(event) => setCrop({ ...crop, [key]: event.target.value })} className="h-8 text-xs" />
              </UiField>
            ))}
          </div>
          {tool === 'separateAudio' && <p className="text-xs text-text-muted">{t('mediaEdit.separateHint')}</p>}
          {capability?.supported === false && (
            <p role="alert" className="flex items-center gap-1.5 text-xs text-warning"><Film className="h-3.5 w-3.5" />{capability.reason ? t(`mediaEdit.errors.${capability.reason}`, { defaultValue: capability.reason }) : t('mediaEdit.unsupported')}</p>
          )}
          {busy && (
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--hover)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)}>
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            </div>
          )}
          {notice && <p role="status" className="text-xs text-success">{notice}</p>}
          {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
        </div>
      )}
    </UiModal>
  );
}
