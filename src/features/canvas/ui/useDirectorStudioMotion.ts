import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  BlueprintActionPose,
  BlueprintBodyControls,
  BlueprintItem,
  BlueprintNodeData,
  DirectorActionClip,
  DirectorMotionProjectV1,
  DirectorMotionVector3,
} from '@/features/canvas/domain/canvasNodes';
import {
  DIRECTOR_STATIC_POSE_MAP,
  createClipFromActionTrack,
  createDirectorCameraPresetTrack,
  createDirectorMotionId,
  createObjectKeyframeFromItem,
  deleteDirectorMotionClip,
  normalizeDirectorMotionProject,
  sampleNormalizedDirectorMotion,
  upsertDirectorKeyframe,
  type DirectorCameraPresetId,
} from '@/features/canvas/application/directorMotion';
import {
  DirectorRecordingCancelledError,
  downloadDirectorVideo,
  recordDirectorVideo,
  selectDirectorVideoFormat,
  type DirectorRecordedVideo,
  type DirectorRecordingProgress,
  type DirectorVideoFps,
  type DirectorVideoResolution,
} from '@/features/canvas/application/directorVideoRecording';
import type {
  BlueprintSceneHandle,
  DirectorMotionRouteSelection,
  DirectorSceneCameraSnapshot,
} from './BlueprintScene';
import type { DirectorKeyframePatch, DirectorKeyframeSelection } from './DirectorMotionInspector';

