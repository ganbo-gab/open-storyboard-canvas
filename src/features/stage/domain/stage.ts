import type { BlueprintActionPose, BlueprintItem, BlueprintNodeData, DirectorActionClip, DirectorActionClipKeyframe, DirectorActionKeyframe, DirectorCameraKeyframe, DirectorMotionVector3, DirectorObjectKeyframe } from '@/features/canvas/domain/canvasNodes';
import type { DirectorCameraPresetId } from '@/features/canvas/application/directorMotion';

export type StageWorkspace = 'director' | 'previs';
export type StageLookAt =
  | { mode: 'target'; targetId: string; bodyPart?: 'head' | 'torso' | 'feet' }
  | { mode: 'point'; point: DirectorMotionVector3 }
  | { mode: 'free'; rotation: DirectorMotionVector3 };
/** Existing V1 has one shot camera, not camera-shaped BlueprintItems. */
export type StageTrack =
  | { kind: 'camera' }
  | { kind: 'object' | 'action'; itemId: string }
  | { kind: 'clip'; clipId: string; clipStart: number };
export type StageKeyframe = DirectorObjectKeyframe | DirectorCameraKeyframe | DirectorActionKeyframe | DirectorActionClipKeyframe;
export type StageKeyframePatch = Partial<Omit<DirectorObjectKeyframe, 'id'>> | Partial<Omit<DirectorCameraKeyframe, 'id'>> | Partial<Omit<DirectorActionKeyframe, 'id'>>;
export type StageCommand =
  | { type: 'object.add'; item: BlueprintItem }
  | { type: 'object.update'; itemId: string; patch: Partial<Omit<BlueprintItem, 'id'>> }
  | { type: 'object.remove'; itemId: string }
  | { type: 'camera.lookAt'; time: number; lookAt: StageLookAt; position?: DirectorMotionVector3; fov?: number }
  | { type: 'person.pose'; itemId: string; poseId?: string; pose?: BlueprintActionPose; time?: number; duration?: number }
  | { type: 'person.action'; itemId: string; actionId: string; start: number; duration: number; pose?: BlueprintActionPose }
  | { type: 'camera.preset'; presetId: DirectorCameraPresetId; targetId?: string; start: number; duration: number }
  | { type: 'trajectory.set'; targetId: string; method: 'freehand' | 'points' | 'line'; points: DirectorMotionVector3[]; start: number; duration: number; holdEndUntil?: number; rotation?: DirectorMotionVector3; orientToPath?: boolean; camera?: { target: DirectorMotionVector3; fov: number } }
  | { type: 'clip.add'; clip: DirectorActionClip }
  | { type: 'clip.update'; clipId: string; patch: Partial<Omit<DirectorActionClip, 'id'>> }
  | { type: 'clip.split'; clipId: string; time: number; clipStart: number }
  | { type: 'clip.delete'; clipId: string }
  | { type: 'keyframe.add'; track: StageTrack; keyframe: StageKeyframe }
  | { type: 'keyframe.update'; track: StageTrack; keyframeId: string; patch: StageKeyframePatch }
  | { type: 'keyframe.remove'; track: StageTrack; keyframeId: string }
  | { type: 'draft.apply'; draft: StageSceneDraft; include?: Array<'objects' | 'people' | 'camera'> }
  | { type: 'playback.update'; duration: number; loop?: boolean };
export interface StageSnapshot { nodeId: string; revision: number; data: BlueprintNodeData }
export interface StageMutationResult extends StageSnapshot { createdIds: string[] }
export interface StageDraftObject { label: string; category: 'person' | 'object' | 'scene'; presetId: string; position: DirectorMotionVector3; rotation: DirectorMotionVector3; scale: DirectorMotionVector3; action?: string }
export interface StageSceneDraft { version: 1; description: string; objects: StageDraftObject[]; camera?: { position: DirectorMotionVector3; target: DirectorMotionVector3; fov: number }; estimation?: { cameraHeightM?: number; horizonNormalized?: number; scaleReference?: string; uncertainty: string[] } }
export interface StageDraftRequest { prompt: string; images?: string[]; modelId?: string }
