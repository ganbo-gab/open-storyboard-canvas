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
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Check, Loader2, Music2, Pause, Play, RefreshCw, Scissors, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  type AudioNodeData,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import { isNodeUsingDefaultDisplayName, resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { isAudioFile, resolveDroppedAudioFile } from '@/features/canvas/application/imageDragDrop';
import { prepareAudioNodeDataFromFile } from '@/features/canvas/application/audioUpload';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { formatGenerationElapsedMs } from '@/features/canvas/ui/generationElapsed';
import { loadAudioSourceDataUrl } from '@/commands/image';
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

function resolveNodeDimension(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    return Math.round(value);
  }
  return fallback;
}

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

function sanitizeAudioFileStem(raw: string): string {
  const compact = raw.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '').replace(/\s+/g, '-');
  return compact.replace(/^\.+|\.+$/g, '') || 'audio';
}

async function fetchAudioBlob(source: string): Promise<Blob> {
  if (/^data:audio\//i.test(source.trim())) {
    return await (await fetch(source)).blob();
  }
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Audio download failed: HTTP ${response.status}`);
  }
  return await response.blob();
}

async function readAudioArrayBuffer(source: string, displaySource: string): Promise<ArrayBuffer> {
  try {
    return await (await fetchAudioBlob(displaySource)).arrayBuffer();
  } catch (error) {
    console.warn('Failed to fetch display audio source, falling back to native loader', error);
    const dataUrl = await loadAudioSourceDataUrl(source);
    return await (await fetchAudioBlob(dataUrl)).arrayBuffer();
  }
}

function audioBufferToWavDataUrl(buffer: AudioBuffer, startSeconds: number, endSeconds: number): string {
  const sampleRate = buffer.sampleRate;
  const channelCount = buffer.numberOfChannels;
  const startFrame = Math.max(0, Math.min(buffer.length, Math.floor(startSeconds * sampleRate)));
  const endFrame = Math.max(startFrame + 1, Math.min(buffer.length, Math.ceil(endSeconds * sampleRate)));
  const frameCount = endFrame - startFrame;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);
  let offset = 0;
  const writeString = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset, text.charCodeAt(index));
      offset += 1;
    }
  };

  writeString('RIFF');
  view.setUint32(offset, 36 + dataSize, true); offset += 4;
  writeString('WAVE');
  writeString('fmt ');
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2;
  view.setUint16(offset, channelCount, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * blockAlign, true); offset += 4;
  view.setUint16(offset, blockAlign, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;
  writeString('data');
  view.setUint32(offset, dataSize, true); offset += 4;

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
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
  const audioSource = useMemo(
    () => (rawAudioSource ? resolveImageDisplayUrl(rawAudioSource) : null),
    [rawAudioSource]
  );
  const generationError = typeof data.generationError === 'string' ? data.generationError.trim() : '';
  const hasGenerationError = !isGenerating && !audioSource && generationError.length > 0;
  const generationStartedAt = typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null;
  const generationDurationMs = typeof data.generationDurationMs === 'number' ? data.generationDurationMs : 180000;
  const resolvedWidth = resolveNodeDimension(width, AUDIO_NODE_DEFAULT_WIDTH);
  const resolvedHeight = Math.max(
    resolveNodeDimension(height, AUDIO_NODE_DEFAULT_HEIGHT),
    AUDIO_NODE_MIN_HEIGHT
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
  const liveGenerationElapsedMs = isGenerating && generationStartedAt !== null
    ? Math.max(0, now - generationStartedAt)
    : data.generationElapsedMs;
  const generationElapsedText = formatGenerationElapsedMs(liveGenerationElapsedMs);
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
  const suggestedAudioStem = sanitizeAudioFileStem(
    data.generatedFileName
    || data.sourceFileName
    || data.displayName
    || `audio-${id}`
  );

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
    if (!audioSource && !isGenerating) {
      inputRef.current?.click();
    }
  }, [audioSource, id, isGenerating, setSelectedNode]);

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

  const applyAudioTrim = useCallback(async () => {
    if (!rawAudioSource || !audioSource || !canTrim || isTrimming) {
      return;
    }
    setIsTrimming(true);
    setTrimNotice('');
    let context: AudioContext | null = null;
    try {
      const arrayBuffer = await readAudioArrayBuffer(rawAudioSource, audioSource);
      const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error('当前环境不支持音频裁剪');
      }
      context = new AudioContextCtor();
      const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
      const finalEnd = Math.min(trimEnd, decoded.duration);
      const finalStart = Math.min(trimStart, Math.max(0, finalEnd - MIN_AUDIO_TRIM_SECONDS));
      const trimmedDataUrl = audioBufferToWavDataUrl(decoded, finalStart, finalEnd);
      await context.close();
      context = null;

      const canvasState = useCanvasStore.getState();
      const resultNodeId = canvasState.addNode(
        CANVAS_NODE_TYPES.audio,
        canvasState.findNodePosition(id, 360, 170),
        {
          displayName: `${data.displayName || '音频'} · 裁剪`,
          audioUrl: trimmedDataUrl,
          localAudioUrl: trimmedDataUrl,
          sourceFileName: `${suggestedAudioStem}-trim.wav`,
          durationSeconds: Math.max(1, Math.round(finalEnd - finalStart)),
          sourcePrompt: data.sourcePrompt,
          sourceModelId: data.sourceModelId,
          sourceAudioMode: 'trim',
        }
      );
      canvasState.addEdge(id, resultNodeId);
      updateNodeData(id, {
        isAudioTrimMode: false,
        audioTrimStartSeconds: null,
        audioTrimEndSeconds: null,
      });
      setTrimNotice('已生成裁剪音频');
    } catch (error) {
      console.error('Failed to trim audio', error);
      setTrimNotice(error instanceof Error ? error.message : '音频裁剪失败');
    } finally {
      if (context) {
        await context.close().catch(() => undefined);
      }
      setIsTrimming(false);
    }
  }, [
    audioSource,
    canTrim,
    data.displayName,
    data.sourceModelId,
    data.sourcePrompt,
    id,
    isTrimming,
    rawAudioSource,
    suggestedAudioStem,
    trimEnd,
    trimStart,
    updateNodeData,
  ]);

  return (
    <div
      className={`
        group relative overflow-visible rounded-[var(--node-radius)] border bg-[var(--canvas-node-bg)] p-0 shadow-[var(--canvas-node-shadow)] transition-colors duration-150
        ${hasGenerationError
          ? (selected
            ? 'border-red-400 shadow-[0_0_0_1px_rgba(248,113,113,0.42)]'
            : 'border-red-500/70 bg-[rgba(127,29,29,0.12)] hover:border-red-400/80')
          : selected
            ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
            : 'border-[var(--canvas-node-border)] hover:border-[var(--canvas-node-border-hover)]'}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={handleClick}
      onDrop={handleDrop}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Music2 className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
        rightSlot={generationElapsedText ? (
          <span
            className="rounded-full bg-[rgba(15,23,42,0.72)] px-2 py-[1px] text-[10px] font-medium leading-tight text-white"
            title={t('node.audioNode.generationElapsed') as string}
          >
            {generationElapsedText}
          </span>
        ) : null}
      />

      <div className={`relative flex h-full w-full flex-col justify-center overflow-hidden rounded-[var(--node-radius)] p-3 ${hasGenerationError ? 'bg-[rgba(127,29,29,0.2)]' : 'bg-[var(--canvas-node-media-bg)]'}`}>
        {audioSource ? (
          <div className="flex h-full min-h-0 flex-col justify-center gap-2.5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-accent">
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
              <button
                type="button"
                className="nodrag nowheel inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-text-muted transition-colors hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)] hover:text-text-dark"
                title={t('node.audioNode.replace') as string}
                onClick={(event) => {
                  event.stopPropagation();
                  inputRef.current?.click();
                }}
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
            <div
              className="nodrag nowheel flex items-center gap-3 rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] px-3 py-2"
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-text-dark transition-colors hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]"
                title={isPlaying ? '暂停' : '播放'}
                aria-label={isPlaying ? '暂停音频' : '播放音频'}
                onClick={(event) => {
                  event.stopPropagation();
                  void togglePlayback();
                }}
              >
                {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-[1px]" />}
              </button>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div ref={waveformRef} className="relative h-8 w-full">
                  {!isAudioTrimMode ? (
                    <input
                      type="range"
                      min={0}
                      max={Math.max(resolvedPlaybackDuration ?? 0, currentTime, 0.01)}
                      step={0.01}
                      value={Math.min(currentTime, resolvedPlaybackDuration ?? currentTime)}
                      aria-label="音频播放进度"
                      className="nodrag nowheel absolute inset-0 z-30 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0"
                      onChange={(event) => seekPlayback(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                    />
                  ) : null}
                  <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-md bg-[rgba(148,163,184,0.08)]">
                    <div className="absolute inset-0 flex items-center gap-[2px] px-1">
                      {AUDIO_WAVEFORM_BARS.map((barHeight, index) => (
                        <span
                          key={index}
                          className="relative z-10 min-w-[2px] flex-1 rounded-full bg-slate-600/45"
                          style={{ height: `${barHeight}%` }}
                        />
                      ))}
                    </div>
                    <div
                      className="absolute inset-y-0 left-0 overflow-hidden rounded-md bg-slate-500/10"
                      style={{ width: `${playbackProgress * 100}%` }}
                    >
                      <div
                        className="absolute inset-0 flex items-center gap-[2px] px-1"
                        style={{ width: `${playbackProgress > 0 ? 100 / playbackProgress : 0}%` }}
                      >
                        {AUDIO_WAVEFORM_BARS.map((barHeight, index) => (
                          <span
                            key={index}
                            className="relative z-20 min-w-[2px] flex-1 rounded-full bg-slate-300/85"
                            style={{ height: `${barHeight}%` }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                  {isAudioTrimMode ? (
                    <div className="absolute inset-0 z-40">
                      <div
                        className="absolute inset-y-0 cursor-grab rounded-md border border-accent/80 bg-accent/18 shadow-[0_0_0_999px_rgba(0,0,0,0.34)] active:cursor-grabbing"
                        style={{ left: `${trimLeftPercent}%`, width: `${trimWidthPercent}%` }}
                        onPointerDown={(event) => beginTrimDrag('move', event)}
                      >
                        <button
                          type="button"
                          aria-label="调整裁剪开始位置"
                          className="absolute -left-1.5 top-1/2 h-7 w-3 -translate-y-1/2 cursor-ew-resize rounded-full border border-accent/80 bg-[var(--canvas-node-menu-bg)] shadow-lg"
                          onPointerDown={(event) => beginTrimDrag('start', event)}
                        />
                        <button
                          type="button"
                          aria-label="调整裁剪结束位置"
                          className="absolute -right-1.5 top-1/2 h-7 w-3 -translate-y-1/2 cursor-ew-resize rounded-full border border-accent/80 bg-[var(--canvas-node-menu-bg)] shadow-lg"
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
                className="nodrag nowheel flex items-center gap-2 rounded-lg border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-field-bg)] px-2 py-1.5"
                onClick={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <Scissors className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">
                  {isTrimming ? '裁剪中...' : `保留 ${formatAudioTime(trimEnd - trimStart)}`}
                </span>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-button-bg)] text-text-muted transition-colors hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-50"
                  title="取消裁剪"
                  disabled={isTrimming}
                  onClick={(event) => {
                    event.stopPropagation();
                    cancelAudioTrim();
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-accent/60 bg-accent/20 text-white transition-colors hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
                  title="生成裁剪音频"
                  disabled={isTrimming}
                  onClick={(event) => {
                    event.stopPropagation();
                    void applyAudioTrim();
                  }}
                >
                  {isTrimming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                </button>
              </div>
            ) : null}
            {trimNotice ? (
              <div className="truncate px-1 text-[10px] leading-none text-text-muted">{trimNotice}</div>
            ) : null}
            <audio
              ref={audioRef}
              src={audioSource}
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
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-red-700 dark:text-red-300">
            <AlertTriangle className="h-7 w-7 opacity-90" />
            <span className="text-center text-[12px] font-semibold leading-5 text-red-800 dark:text-red-200">
              {t('node.audioNode.generationFailed')}
            </span>
            <span className="max-h-[72px] overflow-y-auto break-words text-center text-[11px] leading-5 text-red-800/90 dark:text-red-200/90">
              {generationError}
            </span>
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
            <div className="absolute inset-0 bg-bg-dark/55" />
            <div
              className="absolute left-0 top-0 h-full w-full origin-left bg-gradient-to-r from-[rgba(255,255,255,0.34)] to-[rgba(255,255,255,0.05)] transition-transform duration-100 ease-linear"
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

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle
        minWidth={AUDIO_NODE_MIN_WIDTH}
        minHeight={AUDIO_NODE_MIN_HEIGHT}
        maxWidth={AUDIO_NODE_MAX_WIDTH}
        maxHeight={AUDIO_NODE_MAX_HEIGHT}
      />
    </div>
  );
});

AudioNode.displayName = 'AudioNode';