type Options = {
  data: BlueprintNodeData;
  selectedItem: BlueprintItem | null;
  editorRef: MutableRefObject<BlueprintSceneHandle | null>;
  onUpdateNodeData: (patch: Partial<BlueprintNodeData>) => void;
  onUpdateItemAction: (item: BlueprintItem, action: string) => void;
  onAddVideoToCanvas?: (video: DirectorRecordedVideo) => Promise<boolean | void> | boolean | void;
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function useDirectorStudioMotion({
  data,
  selectedItem,
  editorRef,
  onUpdateNodeData,
  onUpdateItemAction,
  onAddVideoToCanvas,
}: Options) {
  const { t } = useTranslation();
  const [timelineOpen, setTimelineOpen] = useState(true);
  const [motionTime, setMotionTime] = useState(0);
  const [motionPlaying, setMotionPlaying] = useState(false);
  const [motionSelection, setMotionSelection] = useState<DirectorKeyframeSelection | null>(null);
  const [motionShowRoutes, setMotionShowRoutes] = useState(true);
  const [motionPreviewMode, setMotionPreviewMode] = useState<'route' | 'shot'>('shot');
  const [pilotActive, setPilotActive] = useState(false);
  const [pilotTargetId, setPilotTargetId] = useState<string | null>(null);
  const [actionLibraryOpen, setActionLibraryOpen] = useState(false);
  const [videoExportOpen, setVideoExportOpen] = useState(false);
  const [videoExportResolution, setVideoExportResolution] = useState<DirectorVideoResolution>('720p');
  const [videoExportFps, setVideoExportFps] = useState<DirectorVideoFps>(24);
  const [videoExportRecording, setVideoExportRecording] = useState(false);
  const [videoExportProgress, setVideoExportProgress] = useState<DirectorRecordingProgress | null>(null);
  const [videoExportError, setVideoExportError] = useState<string | null>(null);
  const [videoExportResult, setVideoExportResult] = useState<DirectorRecordedVideo | null>(null);
  const videoExportAbortRef = useRef<AbortController | null>(null);
  const latestDataRef = useRef(data);
  latestDataRef.current = data;

  const motionProject = useMemo(() => normalizeDirectorMotionProject(data.motionProject), [data.motionProject]);
  const availableVideoFormat = useMemo(() => selectDirectorVideoFormat(), []);

  useEffect(() => {
    setMotionTime((value) => Math.min(value, motionProject.durationSeconds));
  }, [motionProject.durationSeconds]);

  const updateMotionProject = useCallback((updater: (project: DirectorMotionProjectV1) => DirectorMotionProjectV1) => {
    const nextProject = updater(normalizeDirectorMotionProject(latestDataRef.current.motionProject));
    onUpdateNodeData({ motionProject: normalizeDirectorMotionProject(nextProject) });
  }, [onUpdateNodeData]);

  const patchMotionKeyframe = useCallback((selection: DirectorKeyframeSelection, patch: DirectorKeyframePatch) => {
    updateMotionProject((project) => {
      const patchTrack = <T extends { id: string; time: number }>(track: T[]): T[] => track
        .map((keyframe) => keyframe.id === selection.keyframeId ? { ...keyframe, ...patch } as T : keyframe)
        .sort((a, b) => a.time - b.time);
      if (selection.kind === 'camera') return { ...project, cameraTrack: patchTrack(project.cameraTrack) };
      if (selection.kind === 'object') return { ...project, objectTracks: { ...project.objectTracks, [selection.trackId]: patchTrack(project.objectTracks[selection.trackId] ?? []) } };
      return { ...project, actionTracks: { ...project.actionTracks, [selection.trackId]: patchTrack(project.actionTracks[selection.trackId] ?? []) } };
    });
  }, [updateMotionProject]);

  const moveMotionKeyframe = useCallback((selection: DirectorKeyframeSelection, time: number) => {
    patchMotionKeyframe(selection, { time: Math.min(motionProject.durationSeconds, Math.max(0, time)) });
  }, [motionProject.durationSeconds, patchMotionKeyframe]);

  const duplicateMotionKeyframe = useCallback((selection: DirectorKeyframeSelection) => {
    updateMotionProject((project) => {
      const duplicateTrack = <T extends { id: string; time: number }>(track: T[]): T[] => {
        const source = track.find((keyframe) => keyframe.id === selection.keyframeId);
        if (!source) return track;
        return upsertDirectorKeyframe(track, { ...cloneJson(source), id: createDirectorMotionId('duplicate'), time: Math.min(project.durationSeconds, source.time + 0.5) });
      };
      if (selection.kind === 'camera') return { ...project, cameraTrack: duplicateTrack(project.cameraTrack) };
      if (selection.kind === 'object') return { ...project, objectTracks: { ...project.objectTracks, [selection.trackId]: duplicateTrack(project.objectTracks[selection.trackId] ?? []) } };
      return { ...project, actionTracks: { ...project.actionTracks, [selection.trackId]: duplicateTrack(project.actionTracks[selection.trackId] ?? []) } };
    });
  }, [updateMotionProject]);

  const deleteMotionKeyframe = useCallback((selection: DirectorKeyframeSelection) => {
    updateMotionProject((project) => {
      if (selection.kind === 'camera') return { ...project, cameraTrack: project.cameraTrack.filter((keyframe) => keyframe.id !== selection.keyframeId) };
      if (selection.kind === 'object') return { ...project, objectTracks: { ...project.objectTracks, [selection.trackId]: (project.objectTracks[selection.trackId] ?? []).filter((keyframe) => keyframe.id !== selection.keyframeId) } };
      return { ...project, actionTracks: { ...project.actionTracks, [selection.trackId]: (project.actionTracks[selection.trackId] ?? []).filter((keyframe) => keyframe.id !== selection.keyframeId) } };
    });
    setMotionSelection(null);
  }, [updateMotionProject]);

  const saveCameraKeyframe = useCallback((snapshot: DirectorSceneCameraSnapshot) => {
    updateMotionProject((project) => {
      const existing = project.cameraTrack.find((keyframe) => Math.abs(keyframe.time - motionTime) <= 0.025);
      return {
        ...project,
        cameraTrack: upsertDirectorKeyframe(project.cameraTrack, {
          id: existing?.id ?? createDirectorMotionId('camera'),
          time: motionTime,
          easing: existing?.easing ?? 'smooth',
          position: snapshot.position,
          target: snapshot.target,
          fov: snapshot.fov,
          trackTargetId: snapshot.trackTargetId ?? pilotTargetId ?? null,
          trackTargetBodyPart: snapshot.trackTargetBodyPart ?? null,
        }),
      };
    });
  }, [motionTime, pilotTargetId, updateMotionProject]);

  const addCameraMotionKeyframe = useCallback(() => {
    const snapshot = editorRef.current?.getCameraSnapshot();
    if (snapshot) saveCameraKeyframe(snapshot);
  }, [editorRef, saveCameraKeyframe]);

  const addObjectMotionKeyframe = useCallback((itemId: string) => {
    const item = latestDataRef.current.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    updateMotionProject((project) => ({ ...project, objectTracks: { ...project.objectTracks, [itemId]: upsertDirectorKeyframe(project.objectTracks[itemId] ?? [], createObjectKeyframeFromItem(item, motionTime)) } }));
  }, [motionTime, updateMotionProject]);

  const addActionMotionKeyframe = useCallback((itemId: string, state?: { poseId?: string; actionId?: string; clipId?: string; pose?: BlueprintActionPose; bodyControls?: BlueprintBodyControls }) => {
    const item = latestDataRef.current.items.find((candidate) => candidate.id === itemId);
    if (!item || item.category !== 'person') return;
    const action = {
      ...(state ?? {
        poseId: item.action ?? undefined,
        pose: item.action ? DIRECTOR_STATIC_POSE_MAP[item.action] ?? latestDataRef.current.customActionPoses?.[item.action] : undefined,
      }),
      bodyControls: cloneJson(state?.bodyControls ?? item.bodyControls ?? {}),
    };
    updateMotionProject((project) => ({
      ...project,
      actionTracks: { ...project.actionTracks, [itemId]: upsertDirectorKeyframe(project.actionTracks[itemId] ?? [], { id: createDirectorMotionId('action'), time: motionTime, easing: 'smooth', ...action }) },
    }));
  }, [motionTime, updateMotionProject]);

  const updateMotionDuration = useCallback((duration: number) => {
    const nextDuration = Math.min(30, Math.max(0.5, duration));
    updateMotionProject((project) => ({
      ...project,
      durationSeconds: nextDuration,
      cameraTrack: project.cameraTrack.map((keyframe) => ({ ...keyframe, time: Math.min(nextDuration, keyframe.time) })),
      objectTracks: Object.fromEntries(Object.entries(project.objectTracks).map(([id, track]) => [id, track.map((keyframe) => ({ ...keyframe, time: Math.min(nextDuration, keyframe.time) }))])),
      actionTracks: Object.fromEntries(Object.entries(project.actionTracks).map(([id, track]) => [id, track.map((keyframe) => ({ ...keyframe, time: Math.min(nextDuration, keyframe.time) }))])),
    }));
    setMotionTime((time) => Math.min(time, nextDuration));
  }, [updateMotionProject]);

  const applyMotionActionState = useCallback((state: { poseId?: string; actionId?: string; clipId?: string; pose?: BlueprintActionPose; bodyControls?: BlueprintBodyControls }) => {
    if (!selectedItem || selectedItem.category !== 'person') return;
    onUpdateItemAction(selectedItem, state.poseId ?? state.actionId ?? state.clipId ?? '');
    addActionMotionKeyframe(selectedItem.id, state);
  }, [addActionMotionKeyframe, onUpdateItemAction, selectedItem]);

  const saveMotionClip = useCallback((name: string) => {
    if (!selectedItem || selectedItem.category !== 'person') return;
    const clip = createClipFromActionTrack(name, motionProject.actionTracks[selectedItem.id] ?? []);
    if (clip) updateMotionProject((project) => ({ ...project, customClips: [...project.customClips, clip] }));
  }, [motionProject.actionTracks, selectedItem, updateMotionProject]);

  const updateMotionClip = useCallback((clipId: string, patch: Partial<DirectorActionClip>) => {
    updateMotionProject((project) => ({ ...project, customClips: project.customClips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip) }));
  }, [updateMotionProject]);

  const duplicateMotionClip = useCallback((clipId: string) => {
    updateMotionProject((project) => {
      const source = project.customClips.find((clip) => clip.id === clipId);
      if (!source) return project;
      return { ...project, customClips: [...project.customClips, { ...cloneJson(source), id: createDirectorMotionId('clip'), name: `${source.name} ${t('directorStudio.defaultLabels.copySuffix')}` }] };
    });
  }, [t, updateMotionProject]);

  const deleteMotionClip = useCallback((clipId: string) => {
    updateMotionProject((project) => deleteDirectorMotionClip(project, clipId));
    setMotionSelection((selection) => {
      if (selection?.kind !== 'action') return selection;
      const selectedKeyframe = motionProject.actionTracks[selection.trackId]
        ?.find((keyframe) => keyframe.id === selection.keyframeId);
      return selectedKeyframe?.clipId === clipId ? null : selection;
    });
  }, [motionProject.actionTracks, updateMotionProject]);

  const applyCameraPreset = useCallback((presetId: DirectorCameraPresetId) => {
    const track = createDirectorCameraPresetTrack(presetId, motionProject.durationSeconds, selectedItem);
    updateMotionProject((project) => ({ ...project, cameraTrack: track }));
    setMotionSelection(null);
  }, [motionProject.durationSeconds, selectedItem, updateMotionProject]);

  const setMotionTimeAndApply = useCallback((time: number) => {
    const nextTime = Math.min(motionProject.durationSeconds, Math.max(0, time));
    setMotionTime(nextTime);
    editorRef.current?.applyMotionFrame(sampleNormalizedDirectorMotion(motionProject, nextTime, latestDataRef.current.items), motionPreviewMode);
  }, [editorRef, motionPreviewMode, motionProject]);

  const selectMotionRouteKeyframe = useCallback((selection: DirectorMotionRouteSelection, time: number) => {
    setMotionSelection(selection);
    setMotionTimeAndApply(time);
  }, [setMotionTimeAndApply]);

  const moveMotionRouteKeyframe = useCallback((
    selection: DirectorMotionRouteSelection,
    position: DirectorMotionVector3,
  ) => {
    patchMotionKeyframe(selection, { position });
  }, [patchMotionKeyframe]);

  const insertMotionRouteKeyframe = useCallback((
    kind: DirectorMotionRouteSelection['kind'],
    trackId: string,
    time: number,
    position: DirectorMotionVector3,
  ) => {
    const keyframeId = createDirectorMotionId(`${kind}-route`);
    updateMotionProject((project) => {
      const nextTime = Math.min(project.durationSeconds, Math.max(0, time));
      const sampled = sampleNormalizedDirectorMotion(project, nextTime, latestDataRef.current.items);
      if (kind === 'camera') {
        const fallback = editorRef.current?.getCameraSnapshot();
        const camera = sampled.camera ?? fallback;
        if (!camera) return project;
        return {
          ...project,
          cameraTrack: upsertDirectorKeyframe(project.cameraTrack, {
            id: keyframeId,
            time: nextTime,
            easing: 'smooth',
            position,
            target: camera.target,
            fov: camera.fov,
            trackTargetId: camera.trackTargetId ?? null,
            trackTargetBodyPart: camera.trackTargetBodyPart ?? null,
          }),
        };
      }
      const object = sampled.objects[trackId];
      if (!object) return project;
      return {
        ...project,
        objectTracks: {
          ...project.objectTracks,
          [trackId]: upsertDirectorKeyframe(project.objectTracks[trackId] ?? [], {
            id: keyframeId,
            time: nextTime,
            easing: 'smooth',
            position,
            rotation: object.rotation,
            scale: object.scale,
            orientToPath: true,
          }),
        },
      };
    });
    setMotionSelection({ kind, trackId, keyframeId });
    setMotionTime(Math.min(motionProject.durationSeconds, Math.max(0, time)));
  }, [editorRef, motionProject.durationSeconds, updateMotionProject]);

  const setPreviewModeAndApply = useCallback((mode: 'route' | 'shot') => {
    setMotionPreviewMode(mode);
    editorRef.current?.applyMotionFrame(sampleNormalizedDirectorMotion(motionProject, motionTime, latestDataRef.current.items), mode);
  }, [editorRef, motionProject, motionTime]);

  useEffect(() => {
    editorRef.current?.applyMotionFrame(sampleNormalizedDirectorMotion(motionProject, motionTime, latestDataRef.current.items), motionPreviewMode);
  }, [editorRef, motionPreviewMode, motionProject, motionTime]);

  useEffect(() => {
    if (!motionPlaying) return;
    let raf = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = Math.max(0, Math.min(0.1, (now - previous) / 1000));
      previous = now;
      setMotionTime((value) => {
        const next = value + delta;
        if (next >= motionProject.durationSeconds) {
          if (motionProject.loop) return next % motionProject.durationSeconds;
          setMotionPlaying(false);
          return motionProject.durationSeconds;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [motionPlaying, motionProject.durationSeconds, motionProject.loop]);

  const toggleCameraPilot = useCallback(() => {
    if (pilotActive) editorRef.current?.exitPilot();
    else editorRef.current?.enterPilot();
  }, [editorRef, pilotActive]);

  const openVideoExport = useCallback(() => {
    setVideoExportError(null);
    setVideoExportResult(null);
    setVideoExportProgress(null);
    setVideoExportOpen(true);
  }, []);

  const startVideoExport = useCallback(async () => {
    if (motionProject.cameraTrack.length < 2 || !availableVideoFormat) return;
    const canvas = editorRef.current?.getCanvas();
    if (!canvas) { setVideoExportError(t('directorStudio.motion.export.sceneUnavailable')); return; }
    const controller = new AbortController();
    videoExportAbortRef.current = controller;
    setMotionPlaying(false);
    setVideoExportError(null);
    setVideoExportProgress(null);
    setVideoExportResult(null);
    setVideoExportRecording(true);
    try {
      const result = await recordDirectorVideo({
        canvas,
        durationSeconds: motionProject.durationSeconds,
        resolution: videoExportResolution,
        fps: videoExportFps,
        format: availableVideoFormat,
        signal: controller.signal,
        renderAtTime: (time) => {
          editorRef.current?.applyMotionFrame(sampleNormalizedDirectorMotion(motionProject, time, latestDataRef.current.items), 'shot');
          editorRef.current?.renderFrame();
        },
        setCleanExportMode: (enabled, size) => editorRef.current?.setExportMode(enabled, size),
        onProgress: setVideoExportProgress,
      });
      setVideoExportResult(result);
    } catch (error) {
      if (!(error instanceof DirectorRecordingCancelledError)) setVideoExportError(error instanceof Error ? error.message : t('directorStudio.motion.export.failed'));
    } finally {
      videoExportAbortRef.current = null;
      setVideoExportRecording(false);
      editorRef.current?.applyMotionFrame(
        sampleNormalizedDirectorMotion(motionProject, motionTime, latestDataRef.current.items),
        motionPreviewMode,
      );
      editorRef.current?.renderFrame();
    }
  }, [availableVideoFormat, editorRef, motionPreviewMode, motionProject, motionTime, t, videoExportFps, videoExportResolution]);

  const addVideoExportToCanvas = useCallback(async () => {
    if (!videoExportResult || !onAddVideoToCanvas) return;
    const accepted = await onAddVideoToCanvas(videoExportResult);
    if (accepted !== false) setVideoExportOpen(false);
  }, [onAddVideoToCanvas, videoExportResult]);

  const stopMotionActivity = useCallback(() => {
    setMotionPlaying(false);
    videoExportAbortRef.current?.abort();
    editorRef.current?.exitPilot();
  }, [editorRef]);

  return {
    motionProject,
    timelineOpen, setTimelineOpen,
    motionTime,
    motionPlaying, setMotionPlaying,
    motionSelection, setMotionSelection,
    motionShowRoutes, setMotionShowRoutes,
    motionPreviewMode,
    pilotActive, setPilotActive,
    pilotTargetId, setPilotTargetId,
    actionLibraryOpen, setActionLibraryOpen,
    videoExportOpen, setVideoExportOpen,
    videoExportResolution, setVideoExportResolution,
    videoExportFps, setVideoExportFps,
    videoExportRecording,
    videoExportProgress,
    videoExportError,
    videoExportResult,
    availableVideoFormat,
    updateMotionProject,
    patchMotionKeyframe,
    moveMotionKeyframe,
    duplicateMotionKeyframe,
    deleteMotionKeyframe,
    addCameraMotionKeyframe,
    recordPilotCamera: saveCameraKeyframe,
    addObjectMotionKeyframe,
    addActionMotionKeyframe,
    updateMotionDuration,
    applyMotionActionState,
    saveMotionClip,
    updateMotionClip,
    duplicateMotionClip,
    deleteMotionClip,
    applyCameraPreset,
    setMotionTimeAndApply,
    selectMotionRouteKeyframe,
    moveMotionRouteKeyframe,
    insertMotionRouteKeyframe,
    setPreviewModeAndApply,
    toggleCameraPilot,
    openVideoExport,
    startVideoExport,
    cancelVideoExport: () => videoExportAbortRef.current?.abort(),
    saveVideoExport: () => { if (videoExportResult) downloadDirectorVideo(videoExportResult, `director-studio-${Date.now()}`); },
    addVideoExportToCanvas,
    stopMotionActivity,
  };
}
