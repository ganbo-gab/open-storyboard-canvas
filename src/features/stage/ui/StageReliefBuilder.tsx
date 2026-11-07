import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton } from '@/components/ui';
import { ScrubNumber } from './stageKit';
import { StageScenePreview } from './StageScenePreview';
import type { StageSourceImage } from './StageImagePicker';
import type { BlueprintItem } from '@/features/canvas/domain/canvasNodes';
import { DEFAULT_DEPTH_RELIEF_PARAMETERS } from '../domain/depthRelief';
import { buildDepthRelief, type BuiltDepthRelief, type DepthReliefProgress } from '../application/depthRelief';
import { stageCommands } from '../application/stageCommands';

export function StageReliefBuilder({ nodeId, projectId, images, onApplied, onBusyChange }: {
  nodeId: string;
  projectId?: string;
  images: StageSourceImage[];
  onApplied(itemIds: string[]): void;
  onBusyChange(busy: boolean): void;
}) {
  const { t } = useTranslation();
  const [params, setParams] = useState({ ...DEFAULT_DEPTH_RELIEF_PARAMETERS });
  const [result, setResult] = useState<BuiltDepthRelief | null>(null);
  const [name, setName] = useState('');
  const [progress, setProgress] = useState<DepthReliefProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const run = useRef<AbortController | null>(null);
  useEffect(() => () => { run.current?.abort(); run.current = null; }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  const items = useMemo<BlueprintItem[]>(() => result ? [{
    id: 'relief-preview', label: name, category: 'scene', color: '#94a3b8', x: 0, y: 0,
    pos3d: { x: 0, y: 0, z: 0 }, relief: { ...result.relief, ...params },
  }] : [], [result, params, name]);
  const generate = async () => {
    if (run.current || images.length !== 1) return;
    const controller = new AbortController();
    run.current = controller;
    setBusy(true); setError(''); setNotice(''); setResult(null);
    setProgress({ phase: 'loading-model' });
    const source = images[0];
    try {
      const built = await buildDepthRelief({ imageUrl: source.source, name: source.name, nodeId, projectId, params }, {
        signal: controller.signal,
        onProgress: (next) => { if (run.current === controller) setProgress(next); },
      });
      controller.signal.throwIfAborted();
      if (run.current === controller) { setResult(built); setName(source.name); }
    } catch (cause) {
      if (run.current === controller) {
        if (controller.signal.aborted) setNotice(t('rework.stage.sceneBuilder.stopped'));
        else setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally { if (run.current === controller) { run.current = null; setBusy(false); } }
  };
  const adopt = () => {
    if (!items.length) return;
    try {
      const item = { ...items[0], id: crypto.randomUUID() };
      const applied = stageCommands.execute(nodeId, { type: 'object.add', item });
      onApplied(applied.createdIds);
      setResult(null); setNotice(t('rework.stage.sceneBuilder.applied'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const phase = progress?.phase === 'loading-model' ? 'loading' : progress?.phase;
  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-text-muted">{t('rework.stage.relief.relativeDepth')}</p>
      <p className="text-xs leading-5 text-text-subtle">{t('rework.stage.relief.downloadNotice')}</p>
      <div className="grid grid-cols-2 gap-2">
        <ScrubNumber label={t('rework.stage.relief.width')} value={params.widthM} min={0.1} max={1000} step={0.5} suffix="m" onCommit={(widthM) => setParams((current) => ({ ...current, widthM }))} />
        <ScrubNumber label={t('rework.stage.relief.depth')} value={params.depthM} min={0} max={1000} step={0.5} suffix="m" onCommit={(depthM) => setParams((current) => ({ ...current, depthM }))} />
        <ScrubNumber label={t('rework.stage.relief.fov')} value={params.fovDeg} min={1} max={179} step={1} suffix="°" onCommit={(fovDeg) => setParams((current) => ({ ...current, fovDeg }))} />
        <ScrubNumber label={t('rework.stage.relief.segments')} value={params.segments} min={1} max={512} step={1} onCommit={(segments) => setParams((current) => ({ ...current, segments }))} />
      </div>
      {busy && progress && <div role="status" className="space-y-1 text-xs text-text-muted">
        <p>{t(`rework.stage.relief.${phase}`)}{progress.device ? ` · ${progress.device}` : ''}{progress.status === 'fallback' ? ` · ${t('rework.stage.relief.fallback')}` : ''}</p>
        {progress.progress !== undefined && <progress className="h-1 w-full" max={100} value={progress.progress} aria-label={t('rework.stage.relief.loading')} />}
      </div>}
      {!busy && images.length !== 1 && <p className="text-xs text-warning">{t('rework.stage.sceneBuilder.oneImage')}</p>}
      <div className="flex flex-wrap gap-2">
        <UiButton variant="primary" loading={busy} disabled={images.length !== 1} onClick={() => void generate()}>{t('rework.stage.relief.generate')}</UiButton>
        {busy && <UiButton onClick={() => run.current?.abort()}>{t('common.cancel')}</UiButton>}
      </div>
      {result && <><StageScenePreview items={items} /><UiButton variant="primary" onClick={adopt}>{t('rework.stage.sceneBuilder.adopt')}</UiButton></>}
      {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
      {notice && <p role="status" className="text-xs text-text-muted">{notice}</p>}
    </div>
  );
}
