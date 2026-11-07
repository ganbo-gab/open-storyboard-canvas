import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  BlueprintActionPose,
  BlueprintBodyControls,
  BlueprintItem,
  BlueprintNodeData,
  DirectorActionClip,
  DirectorCameraRig,
  DirectorCameraRigKind,
  DirectorMotionKeyframeBase,
  DirectorMotionProjectV1,
  DirectorMotionVector3,
} from '@/features/canvas/domain/canvasNodes';
import {
  DIRECTOR_CAMERA_RIG_DEFAULTS,
  DIRECTOR_CAMERA_RIG_MIN_SECONDS,
  DIRECTOR_MOTION_MAX_DURATION_SECONDS,
  DIRECTOR_MOTION_MIN_DURATION_SECONDS,
  createClipFromActionTrack,
  createDirectorCameraPresetTrack,
  createDirectorMotionId,
  createObjectKeyframeFromItem,
  deleteDirectorMotionClip,
  normalizeDirectorMotionProject,
  retimeDirectorTrack,
  sampleNormalizedDirectorMotion,
  splitDirectorActionSegment,
  splitDirectorCameraRig,
  duplicateDirectorCameraRig,
  bringDirectorCameraRigToFront,
  retimeDirectorCameraRig,
  upsertDirectorKeyframe,
  type DirectorCameraPresetId,
} from '@/features/canvas/application/directorMotion';
import { prepareStageCommands } from '@/features/stage/application/stageOperations';
import { retimeStageRoute, toggleStageRouteClosed } from '@/features/stage/application/stageRouteEditing';
import type { StageCommand, StageLookAt } from '@/features/stage/domain/stage';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import { resolvePersonActionPose } from '@/features/canvas/application/personMotionLibrary';
import { applyPersonPosePatch, normalizePersonPose, overlayPersonPose, type PersonPosePatch } from '@/features/canvas/domain/personPose';
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
  DirectorMotionRouteDraft,
  DirectorMotionRouteSelection,
  DirectorSceneCameraSnapshot,
} from './BlueprintScene';
import type { DirectorKeyframePatch, DirectorKeyframeSelection } from './DirectorMotionInspector';

export type DirectorKeyframeTrackRef = Pick<DirectorKeyframeSelection, 'kind' | 'trackId'>;

/** Apply one track update to the camera, object or action track named by `ref`. */
function updateKeyframeTrack(
  project: DirectorMotionProjectV1,
  ref: DirectorKeyframeTrackRef,
  update: <T extends DirectorMotionKeyframeBase>(track: T[]) => T[],
): DirectorMotionProjectV1 {
  if (ref.kind === 'camera') return { ...project, cameraTrack: update(project.cameraTrack) };
  if (ref.kind === 'object') return { ...project, objectTracks: { ...project.objectTracks, [ref.trackId]: update(project.objectTracks[ref.trackId] ?? []) } };
  return { ...project, actionTracks: { ...project.actionTracks, [ref.trackId]: update(project.actionTracks[ref.trackId] ?? []) } };
}

type Options = {
  data: BlueprintNodeData;
  previewEnabled: boolean;
  selectedItem: BlueprintItem | null;
  editorRef: MutableRefObject<BlueprintSceneHandle | null>;
  onUpdateNodeData: (patch: Partial<BlueprintNodeData>) => void;
  onUpdateItemAction: (item: BlueprintItem, action: string) => void;
  onAddVideoToCanvas?: (video: DirectorRecordedVideo) => Promise<boolean | void> | boolean | void;
};

