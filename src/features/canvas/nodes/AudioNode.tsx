import { BatchStackControl } from '@/features/canvas/ui/BatchStackControl';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Check, Loader2, Music2, Pause, Play, RefreshCw, Scissors, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiIconButton } from '@/components/ui';
import {
  CANVAS_NODE_TYPES,
  type AudioNodeData,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import { isNodeUsingDefaultDisplayName, resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { useAssetDisplaySource } from '@/features/assets/ui/useAssetDisplaySource';
import { isAudioFile, resolveDroppedAudioFile } from '@/features/canvas/application/imageDragDrop';
import { prepareAudioNodeDataFromFile } from '@/features/canvas/application/audioUpload';
import { NodeFrame, resolveNodeBox } from '@/features/canvas/ui/NodeFrame';
import { GenerationReferenceRetry } from '@/features/canvas/ui/GenerationReferenceRetry';
import { formatGenerationElapsedMs } from '@/features/canvas/ui/generationElapsed';
import { MediaEditError, runNodeMediaEdit } from '@/features/canvas/application/media';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type AudioNodeProps = NodeProps & {
  id: string;
  data: AudioNodeData;
  selected?: boolean;
};

const AUDIO_NODE_DEFAULT_WIDTH = 360;
const AUDIO_NODE_DEFAULT_HEIGHT = 170;
const AUDIO_NODE_MIN_WIDTH = 280;
const AUDIO_NODE_MIN_HEIGHT = 150;
const AUDIO_NODE_MAX_WIDTH = 900;
const AUDIO_NODE_MAX_HEIGHT = 420;
const MIN_AUDIO_TRIM_SECONDS = 0.1;


function formatAudioTime(value: number | null | undefined): string {
  if (!Number.isFinite(value ?? NaN) || !value || value < 0) {
    return '0:00';
  }
  const totalSeconds = Math.floor(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

const AUDIO_WAVEFORM_BARS = Array.from({ length: 48 }, (_, index) => {
  const seed = Math.sin(index * 1.73) + Math.sin(index * 0.47);
  return Math.round(18 + Math.abs(seed) * 13 + (index % 5) * 2);
});

export const AudioNode = memo(({ id, data, selected, type, width, height }: AudioNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveformRef = useRef<HTMLDivElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const useUploadFilenameAsNodeTitle = useSettingsStore((state) => state.useUploadFilenameAsNodeTitle);
  const [now, setNow] = useState(() => Date.now());
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState<number | null>(null);
  const [isTrimming, setIsTrimming] = useState(false);
  const [trimNotice, setTrimNotice] = useState('');

  const isGenerating = data.isGenerating === true;
  const rawAudioSource = data.localAudioUrl || data.audioUrl || objectUrl;
  // Playable URL; null while an asset-media handle hydrates. Presence checks use the durable source.
  const audioSource = useAssetDisplaySource(rawAudioSource).url;
  const generationError = typeof data.generationError === 'string' ? data.generationError.trim() : '';
  const hasGenerationError = !isGenerating && !rawAudioSource && generationError.length > 0;
  const referenceFailure = hasGenerationError ? data.generationReferenceFailure ?? null : null;
  const generationStartedAt = typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null;
  const generationDurationMs = typeof data.generationDurationMs === 'number' ? data.generationDurationMs : 180000;
  const { width: resolvedWidth, height: resolvedHeight } = resolveNodeBox(
    CANVAS_NODE_TYPES.audio,
    width ?? AUDIO_NODE_DEFAULT_WIDTH,
    height ?? AUDIO_NODE_DEFAULT_HEIGHT,
    { minWidth: AUDIO_NODE_MIN_WIDTH, minHeight: AUDIO_NODE_MIN_HEIGHT },
  );
  const resolvedTitle = useMemo(() => {
    const sourceFileName = typeof data.sourceFileName === 'string' ? data.sourceFileName.trim() : '';
    if (
      useUploadFilenameAsNodeTitle
      && sourceFileName
      && isNodeUsingDefaultDisplayName(CANVAS_NODE_TYPES.audio, data)
    ) {
      return sourceFileName;
    }

    return resolveNodeDisplayName(type as CanvasNodeType, data);
  }, [data, type, useUploadFilenameAsNodeTitle]);
  const finishedElapsed = !isGenerating ? formatGenerationElapsedMs(data.generationElapsedMs) : '';
  const sourceReferenceAudioTitle =
    typeof data.sourceReferenceAudioTitle === 'string' && data.sourceReferenceAudioTitle.trim()
      ? data.sourceReferenceAudioTitle.trim()
      : '';
  const sourceAudioMode =
    typeof data.sourceAudioMode === 'string' && data.sourceAudioMode.trim()
      ? data.sourceAudioMode.trim()
      : '';
  const sourceAudioModeLabel = sourceAudioMode === 'ultimate-cloning'
    ? 'Ultimate Cloning'
    : sourceAudioMode === 'controllable-cloning'
      ? 'Controllable Cloning'
      : sourceAudioMode === 'voice-design'
        ? 'Voice Design'
        : '';

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  useEffect(() => {
    if (!isGenerating) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [isGenerating]);

  useEffect(() => () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const progress = useMemo(() => {
    if (!isGenerating) return 0;
    const startedAt = generationStartedAt ?? Date.now();
    const duration = Math.max(1000, generationDurationMs);
    return Math.min(Math.max(0, now - startedAt) / duration, 0.96);
  }, [generationDurationMs, generationStartedAt, isGenerating, now]);
  const resolvedPlaybackDuration = playbackDuration ?? data.durationSeconds ?? null;
  const playbackProgress = resolvedPlaybackDuration && resolvedPlaybackDuration > 0
    ? Math.min(1, Math.max(0, currentTime / resolvedPlaybackDuration))
    : 0;
  const canTrim = Boolean(rawAudioSource && audioSource && resolvedPlaybackDuration && resolvedPlaybackDuration > MIN_AUDIO_TRIM_SECONDS);
  const isAudioTrimMode = data.isAudioTrimMode === true && canTrim;
  const safeTrimDuration = Math.max(MIN_AUDIO_TRIM_SECONDS, resolvedPlaybackDuration ?? MIN_AUDIO_TRIM_SECONDS);
  const rawTrimStart = typeof data.audioTrimStartSeconds === 'number' ? data.audioTrimStartSeconds : 0;
  const rawTrimEnd = typeof data.audioTrimEndSeconds === 'number'
    ? data.audioTrimEndSeconds
    : Math.min(safeTrimDuration, Math.max(MIN_AUDIO_TRIM_SECONDS, safeTrimDuration * 0.5));
  const trimStart = clampNumber(
    Math.min(rawTrimStart, rawTrimEnd - MIN_AUDIO_TRIM_SECONDS),
    0,
    Math.max(0, safeTrimDuration - MIN_AUDIO_TRIM_SECONDS)
  );
  const trimEnd = clampNumber(
    Math.max(rawTrimEnd, trimStart + MIN_AUDIO_TRIM_SECONDS),
    trimStart + MIN_AUDIO_TRIM_SECONDS,
    safeTrimDuration
  );
  const trimLeftPercent = safeTrimDuration > 0 ? (trimStart / safeTrimDuration) * 100 : 0;
  const trimWidthPercent = safeTrimDuration > 0 ? ((trimEnd - trimStart) / safeTrimDuration) * 100 : 100;
  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setPlaybackDuration(data.durationSeconds ?? null);
    setTrimNotice('');
    audioRef.current?.load();
  }, [audioSource, data.durationSeconds]);

  useEffect(() => {
    if (!data.isAudioTrimMode || !resolvedPlaybackDuration || resolvedPlaybackDuration <= MIN_AUDIO_TRIM_SECONDS) {
      return;
    }
    const currentStart = typeof data.audioTrimStartSeconds === 'number' ? data.audioTrimStartSeconds : null;
    const currentEnd = typeof data.audioTrimEndSeconds === 'number' ? data.audioTrimEndSeconds : null;
    const nextEnd = Math.min(resolvedPlaybackDuration, Math.max(MIN_AUDIO_TRIM_SECONDS, resolvedPlaybackDuration * 0.5));
    if (currentStart === null || currentEnd === null) {
      updateNodeData(id, {
        audioTrimStartSeconds: 0,
        audioTrimEndSeconds: nextEnd,
      });
    }
  }, [data.audioTrimEndSeconds, data.audioTrimStartSeconds, data.isAudioTrimMode, id, resolvedPlaybackDuration, updateNodeData]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    let frameId = 0;
    const tick = () => {
      const audioElement = audioRef.current;
      if (audioElement) {
        setCurrentTime(audioElement.currentTime);
      }
      frameId = window.requestAnimationFrame(tick);
    };
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [isPlaying]);

  const processFile = useCallback(async (file: File) => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    const previewUrl = URL.createObjectURL(file);
    objectUrlRef.current = previewUrl;
    setObjectUrl(previewUrl);
    const prepared = await prepareAudioNodeDataFromFile(file);
    updateNodeData(id, {
      ...prepared,
      ...(useUploadFilenameAsNodeTitle ? { displayName: file.name } : {}),
      isGenerating: false,
      generationError: null,
      generationStartedAt: null,
      generationElapsedMs: null,
    });
  }, [id, updateNodeData, useUploadFilenameAsNodeTitle]);

  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!isAudioFile(file)) {
      return;
    }
    await processFile(file);
    event.target.value = '';
  }, [processFile]);

  const handleDrop = useCallback(async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const file = resolveDroppedAudioFile(event.dataTransfer);
    if (file) {
      await processFile(file);
    }
  }, [processFile]);

  const handleClick = useCallback(() => {
    setSelectedNode(id);
    if (!rawAudioSource && !isGenerating) {
      inputRef.current?.click();
    }
  }, [id, isGenerating, rawAudioSource, setSelectedNode]);

  const togglePlayback = useCallback(async () => {
    const audioElement = audioRef.current;
    if (!audioElement || !audioSource) {
      return;
    }
    if (audioElement.paused) {
      try {
        await audioElement.play();
      } catch {
        setIsPlaying(false);
      }
      return;
    }
    audioElement.pause();
  }, [audioSource]);

  const seekPlayback = useCallback((nextValue: string) => {
    const audioElement = audioRef.current;
    const nextTime = Number(nextValue);
    if (!audioElement || !Number.isFinite(nextTime)) {
      return;
    }
    audioElement.currentTime = nextTime;
    setCurrentTime(nextTime);
  }, []);

  const getWaveformSecondsFromPointer = useCallback((clientX: number) => {
    const rect = waveformRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) {
      return 0;
    }
    const ratio = clampNumber((clientX - rect.left) / rect.width, 0, 1);
    return ratio * safeTrimDuration;
  }, [safeTrimDuration]);

  const updateTrimRange = useCallback((nextStart: number, nextEnd: number) => {
    const boundedStart = clampNumber(nextStart, 0, Math.max(0, safeTrimDuration - MIN_AUDIO_TRIM_SECONDS));
    const boundedEnd = clampNumber(
      nextEnd,
      boundedStart + MIN_AUDIO_TRIM_SECONDS,
      safeTrimDuration
    );
    updateNodeData(id, {
      audioTrimStartSeconds: boundedStart,
      audioTrimEndSeconds: boundedEnd,
    });
  }, [id, safeTrimDuration, updateNodeData]);

  const beginTrimDrag = useCallback((
    mode: 'move' | 'start' | 'end',
    event: ReactPointerEvent<HTMLElement>
  ) => {
    if (!isAudioTrimMode) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const originSeconds = getWaveformSecondsFromPointer(event.clientX);
    const originStart = trimStart;
    const originEnd = trimEnd;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const nextSeconds = getWaveformSecondsFromPointer(moveEvent.clientX);
      const deltaSeconds = nextSeconds - originSeconds;
      if (mode === 'start') {
        updateTrimRange(
          clampNumber(originStart + deltaSeconds, 0, originEnd - MIN_AUDIO_TRIM_SECONDS),
          originEnd
        );
        return;
      }
      if (mode === 'end') {
        updateTrimRange(
          originStart,
          clampNumber(originEnd + deltaSeconds, originStart + MIN_AUDIO_TRIM_SECONDS, safeTrimDuration)
        );
        return;
      }
      const selectionLength = originEnd - originStart;
      const nextStart = clampNumber(originStart + deltaSeconds, 0, Math.max(0, safeTrimDuration - selectionLength));
      updateTrimRange(nextStart, nextStart + selectionLength);
    };

    const handlePointerUp = () => {
      if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
      }
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  }, [
    getWaveformSecondsFromPointer,
    isAudioTrimMode,
    safeTrimDuration,
    trimEnd,
    trimStart,
    updateTrimRange,
  ]);

  const cancelAudioTrim = useCallback(() => {
    updateNodeData(id, {
      isAudioTrimMode: false,
      audioTrimStartSeconds: null,
      audioTrimEndSeconds: null,
    });
    setTrimNotice('');
  }, [id, updateNodeData]);

  /** One undoable media-edit transaction: the slice lands as a durable, source-connected audio node. */
  const applyAudioTrim = useCallback(async () => {
    if (!canTrim || isTrimming) {
      return;
    }
    setIsTrimming(true);
    setTrimNotice('');
    try {
      await runNodeMediaEdit(id, { kind: 'audio.slice', startSeconds: trimStart, endSeconds: trimEnd });
      updateNodeData(id, {
        isAudioTrimMode: false,
        audioTrimStartSeconds: null,
        audioTrimEndSeconds: null,
      });
      setTrimNotice(t('mediaEdit.audioSliced'));
    } catch (error) {
      setTrimNotice(error instanceof MediaEditError ? t(`mediaEdit.errors.${error.code}`) : error instanceof Error ? error.message : String(error));
    } finally {
      setIsTrimming(false);
    }
  }, [canTrim, id, isTrimming, t, trimEnd, trimStart, updateNodeData]);


  return (
    <NodeFrame
      type={type as CanvasNodeType}
      selected={selected}
      icon={<Music2 />}
      title={resolvedTitle}
      onRename={(displayName) => updateNodeData(id, { displayName })}
      meta={resolvedPlaybackDuration ? formatAudioTime(resolvedPlaybackDuration) : undefined}
      status={isGenerating
        ? { kind: 'generating', startedAt: generationStartedAt }
        : hasGenerationError ? { kind: 'error', label: generationError } : null}
      badges={<>{finishedElapsed ? <span className="node-frame__badge" title={t('node.audioNode.generationElapsed')}>{finishedElapsed}</span> : null}{typeof data.batchId === 'string' && data.batchId && typeof data.batchIndex === 'number' && typeof data.batchTotal === 'number' && data.batchTotal > 1 ? <BatchStackControl nodeId={id} batchId={data.batchId} index={data.batchIndex+1} total={data.batchTotal} collapsed={data.batchCollapsed===true} selected={Boolean(selected)} /> : null}</>}
      width={resolvedWidth}
      height={resolvedHeight}
      resize={{ minWidth: AUDIO_NODE_MIN_WIDTH, minHeight: AUDIO_NODE_MIN_HEIGHT, maxWidth: AUDIO_NODE_MAX_WIDTH, maxHeight: AUDIO_NODE_MAX_HEIGHT }}
      className="group"
      bodyStyle={{ padding: 0 }}
    >
      <div
        className={`relative flex h-full w-full flex-col justify-center overflow-hidden p-3 ${hasGenerationError ? 'bg-danger/12' : 'bg-(--canvas-node-media-bg)'}`}
        onClick={handleClick}
        onDrop={handleDrop}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {rawAudioSource ? (
          <div className="flex h-full min-h-0 flex-col justify-center gap-2.5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-(--canvas-node-field-border) bg-(--canvas-node-button-bg) text-accent">
                <Music2 className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text-dark">{resolvedTitle}</div>
                <div className="mt-0.5 truncate text-xs text-text-muted">
                  {sourceAudioModeLabel
                    ? `${sourceAudioModeLabel}${sourceReferenceAudioTitle ? ` · ${sourceReferenceAudioTitle}` : ''}`
                    : sourceReferenceAudioTitle
                      ? `参考音频：${sourceReferenceAudioTitle}`
                      : data.sourceFileName || data.sourceVoiceId || t('node.audioNode.ready')}
                </div>
              </div>
              <UiIconButton
                variant="secondary"
                className="nodrag nowheel"
                title={t('node.audioNode.replace') as string}
                aria-label={t('node.audioNode.replace') as string}
                onClick={(event) => {
                  event.stopPropagation();
                  inputRef.current?.click();
                }}
              >
                <RefreshCw className="h-4 w-4" />
              </UiIconButton>
            </div>
            <div
              className="nodrag nowheel flex items-center gap-3 rounded-lg border border-(--canvas-node-field-border) bg-(--canvas-node-field-bg) px-3 py-2"
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <UiIconButton
                variant="secondary"
                className="text-text-dark"
                title={isPlaying ? '暂停' : '播放'}
                aria-label={isPlaying ? '暂停音频' : '播放音频'}
                onClick={(event) => {
                  event.stopPropagation();
                  void togglePlayback();
                }}
              >
                {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-px" />}
              </UiIconButton>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div ref={waveformRef} className="relative h-8 w-full rounded-md has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-accent/60">
                  {!isAudioTrimMode ? (
                    <input
                      type="range"
                      min={0}
                      max={Math.max(resolvedPlaybackDuration ?? 0, currentTime, 0.01)}
                      step={0.01}
                      value={Math.min(currentTime, resolvedPlaybackDuration ?? currentTime)}
                      aria-label="音频播放进度"
                      className="ui-range nodrag nowheel absolute inset-0 z-30 h-full w-full cursor-pointer bg-transparent opacity-0"
                      onChange={(event) => seekPlayback(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                    />
                  ) : null}
                  <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-md bg-(--hover)">
                    <div className="absolute inset-0 flex items-center gap-[2px] px-1">
                      {AUDIO_WAVEFORM_BARS.map((barHeight, index) => (
                        <span
                          key={index}
                          className="relative z-10 min-w-[2px] flex-1 rounded-full bg-text-subtle/45"
                          style={{ height: `${barHeight}%` }}
                        />
                      ))}
                    </div>
                    <div
                      className="absolute inset-y-0 left-0 overflow-hidden rounded-md bg-(--hover)"
                      style={{ width: `${playbackProgress * 100}%` }}
                    >
                      <div
                        className="absolute inset-0 flex items-center gap-[2px] px-1"
                        style={{ width: `${playbackProgress > 0 ? 100 / playbackProgress : 0}%` }}
                      >
                        {AUDIO_WAVEFORM_BARS.map((barHeight, index) => (
                          <span
                            key={index}
                            className="relative z-20 min-w-[2px] flex-1 rounded-full bg-text-dark/85"
                            style={{ height: `${barHeight}%` }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                  {isAudioTrimMode ? (
                    <div className="absolute inset-0 z-40">
                      <div
                        className="absolute inset-y-0 cursor-grab rounded-md border border-accent/80 bg-accent/18 shadow-[0_0_0_999px_var(--scrim)] active:cursor-grabbing"
                        style={{ left: `${trimLeftPercent}%`, width: `${trimWidthPercent}%` }}
                        onPointerDown={(event) => beginTrimDrag('move', event)}
                      >
                        <button
                          type="button"
                          aria-label="调整裁剪开始位置"
                          className="absolute -left-1.5 top-1/2 h-7 w-3 -translate-y-1/2 cursor-ew-resize rounded-full border border-accent/80 bg-(--canvas-node-menu-bg) shadow-lg transition-colors hover:border-accent hover:bg-(--canvas-node-menu-hover) active:bg-(--press)"
                          onPointerDown={(event) => beginTrimDrag('start', event)}
                        />
                        <button
                          type="button"
                          aria-label="调整裁剪结束位置"
                          className="absolute -right-1.5 top-1/2 h-7 w-3 -translate-y-1/2 cursor-ew-resize rounded-full border border-accent/80 bg-(--canvas-node-menu-bg) shadow-lg transition-colors hover:border-accent hover:bg-(--canvas-node-menu-hover) active:bg-(--press)"
                          onPointerDown={(event) => beginTrimDrag('end', event)}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center justify-between gap-2 text-[10px] leading-none text-text-muted">
                  <span>{isAudioTrimMode ? formatAudioTime(trimStart) : formatAudioTime(currentTime)}</span>
                  <span>{isAudioTrimMode ? formatAudioTime(trimEnd) : formatAudioTime(resolvedPlaybackDuration)}</span>
                </div>
              </div>
            </div>
            {isAudioTrimMode ? (
              <div
                className="nodrag nowheel flex items-center gap-2 rounded-lg border border-(--canvas-node-field-border) bg-(--canvas-node-field-bg) px-2 py-1.5"
                onClick={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <Scissors className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">
                  {isTrimming ? '裁剪中...' : `保留 ${formatAudioTime(trimEnd - trimStart)}`}
                </span>
                <UiIconButton
                  size="sm"
                  variant="secondary"
                  className="h-6 w-6"
                  title="取消裁剪"
                  aria-label="取消裁剪"
                  disabled={isTrimming}
                  onClick={(event) => {
                    event.stopPropagation();
                    cancelAudioTrim();
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </UiIconButton>
                <UiIconButton
                  size="sm"
                  className="h-6 w-6 border border-accent/60 bg-accent/20 text-accent hover:bg-accent/30"
                  title="生成裁剪音频"
                  aria-label="生成裁剪音频"
                  disabled={isTrimming}
                  onClick={(event) => {
                    event.stopPropagation();
                    void applyAudioTrim();
                  }}
                >
                  {isTrimming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                </UiIconButton>
              </div>
            ) : null}
            {trimNotice ? (
              <div className="truncate px-1 text-[10px] leading-none text-text-muted">{trimNotice}</div>
            ) : null}
            <audio
              ref={audioRef}
              src={audioSource ?? undefined}
              className="hidden"
              preload="metadata"
              onLoadedMetadata={(event) => {
                const duration = event.currentTarget.duration;
                if (Number.isFinite(duration) && duration > 0) {
                  setPlaybackDuration(duration);
                  updateNodeData(id, { durationSeconds: duration });
                }
              }}
              onTimeUpdate={(event) => {
                if (!isPlaying) {
                  setCurrentTime(event.currentTarget.currentTime);
                }
              }}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => {
                setIsPlaying(false);
                setCurrentTime(audioRef.current?.duration ?? 0);
              }}
            />
          </div>
        ) : hasGenerationError ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-danger">
            <AlertTriangle className="h-7 w-7 opacity-90" />
            <span className="text-center text-[12px] font-semibold leading-5 text-danger">
              {t('node.audioNode.generationFailed')}
            </span>
            <span className="max-h-[72px] overflow-y-auto wrap-break-word text-center text-[11px] leading-5 text-danger/90">
              {referenceFailure ? t('reference.needsPublicUrl', { slotKey: referenceFailure.slotKey }) : generationError}
            </span>
            {referenceFailure ? <GenerationReferenceRetry nodeId={id} failure={referenceFailure} /> : null}
          </div>
        ) : (
          <div className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 text-text-muted/85">
            {isGenerating ? (
              <Loader2 className="h-7 w-7 animate-spin opacity-70" />
            ) : (
              <Upload className="h-7 w-7 opacity-60" />
            )}
            <span className="px-3 text-center text-[12px] leading-6">
              {isGenerating ? t('node.audioNode.waitingResult') : t('node.audioNode.empty')}
            </span>
          </div>
        )}

        {isGenerating && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute inset-0 bg-bg/55" />
            <div
              className="absolute left-0 top-0 h-full w-full origin-left bg-linear-to-r from-text-dark/30 to-text-dark/5 transition-transform duration-100 ease-linear"
              style={{ transform: `scaleX(${progress})` }}
            />
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleFileChange}
      />

    </NodeFrame>
  );
});

AudioNode.displayName = 'AudioNode';