export interface DirectorVideoExportRequest {
  resolution: DirectorVideoResolution;
  fps: DirectorVideoFps;
  addToCanvas: boolean;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Half a 24 fps frame: an edit at the playhead updates a keyframe sitting on that frame. */
const POSE_KEYFRAME_SNAP_SECONDS = 1 / 48;

export function useDirectorStudioMotion({
  data,
  previewEnabled,
  selectedItem,
  editorRef,
  onUpdateNodeData,
  onUpdateItemAction,
  onAddVideoToCanvas,
}: Options) {
  const { t } = useTranslation();
  const [motionSelection, setMotionSelection] = useState<DirectorKeyframeSelection | null>(null);
  const [motionShowRoutes, setMotionShowRoutes] = useState(true);
  const [motionPreviewMode, setMotionPreviewMode] = useState<'route' | 'shot'>('shot');
  const [motionRouteDraft, setMotionRouteDraft] = useState<DirectorMotionRouteDraft | null>(null);
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
  const motionProjectRef = useRef(motionProject);
  motionProjectRef.current = motionProject;
  const motionTimeRef = useRef(0);
  const motionTimeListenersRef = useRef(new Set<() => void>());
  const motionTimeSource = useMemo(() => ({
    subscribe: (listener: () => void) => {
      motionTimeListenersRef.current.add(listener);
      return () => motionTimeListenersRef.current.delete(listener);
    },
    getSnapshot: () => motionTimeRef.current,
  }), []);
  const publishMotionTime = useCallback((time: number) => {
    motionTimeRef.current = time;
    motionTimeListenersRef.current.forEach((listener) => listener());
  }, []);
  const [playbackRate, setPlaybackRate] = useState(1);
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;
  const motionPlayingRef = useRef(false);
  const playbackRafRef = useRef(0);
  const playbackListenersRef = useRef(new Set<() => void>());
  const playbackSource = useMemo(() => ({
    subscribe: (listener: () => void) => {
      playbackListenersRef.current.add(listener);
      return () => playbackListenersRef.current.delete(listener);
    },
    getSnapshot: () => motionPlayingRef.current,
  }), []);
  const motionPreviewModeRef = useRef(motionPreviewMode);
  motionPreviewModeRef.current = motionPreviewMode;
  const availableVideoFormat = useMemo(() => selectDirectorVideoFormat(), []);

  useEffect(() => {
    publishMotionTime(Math.min(motionTimeRef.current, motionProject.durationSeconds));
  }, [motionProject.durationSeconds, publishMotionTime]);

  const updateMotionProject = useCallback((updater: (project: DirectorMotionProjectV1) => DirectorMotionProjectV1) => {
    const nextProject = updater(normalizeDirectorMotionProject(latestDataRef.current.motionProject));
    onUpdateNodeData({ motionProject: normalizeDirectorMotionProject(nextProject) });
  }, [onUpdateNodeData]);

  const splitAtTime = useCallback((kind: 'camera' | 'object' | 'action', trackId: string, time: number) => {
    try {
      const data = latestDataRef.current;
      if (kind !== 'camera' && data.items.find((item) => item.id === trackId)?.locked) throw new Error(t('ui.stage.selection.lockedHint', { name: data.items.find((item) => item.id === trackId)?.label }));
      updateMotionProject((project) => {
        if (kind === 'action') {
          const frame = [...(project.actionTracks[trackId] ?? [])].reverse().find((entry) => entry.time <= time);
          if (frame?.clipId) return prepareStageCommands(data, [{ type: 'clip.split', clipId: frame.clipId, time, clipStart: frame.time - (frame.actionOffsetSeconds ?? 0) }]).data.motionProject!;
          return splitDirectorActionSegment(project, trackId, time).project;
        }
        const track = kind === 'camera' ? project.cameraTrack : project.objectTracks[trackId] ?? [];
        const before = [...track].reverse().find((frame) => frame.time < time);
        const after = track.find((frame) => frame.time > time);
        if (!before || !after || time - before.time < 0.2 || after.time - time < 0.2) throw new Error(t('ui.stage.rig.editError'));
        const sampled = sampleNormalizedDirectorMotion(project, time, data.items);
        const [rangeStart, rangeEnd] = after.easingRange ?? [0, 1];
        const midpoint = rangeStart + (time - before.time) / (after.time - before.time) * (rangeEnd - rangeStart);
        const leftRange: [number, number] = [rangeStart, midpoint];
        const rightRange: [number, number] = [midpoint, rangeEnd];
        if (kind === 'camera') {
          if (!sampled.camera) throw new Error(t('ui.stage.rig.editError'));
          const adjusted = project.cameraTrack.map((frame) => frame.id === after.id ? { ...frame, easingRange: rightRange } : frame);
          return { ...project, cameraTrack: upsertDirectorKeyframe(adjusted, { ...sampled.camera, id: createDirectorMotionId('camera-cut'), time, easing: after.easing, easingRange: leftRange }) };
        }
        const object = sampled.objects[trackId];
        if (!object) throw new Error(t('ui.stage.rig.editError'));
        const adjusted = (project.objectTracks[trackId] ?? []).map((frame) => frame.id === after.id ? { ...frame, easingRange: rightRange } : frame);
        return { ...project, objectTracks: { ...project.objectTracks, [trackId]: upsertDirectorKeyframe(adjusted, { ...object, id: createDirectorMotionId('object-cut'), time, easing: after.easing, easingRange: leftRange }) } };
      });
    } catch (error) { void showErrorDialog(error instanceof Error ? error.message : t('ui.stage.rig.editError'), t('common.error')); }
  }, [t, updateMotionProject]);

  const copyMotionTrack = useCallback((kind: 'camera' | 'object', trackId: string, start: number, end: number) => {
    const item = latestDataRef.current.items.find((entry) => entry.id === trackId);
    if (kind === 'object' && item?.locked) return;
    updateMotionProject((project) => {
      if (kind === 'camera') {
        const copied = retimeDirectorTrack(project.cameraTrack, start, end, project.durationSeconds).map((frame) => ({ ...frame, id: createDirectorMotionId('camera-copy') }));
        return { ...project, cameraTrack: [...project.cameraTrack, ...copied].sort((a, b) => a.time - b.time) };
      }
      const copied = retimeDirectorTrack(project.objectTracks[trackId] ?? [], start, end, project.durationSeconds).map((frame) => ({ ...frame, id: createDirectorMotionId('object-copy') }));
      return { ...project, objectTracks: { ...project.objectTracks, [trackId]: [...project.objectTracks[trackId] ?? [], ...copied].sort((a, b) => a.time - b.time) } };
    });
  }, [updateMotionProject]);

  const editCameraRigSegment = useCallback((id: string, operation: 'split' | 'duplicate' | 'front') => {
    try { updateMotionProject((project) => operation === 'split' ? splitDirectorCameraRig(project, id, motionTimeRef.current).project
      : operation === 'duplicate' ? duplicateDirectorCameraRig(project, id, motionTimeRef.current).project : bringDirectorCameraRigToFront(project, id)); }
    catch (error) { void showErrorDialog(error instanceof Error ? error.message : t('ui.stage.rig.editError'), t('common.error')); }
  }, [updateMotionProject, t]);
  const retimeCameraRig = useCallback((id: string, start: number, end: number, copy: boolean) => {
    try { updateMotionProject((project) => {
      if (!copy) return retimeDirectorCameraRig(project, id, start, end);
      const duplicated = duplicateDirectorCameraRig(project, id, start);
      return retimeDirectorCameraRig(duplicated.project, duplicated.rigId, start, end);
    }); } catch (error) { void showErrorDialog(error instanceof Error ? error.message : t('ui.stage.rig.editError'), t('common.error')); }
  }, [updateMotionProject, t]);

  // Rig parameters stream while a slider is dragged: render the preview from a draft project and
  // commit once on release, so one drag is one undo step.
  const [rigDraft, setRigDraft] = useState<DirectorCameraRig | null>(null);
  const previewProject = useMemo(
    () => rigDraft ? { ...motionProject, cameraRigs: motionProject.cameraRigs.map((rig) => rig.id === rigDraft.id ? rigDraft : rig) } : motionProject,
    [motionProject, rigDraft],
  );

  /** Add a follow / close-up rig on `itemId` from the playhead to the end of its route (or the shot). */
  const addCameraRig = useCallback((kind: DirectorCameraRigKind, itemId: string) => {
    const item = latestDataRef.current.items.find((candidate) => candidate.id === itemId);
    if (!item) return null;
    const project = motionProjectRef.current;
    const start = Math.min(motionTimeRef.current, project.durationSeconds - DIRECTOR_CAMERA_RIG_MIN_SECONDS);
    const route = project.objectTracks[itemId] ?? [];
    const routeEnd = route.length ? route[route.length - 1].time : 0;
    const end = routeEnd > start + DIRECTOR_CAMERA_RIG_MIN_SECONDS ? routeEnd : project.durationSeconds;
    const rig: DirectorCameraRig = {
      id: createDirectorMotionId(`rig-${kind}`),
      kind,
      targetId: itemId,
      start,
      end,
      ...DIRECTOR_CAMERA_RIG_DEFAULTS[kind],
    };
    updateMotionProject((current) => ({ ...current, cameraRigs: [...current.cameraRigs, rig] }));
    return rig.id;
  }, [updateMotionProject]);

  const previewCameraRig = useCallback((rigId: string, patch: Partial<DirectorCameraRig>) => {
    const base = motionProjectRef.current.cameraRigs.find((rig) => rig.id === rigId);
    if (!base) return;
    setRigDraft((draft) => ({ ...(draft?.id === rigId ? draft : base), ...patch }));
  }, []);

  /** Commits a rig edit and drops the preview draft; an unchanged patch records no undo step. */
  const updateCameraRig = useCallback((rigId: string, patch: Partial<DirectorCameraRig>) => {
    setRigDraft(null);
    const current = motionProjectRef.current.cameraRigs.find((rig) => rig.id === rigId);
    if (!current || (Object.keys(patch) as Array<keyof DirectorCameraRig>).every((key) => Object.is(current[key], patch[key]))) return;
    updateMotionProject((project) => ({
      ...project,
      cameraRigs: project.cameraRigs.map((rig) => rig.id === rigId ? { ...rig, ...patch } : rig),
    }));
  }, [updateMotionProject]);

  const deleteCameraRig = useCallback((rigId: string) => {
    setRigDraft(null);
    updateMotionProject((project) => ({ ...project, cameraRigs: project.cameraRigs.filter((rig) => rig.id !== rigId) }));
  }, [updateMotionProject]);

  /**
   * Bake a rig into ordinary camera keyframes (4 per second) so it can be hand-tweaked; the rig is removed.
   * Keys outside the rig's interval are kept.
   */
  const bakeCameraRig = useCallback((rigId: string) => {
    setRigDraft(null);
    let firstId: string | null = null;
    updateMotionProject((project) => {
      const rig = project.cameraRigs.find((entry) => entry.id === rigId);
      const item = rig ? latestDataRef.current.items.find((candidate) => candidate.id === rig.targetId) : undefined;
      if (!rig || !item) return project;
      const steps = Math.max(1, Math.ceil((rig.end - rig.start) * 4));
      const rest = { ...project, cameraRigs: project.cameraRigs.filter((entry) => entry.id !== rigId) };
      const frames = Array.from({ length: steps + 1 }, (_, index) => {
        const time = rig.start + (rig.end - rig.start) * (index / steps);
        const sampled = sampleNormalizedDirectorMotion(project, time, latestDataRef.current.items).camera;
        return {
          id: createDirectorMotionId('rig-bake'),
          time,
          easing: 'linear' as const,
          position: sampled?.position ?? { x: 0, y: 1.6, z: 5 },
          target: sampled?.target ?? { x: 0, y: 1, z: 0 },
          fov: sampled?.fov ?? rig.fov,
          trackTargetId: null,
          trackTargetBodyPart: null,
        };
      });
      firstId = frames[0].id;
      return {
        ...rest,
        cameraTrack: [
          ...project.cameraTrack.filter((frame) => frame.time < rig.start - 0.001 || frame.time > rig.end + 0.001),
          ...frames,
        ].sort((a, b) => a.time - b.time),
      };
    });
    if (firstId) setMotionSelection({ kind: 'camera', trackId: 'camera', keyframeId: firstId });
  }, [updateMotionProject]);

  const patchMotionKeyframes = useCallback((ref: DirectorKeyframeTrackRef, keyframeIds: string[], patch: DirectorKeyframePatch) => {
    const ids = new Set(keyframeIds);
    updateMotionProject((project) => updateKeyframeTrack(project, ref, (track) => track
      .map((keyframe) => ids.has(keyframe.id) ? { ...keyframe, ...patch } as typeof keyframe : keyframe)
      .sort((a, b) => a.time - b.time)));
  }, [updateMotionProject]);

  const patchMotionKeyframe = useCallback((selection: DirectorKeyframeSelection, patch: DirectorKeyframePatch) => {
    patchMotionKeyframes(selection, [selection.keyframeId], patch);
  }, [patchMotionKeyframes]);

  const moveMotionKeyframe = useCallback((selection: DirectorKeyframeSelection, time: number) => {
    patchMotionKeyframe(selection, { time: Math.min(motionProject.durationSeconds, Math.max(0, time)) });
  }, [motionProject.durationSeconds, patchMotionKeyframe]);

  /** Copy a keyframe to `time` (⌘-drag, duplicate); the copy becomes the selection. */
  const copyMotionKeyframe = useCallback((selection: DirectorKeyframeSelection, time: number) => {
    const id = createDirectorMotionId('duplicate');
    let copied = false;
    updateMotionProject((project) => updateKeyframeTrack(project, selection, (track) => {
      const source = track.find((keyframe) => keyframe.id === selection.keyframeId);
      if (!source) return track;
      copied = true;
      return upsertDirectorKeyframe(track, { ...cloneJson(source), id, time: Math.min(project.durationSeconds, Math.max(0, time)) });
    }));
    if (copied) setMotionSelection({ kind: selection.kind, trackId: selection.trackId, keyframeId: id });
  }, [updateMotionProject]);

  const duplicateMotionKeyframe = useCallback((selection: DirectorKeyframeSelection) => {
    const source = [
      ...motionProject.cameraTrack,
      ...(motionProject.objectTracks[selection.trackId] ?? []),
      ...(motionProject.actionTracks[selection.trackId] ?? []),
    ].find((keyframe) => keyframe.id === selection.keyframeId);
    if (source) copyMotionKeyframe(selection, source.time + 0.5);
  }, [copyMotionKeyframe, motionProject]);

  const deleteMotionKeyframes = useCallback((ref: DirectorKeyframeTrackRef, keyframeIds: string[]) => {
    const ids = new Set(keyframeIds);
    updateMotionProject((project) => updateKeyframeTrack(project, ref, (track) => track.filter((keyframe) => !ids.has(keyframe.id))));
    setMotionSelection((selection) => selection && ids.has(selection.keyframeId) ? null : selection);
  }, [updateMotionProject]);

  const deleteMotionKeyframe = useCallback((selection: DirectorKeyframeSelection) => {
    deleteMotionKeyframes(selection, [selection.keyframeId]);
  }, [deleteMotionKeyframes]);

  /** Upsert the camera keyframe at the playhead; returns its id. */
  const saveCameraKeyframe = useCallback((snapshot: DirectorSceneCameraSnapshot): string => {
    const time = motionTimeRef.current;
    let keyframeId = createDirectorMotionId('camera');
    updateMotionProject((project) => {
      const existing = project.cameraTrack.find((keyframe) => Math.abs(keyframe.time - time) <= 0.025);
      if (existing) keyframeId = existing.id;
      return {
        ...project,
        cameraTrack: upsertDirectorKeyframe(project.cameraTrack, {
          id: keyframeId,
          time,
          easing: existing?.easing ?? 'smooth',
          position: snapshot.position,
          target: snapshot.target,
          fov: snapshot.fov,
          trackTargetId: snapshot.trackTargetId ?? pilotTargetId ?? null,
          trackTargetBodyPart: snapshot.trackTargetBodyPart ?? null,
        }),
      };
    });
    return keyframeId;
  }, [pilotTargetId, updateMotionProject]);

  // Explicit keying (◇ button, K) selects the new key so Delete / easing act on it right away.
  const addCameraMotionKeyframe = useCallback(() => {
    const snapshot = editorRef.current?.getCameraSnapshot();
    if (!snapshot) return;
    const keyframeId = saveCameraKeyframe(snapshot);
    setMotionSelection({ kind: 'camera', trackId: 'camera', keyframeId });
  }, [editorRef, saveCameraKeyframe]);

  const addObjectMotionKeyframe = useCallback((itemId: string) => {
    const item = latestDataRef.current.items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    const keyframe = createObjectKeyframeFromItem(item, motionTimeRef.current);
    let keyframeId = keyframe.id;
    updateMotionProject((project) => {
      const track = project.objectTracks[itemId] ?? [];
      const existing = track.find((frame) => Math.abs(frame.time - keyframe.time) <= 0.025);
      if (existing) keyframeId = existing.id;
      return { ...project, objectTracks: { ...project.objectTracks, [itemId]: upsertDirectorKeyframe(track, keyframe) } };
    });
    setMotionSelection({ kind: 'object', trackId: itemId, keyframeId });
  }, [updateMotionProject]);

  const addActionMotionKeyframe = useCallback((itemId: string, state?: { poseId?: string; actionId?: string; clipId?: string; pose?: BlueprintActionPose; bodyControls?: BlueprintBodyControls }) => {
    const item = latestDataRef.current.items.find((candidate) => candidate.id === itemId);
    if (!item || item.category !== 'person') return;
    const action = {
      ...(state ?? {
        poseId: item.action ?? undefined,
        pose: overlayPersonPose(resolvePersonActionPose(item.action ?? undefined, latestDataRef.current.customActionPoses), normalizePersonPose(item.pose)),
      }),
      bodyControls: cloneJson(state?.bodyControls ?? item.bodyControls ?? {}),
    };
    const id = createDirectorMotionId('action');
    updateMotionProject((project) => ({
      ...project,
      actionTracks: { ...project.actionTracks, [itemId]: upsertDirectorKeyframe(project.actionTracks[itemId] ?? [], { id, time: motionTimeRef.current, easing: 'smooth', ...action }) },
    }));
    setMotionSelection({ kind: 'action', trackId: itemId, keyframeId: id });
  }, [updateMotionProject]);

  /**
   * Viewport/inspector pose edit in previs: overlay the edited joints on the
   * action keyframe under the playhead (keeping its action and phase), or
   * create one holding exactly the pose that was on screen.
   */
  const recordPersonPose = useCallback((itemId: string, edit: { patch: PersonPosePatch; pose: BlueprintActionPose }) => {
    const item = latestDataRef.current.items.find((candidate) => candidate.id === itemId);
    if (!item || item.category !== 'person') return;
    const time = motionTimeRef.current;
    let keyframeId = '';
    updateMotionProject((project) => {
      const track = project.actionTracks[itemId] ?? [];
      const existing = track.find((keyframe) => Math.abs(keyframe.time - time) <= POSE_KEYFRAME_SNAP_SECONDS);
      const keyframe = existing
        ? { ...existing, pose: applyPersonPosePatch(existing.pose, edit.patch) }
        : { id: createDirectorMotionId('action'), time, easing: 'smooth' as const, pose: edit.pose, bodyControls: cloneJson(item.bodyControls ?? {}) };
      keyframeId = keyframe.id;
      return { ...project, actionTracks: { ...project.actionTracks, [itemId]: upsertDirectorKeyframe(track, keyframe) } };
    });
    if (keyframeId) setMotionSelection({ kind: 'action', trackId: itemId, keyframeId });
  }, [updateMotionProject]);

  /** Drop pose edits from the keyframe under the playhead; a pose-only keyframe is removed. */
  const clearPersonPoseAt = useCallback((itemId: string) => {
    const time = motionTimeRef.current;
    updateMotionProject((project) => {
      const track = project.actionTracks[itemId] ?? [];
      const existing = track.find((keyframe) => Math.abs(keyframe.time - time) <= POSE_KEYFRAME_SNAP_SECONDS);
      if (!existing?.pose) return project;
      const { pose: _dropped, ...rest } = existing;
      const next = rest.poseId || rest.actionId || rest.clipId
        ? track.map((keyframe) => keyframe.id === existing.id ? rest : keyframe)
        : track.filter((keyframe) => keyframe.id !== existing.id);
      return { ...project, actionTracks: { ...project.actionTracks, [itemId]: next } };
    });
  }, [updateMotionProject]);

  const applyStageEdit = useCallback((commands: StageCommand[]) => {
    try {
      const result = prepareStageCommands(latestDataRef.current, commands);
      onUpdateNodeData({ motionProject: result.data.motionProject });
      return result;
    } catch (cause) {
      void showErrorDialog(commands[0]?.type === 'playback.update'
        ? t('ui.stage.durationConflict') : cause instanceof Error ? cause.message : String(cause), t('common.error'));
      return null;
    }
  }, [onUpdateNodeData, t]);

  const retimeMotionTrack = useCallback((kind: 'camera' | 'object', trackId: string, start: number, end: number) => {
    const commands = retimeStageRoute(motionProjectRef.current, { kind, trackId }, start, end);
    if (commands.length) applyStageEdit(commands);
  }, [applyStageEdit]);

  const toggleMotionRouteClosed = useCallback((kind: 'camera' | 'object', trackId: string) => {
    const commands = toggleStageRouteClosed(motionProjectRef.current, { kind, trackId });
    if (commands.length) applyStageEdit(commands);
  }, [applyStageEdit]);

  const setCameraLookAt = useCallback((lookAt: StageLookAt) => {
    const time = motionTimeRef.current;
    const sampled = sampleNormalizedDirectorMotion(motionProjectRef.current, time, latestDataRef.current.items).camera;
    if (sampled?.rigId) {
      void showErrorDialog(t('ui.stage.camera.bakeFirst'), t('common.error'));
      return false;
    }
    const snapshot = sampled ?? editorRef.current?.getCameraSnapshot();
    if (!snapshot) return false;
    const result = applyStageEdit([{ type: 'camera.lookAt', time, lookAt, position: snapshot.position, fov: snapshot.fov }]);
    const frame = result?.data.motionProject?.cameraTrack.find((entry) => Math.abs(entry.time - time) < 0.000001);
    if (frame) setMotionSelection({ kind: 'camera', trackId: 'camera', keyframeId: frame.id });
    return Boolean(result);
  }, [applyStageEdit, editorRef, t]);

  const updateMotionDuration = useCallback((duration: number) => {
    const nextDuration = Math.min(DIRECTOR_MOTION_MAX_DURATION_SECONDS, Math.max(DIRECTOR_MOTION_MIN_DURATION_SECONDS, duration));
    if (applyStageEdit([{ type: 'playback.update', duration: nextDuration }])) {
      publishMotionTime(Math.min(motionTimeRef.current, nextDuration));
    }
  }, [applyStageEdit, publishMotionTime]);

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

  const applyCameraPreset = useCallback((presetId: DirectorCameraPresetId, targetItemId?: string | null) => {
    const targetItem = targetItemId === undefined ? selectedItem : latestDataRef.current.items.find((item) => item.id === targetItemId) ?? null;
    if (presetId === 'follow-actor-route' && (
      !targetItem || targetItem.category !== 'person' || (motionProject.objectTracks[targetItem.id]?.length ?? 0) < 2
    )) return;
    const track = createDirectorCameraPresetTrack(
      presetId,
      motionProject.durationSeconds,
      targetItem,
      targetItem ? motionProject.objectTracks[targetItem.id] : undefined,
    );
    updateMotionProject((project) => ({ ...project, cameraTrack: track }));
    setMotionSelection(track[0] ? { kind: 'camera', trackId: 'camera', keyframeId: track[0].id } : null);
  }, [motionProject.durationSeconds, motionProject.objectTracks, selectedItem, updateMotionProject]);

  const completeMotionRouteDraft = useCallback((points: DirectorMotionVector3[]) => {
    const draft = motionRouteDraft;
    if (!draft || points.length < 2) return;
    const project = normalizeDirectorMotionProject(latestDataRef.current.motionProject);
    const start = Math.min(motionTimeRef.current, Math.max(0, project.durationSeconds - 0.5));
    const camera = draft.kind === 'camera' ? editorRef.current?.getCameraSnapshot() : undefined;
    if (draft.kind === 'camera' && !camera) return;
    const item = latestDataRef.current.items.find((entry) => entry.id === draft.trackId);
    const height = camera?.position.y ?? item?.pos3d?.y ?? 0;
    const result = applyStageEdit([{ type: 'trajectory.set', targetId: draft.kind === 'camera' ? 'camera' : draft.trackId,
      method: draft.method === 'draw' ? 'freehand' : draft.method, points: points.map((point) => ({ ...point, y: height })),
      start, duration: Math.min(4, project.durationSeconds - start), ...(camera ? { camera } : {}) }]);
    if (!result) return;
    if (result.createdIds[0]) setMotionSelection({ kind: draft.kind, trackId: draft.trackId, keyframeId: result.createdIds[0] });
    publishMotionTime(start);
    setMotionRouteDraft(null);
  }, [applyStageEdit, editorRef, motionRouteDraft, publishMotionTime]);

  const setMotionTimeAndApply = useCallback((time: number) => {
    const nextTime = Math.min(motionProject.durationSeconds, Math.max(0, time));
    publishMotionTime(nextTime);
    editorRef.current?.applyMotionFrame(sampleNormalizedDirectorMotion(previewProject, nextTime, latestDataRef.current.items), motionPreviewMode);
  }, [editorRef, motionPreviewMode, previewProject, publishMotionTime]);

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
    const nextTime = Math.min(motionProject.durationSeconds, Math.max(0, time));
    publishMotionTime(nextTime);
  }, [editorRef, motionProject.durationSeconds, publishMotionTime, updateMotionProject]);

  const setPreviewModeAndApply = useCallback((mode: 'route' | 'shot') => {
    setMotionPreviewMode(mode);
    motionPreviewModeRef.current = mode;
    editorRef.current?.applyMotionFrame(sampleNormalizedDirectorMotion(previewProject, motionTimeRef.current, latestDataRef.current.items), mode);
  }, [editorRef, previewProject]);

  useEffect(() => {
    editorRef.current?.applyMotionFrame(
      previewEnabled
        ? sampleNormalizedDirectorMotion(previewProject, motionTimeRef.current, latestDataRef.current.items)
        : sampleNormalizedDirectorMotion(normalizeDirectorMotionProject(undefined), 0, latestDataRef.current.items),
      previewEnabled ? motionPreviewMode : 'route',
    );
  }, [editorRef, motionPreviewMode, previewEnabled, previewProject]);

  const setMotionPlaying = useCallback((update: boolean | ((playing: boolean) => boolean)) => {
    const nextPlaying = typeof update === 'function' ? update(motionPlayingRef.current) : update;
    if (nextPlaying === motionPlayingRef.current) return;
    motionPlayingRef.current = nextPlaying;
    playbackListenersRef.current.forEach((listener) => listener());
    cancelAnimationFrame(playbackRafRef.current);
    editorRef.current?.setMotionPlaybackActive(nextPlaying);
    if (!nextPlaying) {
      motionTimeListenersRef.current.forEach((listener) => listener());
      return;
    }

    let previous = performance.now();
    let lastUiUpdate = previous;
    const tick = (now: number) => {
      if (!motionPlayingRef.current) return;
      const project = motionProjectRef.current;
      const delta = Math.max(0, Math.min(0.1, (now - previous) / 1000));
      previous = now;
      let next = motionTimeRef.current + delta * playbackRateRef.current;
      const reachedEnd = next >= project.durationSeconds;
      if (reachedEnd) {
        if (project.loop) next %= project.durationSeconds;
        else next = project.durationSeconds;
      }
      motionTimeRef.current = next;
      editorRef.current?.applyMotionFrame(
        sampleNormalizedDirectorMotion(project, next, latestDataRef.current.items),
        motionPreviewModeRef.current,
      );
      if (reachedEnd && !project.loop) {
        motionPlayingRef.current = false;
        motionTimeListenersRef.current.forEach((listener) => listener());
        playbackListenersRef.current.forEach((listener) => listener());
        editorRef.current?.setMotionPlaybackActive(false);
        return;
      }
      if (now - lastUiUpdate >= 33) {
        lastUiUpdate = now;
        motionTimeListenersRef.current.forEach((listener) => listener());
      }
      playbackRafRef.current = requestAnimationFrame(tick);
    };
    playbackRafRef.current = requestAnimationFrame(tick);
  }, [editorRef]);

  useEffect(() => () => {
    cancelAnimationFrame(playbackRafRef.current);
    motionPlayingRef.current = false;
    editorRef.current?.setMotionPlaybackActive(false);
  }, [editorRef]);

  const startMotionRouteDraft = useCallback((draft: DirectorMotionRouteDraft) => {
    if (motionRouteDraft?.kind === draft.kind && motionRouteDraft.trackId === draft.trackId && motionRouteDraft.method === draft.method) {
      editorRef.current?.cancelMotionRouteDraft();
      setMotionRouteDraft(null);
      return;
    }
    setMotionPlaying(false);
    setMotionSelection(null);
    setMotionRouteDraft(draft);
    setPreviewModeAndApply('route');
    setMotionShowRoutes(true);
  }, [editorRef, motionRouteDraft, setMotionPlaying, setPreviewModeAndApply]);

  const finishMotionRouteDraft = useCallback(() => {
    editorRef.current?.completeMotionRouteDraft();
  }, [editorRef]);

  const cancelMotionRouteDraft = useCallback(() => {
    editorRef.current?.cancelMotionRouteDraft();
    setMotionRouteDraft(null);
  }, [editorRef]);

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

  const startVideoExport = useCallback(async (
    request?: DirectorVideoExportRequest,
  ): Promise<DirectorRecordedVideo | null> => {
    if (motionProject.cameraTrack.length < 2 || !availableVideoFormat) return null;
    const canvas = editorRef.current?.getCanvas();
    if (!canvas) { setVideoExportError(t('directorStudio.motion.export.sceneUnavailable')); return null; }
    const controller = new AbortController();
    videoExportAbortRef.current = controller;
    setMotionPlaying(false);
    setVideoExportError(null);
    setVideoExportProgress(null);
    setVideoExportResult(null);
    setVideoExportRecording(true);
    try {
      const resolution = request?.resolution ?? videoExportResolution;
      const fps = request?.fps ?? videoExportFps;
      const result = await recordDirectorVideo({
        canvas,
        durationSeconds: motionProject.durationSeconds,
        resolution,
        fps,
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
      if (request?.addToCanvas && onAddVideoToCanvas) {
        const added = await onAddVideoToCanvas(result);
        if (added === false) {
          throw new Error(t('directorStudio.motion.export.addToCanvasFailed'));
        }
      }
      return result;
    } catch (error) {
      if (!(error instanceof DirectorRecordingCancelledError)) setVideoExportError(error instanceof Error ? error.message : t('directorStudio.motion.export.failed'));
      if (request) throw error;
      return null;
    } finally {
      videoExportAbortRef.current = null;
      setVideoExportRecording(false);
      editorRef.current?.applyMotionFrame(
        previewEnabled
          ? sampleNormalizedDirectorMotion(motionProject, motionTimeRef.current, latestDataRef.current.items)
          : sampleNormalizedDirectorMotion(normalizeDirectorMotionProject(undefined), 0, latestDataRef.current.items),
        previewEnabled ? motionPreviewMode : 'route',
      );
      editorRef.current?.renderFrame();
    }
  }, [availableVideoFormat, editorRef, motionPreviewMode, motionProject, onAddVideoToCanvas, previewEnabled, t, videoExportFps, videoExportResolution]);

  const addVideoExportToCanvas = useCallback(async () => {
    if (!videoExportResult || !onAddVideoToCanvas) return;
    const accepted = await onAddVideoToCanvas(videoExportResult);
    if (accepted !== false) setVideoExportOpen(false);
  }, [onAddVideoToCanvas, videoExportResult]);

  const stopMotionActivity = useCallback(() => {
    setMotionPlaying(false);
    cancelMotionRouteDraft();
    videoExportAbortRef.current?.abort();
    editorRef.current?.exitPilot();
  }, [cancelMotionRouteDraft, editorRef, setMotionPlaying]);

  return {
    motionProject,
    previewProject,
    motionTimeSource,
    playbackSource,
    playbackRate,
    setPlaybackRate,
    setMotionPlaying,
    motionSelection, setMotionSelection,
    motionShowRoutes, setMotionShowRoutes,
    motionPreviewMode,
    motionRouteDraft,
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
    splitAtTime,
    copyMotionTrack,
    editCameraRigSegment,
    retimeCameraRig,
    patchMotionKeyframe,
    patchMotionKeyframes,
    moveMotionKeyframe,
    retimeMotionTrack,
    toggleMotionRouteClosed,
    setCameraLookAt,
    copyMotionKeyframe,
    duplicateMotionKeyframe,
    deleteMotionKeyframe,
    deleteMotionKeyframes,
    addCameraMotionKeyframe,
    recordPilotCamera: saveCameraKeyframe,
    addObjectMotionKeyframe,
    addActionMotionKeyframe,
    recordPersonPose,
    clearPersonPoseAt,
    updateMotionDuration,
    applyMotionActionState,
    saveMotionClip,
    updateMotionClip,
    duplicateMotionClip,
    deleteMotionClip,
    applyCameraPreset,
    addCameraRig,
    previewCameraRig,
    updateCameraRig,
    deleteCameraRig,
    bakeCameraRig,
    startMotionRouteDraft,
    finishMotionRouteDraft,
    cancelMotionRouteDraft,
    completeMotionRouteDraft,
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
