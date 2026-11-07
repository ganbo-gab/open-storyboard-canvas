import { focalLengthFromFov } from '@/features/canvas/domain/cameraLens';
export { focalLengthFromFov } from '@/features/canvas/domain/cameraLens';
import { UiButton, UiChipButton } from '@/components/ui';
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { Maximize2, Minimize2, MousePointer2, Move3d, RotateCcw, Clapperboard } from 'lucide-react';

import {
  getPanoramaControlSensitivityMultiplier,
  useSettingsStore,
} from '@/stores/settingsStore';
import type {
  BlueprintActionPose,
  BlueprintBodyControls,
  BlueprintItem,
  DirectorStudioGridSettings,
  DirectorStudioLightingSettings,
  DirectorStudioTransformMode,
  DirectorStudioViewSettings,
  DirectorMotionProjectV1,
  DirectorMotionVector3,
} from '@/features/canvas/domain/canvasNodes';
import type { SampledDirectorMotionFrame } from '@/features/canvas/application/directorMotion';
import { resolvePersonActionPose } from '@/features/canvas/application/personMotionLibrary';
import { normalizePersonPose, overlayPersonPose, personPoseKey, type PersonPoseJoint } from '@/features/canvas/domain/personPose';
import { applyPersonPose, createPersonMeshGroup, getAppliedPersonPose } from './personRig';
import { PersonPoseEditor, type PersonPoseEdit } from './personPoseEditor';
import { createImportedModelPlaceholder, disposeImportedModelMesh, resolveImportedModelMesh } from '@/features/stage/application/importedModelLoader';
import { createReliefItemMesh, disposeReliefItemMesh } from './blueprintReliefItem';
import type { StageLookAt } from '@/features/stage/domain/stage';
import { stageRouteClosed, stageRouteFrames, type StageRouteRef } from '@/features/stage/application/stageRouteEditing';
import { StageRouteControls } from '@/features/stage/ui/StageRouteControls';
import { StageCameraGuide } from '@/features/stage/ui/stageCameraGuide';
import { renderStageOffscreenImage } from '@/features/stage/application/stageOffscreenCapture';
import { assertStageCaptureActive, type StageCaptureRequest } from '@/features/stage/application/stageCapture';
import type { BlueprintReferenceImage } from '@/features/canvas/application/blueprintPrompt';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { BLUEPRINT_SPRITE_PRESETS } from './blueprintPresets';
import {
  ensurePos3d,
  pos3dToLegacy,
} from './blueprintCoordinates';
import {
  BLUEPRINT_PRESERVE_MATERIAL_COLOR,
  createObjectMeshGroup,
} from './blueprintMeshFactory';

/**
 * BlueprintScene
 * --------------
 * A focused 3D viewport for blueprint placement. The component owns nothing
 * about *what* to add — that's the parent's job (BlueprintNode / BlueprintPanel
 * render their own forms and call back via `onItemsChange` /
 * `onSelectedItemChange`). All this component does is:
 *
 *   1. Build / maintain a Three.js scene from `items` props.
 *   2. Provide pointer interactions: orbit / pan / zoom and item drag.
 *   3. Provide WASD movement when the user toggles "移动模式".
 *   4. Provide an imperative handle for fit / reset / export.
 *   5. Highlight the currently-selected item via outline ring.
 *   6. Optionally re-target the camera onto the selected item ("视角跟随").
 *   7. When `pointerMode === 'position'`, clicking the ground teleports
 *      the selected item there (used by parent's "移动 XY" affordance).
 *
 * Design notes:
 * - Mesh creation lives in `blueprintMeshFactory.ts`. This file only
 *   handles scene wiring + interaction.
 * - No internal "form" state. All adds/edits go through props.
 * - Click-outside-deselect is the parent's concern, not ours.
 */

export interface BlueprintSceneHandle {
  exportPng: (options?: BlueprintSceneExportOptions) => string | null;
  /** Real isolated frame export; never changes the live scene/camera/playback state. */
  captureFrame: (request: BlueprintSceneFrameCaptureRequest, signal?: AbortSignal) => Promise<Blob>;
  /** Non-null only after Three.js mesh, environment and camera synchronization. */
  getCaptureRevision: () => BlueprintSceneCaptureRevision | null;
  resetCamera: () => void;
  fitCamera: (view?: 'front') => void;
  focusItem: (itemId: string) => void;
  getSuggestedInsertPosition: () => { x: number; y: number; z: number };
  getCameraSnapshot: () => DirectorSceneCameraSnapshot | null;
  getCanvas: () => HTMLCanvasElement | null;
  applyMotionFrame: (frame: SampledDirectorMotionFrame, previewMode?: 'route' | 'shot') => void;
  setMotionPlaybackActive: (active: boolean) => void;
  renderFrame: () => void;
  setExportMode: (enabled: boolean, size?: { width: number; height: number }) => void;
  enterPilot: () => void;
  exitPilot: () => void;
  completeMotionRouteDraft: () => boolean;
  cancelMotionRouteDraft: () => void;
  /** Pose currently shown on a person (sampled motion included); null for non-persons. */
  getPersonPose: (itemId: string) => BlueprintActionPose | null;
  /** Show a pose on a person without committing it (inspector slider drag). */
  previewPersonPose: (itemId: string, pose: BlueprintActionPose) => void;
}

export interface DirectorSceneCameraSnapshot {
  position: DirectorMotionVector3;
  target: DirectorMotionVector3;
  fov: number;
  trackTargetId?: string | null;
  trackTargetBodyPart?: string | null;
}

export interface DirectorMotionRouteSelection {
  kind: 'camera' | 'object';
  trackId: string;
  keyframeId: string;
}

export interface DirectorMotionRouteDraft {
  kind: 'camera' | 'object';
  trackId: string;
  /** draw: freehand stroke; points: click points, Enter/double-click finishes; line: start + end click. */
  method: 'points' | 'draw' | 'line';
}

/** The parts of the dashed THREE.Line the route draft touches (`three` is untyped here). */
interface RouteDraftRubberLine {
  visible: boolean;
  material: { color: { setHex: (hex: number) => void } };
  geometry: { attributes: { position: { setXYZ: (index: number, x: number, y: number, z: number) => void; needsUpdate: boolean } } };
  computeLineDistances: () => void;
}

export interface BlueprintSceneExportOptions {
  frameAspect?: number | null;
  targetWidth?: number;
  targetHeight?: number;
}

export interface BlueprintSceneCaptureInputs {
  items: BlueprintItem[];
  customActionPoses?: Record<string, BlueprintActionPose>;
  mode: 'flat' | 'panorama';
  panoramaUrl?: string | null;
  cameraFov: number;
  cameraDistance: number;
  lighting: DirectorStudioLightingSettings;
  motionProject?: DirectorMotionProjectV1;
  meshDetail: 'full' | 'preview';
  width: number;
  height: number;
}

/** Identity is scoped to one committed renderer generation, not a store revision label. */
export interface BlueprintSceneCaptureRevision {
  readonly inputs: Readonly<BlueprintSceneCaptureInputs>;
}

export interface BlueprintSceneFrameCaptureRequest extends StageCaptureRequest {
  frame?: SampledDirectorMotionFrame;
  options?: BlueprintSceneExportOptions;
  revision?: BlueprintSceneCaptureRevision;
}

/** Previs route view: the shot camera drawn into a corner, shaped to the output frame (spec 05 §3). */
export interface BlueprintShotPreview {
  /** Output width / height. */
  aspect: number;
  cameraLabel: string;
  aspectLabel: string;
}

const SHOT_PIP_MARGIN = 16;

/** Bottom-right picture-in-picture rect in viewport CSS pixels, aspect-correct and bounded. */
export function computeShotPipRect(viewWidth: number, viewHeight: number, aspect: number): { left: number; top: number; width: number; height: number } {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const maxWidth = Math.min(360, Math.max(160, viewWidth * 0.26));
  const maxHeight = Math.max(96, viewHeight * 0.34);
  let width = maxWidth;
  let height = width / safeAspect;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * safeAspect;
  }
  width = Math.round(width);
  height = Math.round(height);
  return { left: Math.round(viewWidth - width - SHOT_PIP_MARGIN), top: Math.round(viewHeight - height - SHOT_PIP_MARGIN), width, height };
}

export interface BlueprintSceneProps {
  items: BlueprintItem[];
  /** Surface asynchronous model/relief load failures; no substitute geometry is presented as the result. */
  onAssetLoadError?: (message: string) => void;
  onAssetReady?: () => void;
  /** Called when the user drags an item to a new floor position. */
  onItemsChange: (items: BlueprintItem[]) => void;
  /** Optional reference-image legend rendered along the bottom edge. */
  referenceImages?: BlueprintReferenceImage[];
  /** 'flat' shows the floor grid; 'panorama' wraps an inverted sphere
   *  textured with `panoramaUrl` so subjects sit inside that environment. */
  mode?: 'flat' | 'panorama';
  panoramaUrl?: string | null;
  width?: number;
  height?: number;
  /** Currently-selected item id (parent-owned). */
  selectedItemId: string | null;
  selectedItemIds?: readonly string[];
  cameraSelected?: boolean;
  onCameraLookAt?: (lookAt: StageLookAt) => boolean;
  onCameraTargetSelect?: (itemId: string) => void;
  onSelectionChange?: (itemIds: string[], toggle?: boolean) => void;
  onSelectedItemChange: (itemId: string | null) => void;
  /** When true the camera target follows the selected item every frame. */
  followSelectedItem?: boolean;
  /** When 'position', clicking the ground teleports selectedItem there. */
  pointerMode?: 'orbit' | 'position';
  /** View-only left drag: never selects, transforms or inserts route points. */
  orbitNavigation?: boolean;
  /** Active Director Studio transform gizmo mode for the selected item. */
  transformMode?: DirectorStudioTransformMode | null;
  /** Optional notification when pointerMode auto-clears (e.g. after click). */
  onPointerModeChange?: (mode: 'orbit' | 'position') => void;
  /** User-authored bone-rotation overrides keyed by action label. When the
   *  item's `action` matches a key here, the pose's bone rotations are
   *  applied on top of the keyword preset (so a custom pose for "蹲下"
   *  can override the built-in 蹲下 mapping). */
  customActionPoses?: Record<string, import('@/features/canvas/domain/canvasNodes').BlueprintActionPose>;
  cameraFov?: number;
  cameraDistance?: number;
  lighting?: DirectorStudioLightingSettings;
  grid?: DirectorStudioGridSettings;
  viewSettings?: DirectorStudioViewSettings;
  keyboardShortcutsEnabled?: boolean;
  fullBleed?: boolean;
  motionProject?: DirectorMotionProjectV1;
  motionRoutesVisible?: boolean;
  motionRouteSelection?: DirectorMotionRouteSelection | null;
  onMotionRoutePointSelect?: (selection: DirectorMotionRouteSelection, time: number) => void;
  onMotionRouteRetime?: (kind: 'camera' | 'object', trackId: string, start: number, end: number) => void;
  onMotionRouteToggleClosed?: (kind: 'camera' | 'object', trackId: string) => void;
  onMotionRoutePointMove?: (selection: DirectorMotionRouteSelection, position: DirectorMotionVector3) => void;
  onMotionRoutePointInsert?: (
    kind: DirectorMotionRouteSelection['kind'],
    trackId: string,
    time: number,
    position: DirectorMotionVector3,
  ) => void;
  motionRouteDraft?: DirectorMotionRouteDraft | null;
  onMotionRouteDraftComplete?: (points: DirectorMotionVector3[]) => void;
  onMotionRouteDraftCancel?: () => void;
  /** Placed point count of the active draft (0 when it starts or is cleared). */
  onMotionRouteDraftProgress?: (count: number) => void;
  pilotActive?: boolean;
  onPilotActiveChange?: (active: boolean) => void;
  onPilotRecordCamera?: (snapshot: DirectorSceneCameraSnapshot) => void;
  onPilotTargetChange?: (itemId: string | null) => void;
  /** Person whose skeleton is editable in the viewport (pose mode); null disables pose editing. */
  poseEditItemId?: string | null;
  poseEditJoint?: PersonPoseJoint | null;
  onPoseEditJointChange?: (joint: PersonPoseJoint | null) => void;
  /** One call per finished gesture (gizmo release, IK drag release). */
  onPoseEditCommit?: (itemId: string, edit: PersonPoseEdit) => void;
  /** Previs route view only: live picture-in-picture of the shot camera. */
  shotPreview?: BlueprintShotPreview | null;
  /** Clicking the picture-in-picture switches the main view to the shot. */
  onShotPreviewActivate?: () => void;
}

function getItemHeight(item: BlueprintItem): number {
  if (item.presetId) {
    const def = BLUEPRINT_SPRITE_PRESETS[item.presetId];
    if (def) return def.heightMeters;
  }
  return item.category === 'person' ? 1.75 : 1.0;
}

function normalizeItemRotation(item: BlueprintItem): { x: number; y: number; z: number } {
  return {
    x: Number.isFinite(item.rotation3d?.x) ? item.rotation3d!.x : 0,
    y: Number.isFinite(item.rotation3d?.y) ? item.rotation3d!.y : 0,
    z: Number.isFinite(item.rotation3d?.z) ? item.rotation3d!.z : 0,
  };
}

function normalizeItemScale(item: BlueprintItem): { x: number; y: number; z: number } {
  return {
    x: Number.isFinite(item.scale3d?.x) ? THREE.MathUtils.clamp(item.scale3d!.x, 0.1, 5) : 1,
    y: Number.isFinite(item.scale3d?.y) ? THREE.MathUtils.clamp(item.scale3d!.y, 0.1, 5) : 1,
    z: Number.isFinite(item.scale3d?.z) ? THREE.MathUtils.clamp(item.scale3d!.z, 0.1, 5) : 1,
  };
}

/** Static person pose: library/custom pose for the action label, overlaid by the item's own pose. */
function resolveItemStaticPose(item: BlueprintItem, customActionPoses: Record<string, BlueprintActionPose> | undefined): BlueprintActionPose {
  return overlayPersonPose(resolvePersonActionPose(item.action, customActionPoses), normalizePersonPose(item.pose)) ?? {};
}

/** Pose is applied in place; only shape inputs (preset, role, body controls, detail) rebuild the mesh. */
function getItemMeshCacheKey(
  item: BlueprintItem,
  bodyControls: BlueprintBodyControls | undefined = item.bodyControls,
  detail: 'full' | 'preview' = 'full',
): string {
  const bodyControlsKey = item.category === 'person' ? JSON.stringify(bodyControls ?? {}) : '';
  const roleKey = item.category === 'person' ? (item.directorStudioRole ?? 'main') : 'na';
  const colorKey = item.category === 'person' ? item.color : '';
  return `${item.category}|${item.presetId ?? ''}|${roleKey}|${bodyControlsKey}|${detail}|${getItemHeight(item)}|${colorKey}|${item.importedModelId ?? ''}|${item.relief ? JSON.stringify(item.relief) : ''}`;
}

function applyItemPose(mesh: InstanceType<typeof THREE.Group>, pose: BlueprintActionPose): void {
  const key = personPoseKey(pose);
  if (mesh.userData.poseKey === key) return;
  applyPersonPose(mesh, pose);
  mesh.userData.poseKey = key;
}

/** Authored height of loaded imported models, so placeholders after the first load are the right size. */
const importedModelHeights = new Map<string, number>();

function createBlueprintItemMesh(
  item: BlueprintItem,
  customActionPoses: Record<string, BlueprintActionPose> | undefined,
  bodyControls: BlueprintBodyControls | undefined = item.bodyControls,
  detail: 'full' | 'preview' = 'full',
  onReady: () => void = () => {},
  onError: (error: unknown) => void = console.error,
): InstanceType<typeof THREE.Group> {
  const color = new THREE.Color(item.color);
  const heightM = getItemHeight(item);
  let mesh: InstanceType<typeof THREE.Group>;
  if (item.category === 'scene' && item.relief) {
    mesh = createReliefItemMesh(item.relief, onReady, onError);
  } else if (item.importedModelId) {
    // Swapped for the real model by the mesh-sync effect once the asset has loaded.
    mesh = createImportedModelPlaceholder(importedModelHeights.get(item.importedModelId) ?? 1);
    mesh.userData.importedModelPending = true;
  } else if (item.category === 'person') {
    mesh = createPersonMeshGroup(color, heightM, item.presetId, bodyControls, {
      role: item.directorStudioRole,
      detail,
    });
    applyItemPose(mesh, resolveItemStaticPose(item, customActionPoses));
  } else {
    mesh = createObjectMeshGroup(color, heightM, item.presetId);
  }
  mesh.traverse((object: InstanceType<typeof THREE.Object3D>) => { if (object.isMesh) object.name = `item:${item.id}`; });
  mesh.userData.itemId = item.id;
  mesh.userData.cacheKey = getItemMeshCacheKey(item, bodyControls, detail);
  mesh.userData.baseRotation = {
    x: mesh.rotation.x,
    y: mesh.rotation.y,
    z: mesh.rotation.z,
  };
  mesh.userData.baseScale = {
    x: mesh.scale.x,
    y: mesh.scale.y,
    z: mesh.scale.z,
  };
  return mesh;
}

function disposeBlueprintItemMesh(mesh: InstanceType<typeof THREE.Group>): void {
  if (!disposeReliefItemMesh(mesh)) disposeImportedModelMesh(mesh);
}

function toThreeTransformMode(mode: DirectorStudioTransformMode): 'translate' | 'rotate' | 'scale' {
  if (mode === 'move') return 'translate';
  return mode;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches('input, textarea, select');
}

const DEFAULT_CAMERA = {
  yaw: Math.PI * 0.75,
  pitch: Math.PI * 0.25,
  distance: 8,
  targetY: 0.5,
};

const PANORAMA_SPHERE_RADIUS = 50;
const PANORAMA_MAX_CAMERA_DISTANCE = PANORAMA_SPHERE_RADIUS - 5;
const PANORAMA_CAMERA_RADIUS_LIMIT = PANORAMA_SPHERE_RADIUS - 2;
const PANORAMA_OBJECT_RADIUS_LIMIT = PANORAMA_SPHERE_RADIUS - 3;

// One neutral graphite stage for both modes so routes, rings and gizmos read clearly.
// Values are the on-screen sRGB colours; build materials through `stageColor`.
const DIRECTOR_SCENE_BACKGROUND = '#0e1013';
const DIRECTOR_SCENE_CLEAR = 0x0e1013;
const DIRECTOR_GRID_PALETTE = {
  floor: 0x272b31,
  clickTarget: 0x0e1013,
  minor: 0x3a4048,
  major: 0x525a64,
  axisX: 0x8a4e47,
  axisZ: 0x3f7a6d,
  transformX: 0xff6f61,
  transformY: 0x67d98d,
  transformZ: 0x66b6ff,
  transformActive: 0xfacc15,
  hover: 0xcbd5e1,
  selection: 0x60a5fa,
};

/**
 * `@photo-sphere-viewer/core` turns `THREE.ColorManagement` off app-wide when the
 * panorama node loads, so `setHex` would store sRGB values as linear and render them
 * ~3x brighter. Linearize explicitly so the stage looks the same either way.
 */
function stageColor(hex: number) {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return new THREE.Color().setRGB(linear((hex >> 16) & 255), linear((hex >> 8) & 255), linear(hex & 255), THREE.LinearSRGBColorSpace);
}

const DEFAULT_LIGHTING: DirectorStudioLightingSettings = {
  enabled: true,
  mainIntensity: 0.65,
  mainYaw: 35,
  mainPitch: 50,
  mainColor: '#ffffff',
  ambientIntensity: 0.55,
  ambientColor: '#ffffff',
};

const DEFAULT_GRID: DirectorStudioGridSettings = {
  visible: true,
  height: 0,
};

const DEFAULT_VIEW_SETTINGS: DirectorStudioViewSettings = {
  wheelZoomEnabled: true,
  reverseWheelZoom: false,
  showAdvancedPedestrianTags: false,
};

function normalizeViewSettings(
  viewSettings: Partial<DirectorStudioViewSettings> | null | undefined
): DirectorStudioViewSettings {
  return {
    wheelZoomEnabled:
      typeof viewSettings?.wheelZoomEnabled === 'boolean'
        ? viewSettings.wheelZoomEnabled
        : DEFAULT_VIEW_SETTINGS.wheelZoomEnabled,
    reverseWheelZoom:
      typeof viewSettings?.reverseWheelZoom === 'boolean'
        ? viewSettings.reverseWheelZoom
        : DEFAULT_VIEW_SETTINGS.reverseWheelZoom,
    showAdvancedPedestrianTags:
      typeof viewSettings?.showAdvancedPedestrianTags === 'boolean'
        ? viewSettings.showAdvancedPedestrianTags
        : DEFAULT_VIEW_SETTINGS.showAdvancedPedestrianTags,
  };
}

function getPedestrianNumber(item: BlueprintItem, fallback: number): number {
  if (Number.isFinite(item.directorStudioNumber) && (item.directorStudioNumber ?? 0) > 0) {
    return item.directorStudioNumber!;
  }
  const match = item.label.trim().match(/^(?:路人|pedestrian)\s*(\d+)/i);
  const parsed = match ? Number(match[1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampVectorToRadiusInPlace(vector: any, radius: number): any {
  const length = vector.length();
  if (length > radius && length > 0) {
    vector.multiplyScalar(radius / length);
  }
  return vector;
}

function clampPanoramaPointAtFixedY(point: any): any {
  const radius = PANORAMA_OBJECT_RADIUS_LIMIT;
  point.y = THREE.MathUtils.clamp(point.y, -radius, radius);
  const horizontalLimit = Math.sqrt(Math.max(0, radius * radius - point.y * point.y));
  const horizontalLength = Math.hypot(point.x, point.z);
  if (horizontalLength > horizontalLimit && horizontalLength > 0) {
    const scale = horizontalLimit / horizontalLength;
    point.x *= scale;
    point.z *= scale;
  }
  return point;
}

function clampPanoramaCameraState(state: {
  distance: number;
  target: any;
}): void {
  state.distance = THREE.MathUtils.clamp(state.distance, 2, PANORAMA_MAX_CAMERA_DISTANCE);
  const maxTargetRadius = Math.max(0, PANORAMA_CAMERA_RADIUS_LIMIT - state.distance);
  clampVectorToRadiusInPlace(state.target, maxTargetRadius);
}

function clampPanoramaCameraPoints(position: any, target: any): void {
  clampVectorToRadiusInPlace(position, PANORAMA_CAMERA_RADIUS_LIMIT);
  clampVectorToRadiusInPlace(target, PANORAMA_CAMERA_RADIUS_LIMIT);
}

function isPedestrianItem(item: BlueprintItem): boolean {
  if (item.category !== 'person') return false;
  return item.directorStudioRole === 'pedestrian' || /^(?:路人|pedestrian)(?:\s*\d+)?/i.test(item.label.trim());
}

function getShortItemId(itemId: string): string {
  return itemId.replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase() || itemId.slice(-4).toUpperCase();
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function getSceneLabelSegments(
  item: BlueprintItem,
  showAdvancedPedestrianTags: boolean,
  pedestrianNumber?: number
): Array<{ text: string; color: string }> | null {
  const pedestrianTag = showAdvancedPedestrianTags && pedestrianNumber
    ? `#${pedestrianNumber} · ID ${getShortItemId(item.id)}`
    : null;
  const showName = item.showLabel !== false;
  if (!showName && !pedestrianTag) return null;

  const segments: Array<{ text: string; color: string }> = [
    { text: '●', color: item.color || '#ffffff' },
  ];
  if (showName) {
    segments.push({ text: ` ${item.label}`, color: 'rgba(255,255,255,0.94)' });
    if (pedestrianTag) {
      segments.push({ text: ` ${pedestrianTag}`, color: 'rgba(253,230,138,0.82)' });
    }
    if (item.refImageName) {
      segments.push({ text: ` @${item.refImageName}`, color: 'rgba(255,255,255,0.50)' });
    }
  } else if (pedestrianTag) {
    segments.push({ text: ` ${pedestrianTag}`, color: 'rgba(255,255,255,0.90)' });
  }
  return segments;
}

function buildPedestrianNumberMap(items: BlueprintItem[]): Map<string, number> {
  const numbers = new Map<string, number>();
  let fallback = 1;
  items.forEach((item) => {
    if (!isPedestrianItem(item)) return;
    numbers.set(item.id, getPedestrianNumber(item, fallback));
    fallback += 1;
  });
  return numbers;
}

export function createDirectorFloorGrid(size = 180, minorStep = 1, majorStep = 5) {
  const half = size / 2;
  const group = new THREE.Group();
  group.name = '__directorFloorGrid';

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      color: stageColor(DIRECTOR_GRID_PALETTE.floor),
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.006;
  floor.renderOrder = -10;
  group.add(floor);

  // Contact shadows: a transparent plane that only draws received shadow, so the
  // dark grid keeps its color while people/props visibly stand on the floor.
  const shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.ShadowMaterial({ opacity: 0.38, depthWrite: false }),
  );
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.y = -0.004;
  shadowCatcher.receiveShadow = true;
  shadowCatcher.renderOrder = -9;
  group.add(shadowCatcher);

  const minor: number[] = [];
  const major: number[] = [];
  const axisX: number[] = [];
  const axisZ: number[] = [];

  const pushLine = (target: number[], x1: number, z1: number, x2: number, z2: number) => {
    target.push(x1, 0, z1, x2, 0, z2);
  };

  for (let i = -half; i <= half; i += minorStep) {
    const rounded = Math.round(i);
    const target = rounded === 0
      ? null
      : Math.abs(rounded % majorStep) === 0
        ? major
        : minor;
    if (target) {
      pushLine(target, -half, i, half, i);
      pushLine(target, i, -half, i, half);
    }
  }
  pushLine(axisX, -half, 0, half, 0);
  pushLine(axisZ, 0, -half, 0, half);

  const makeLines = (positions: number[], color: number, opacity: number, width: number) => {
    const geometry = new THREE.BufferGeometry();
    const vertices: number[] = [];
    for (let index = 0; index < positions.length; index += 6) {
      const x1 = positions[index];
      const z1 = positions[index + 2];
      const x2 = positions[index + 3];
      const z2 = positions[index + 5];
      const length = Math.hypot(x2 - x1, z2 - z1);
      if (length <= Number.EPSILON) continue;
      const offsetX = (-(z2 - z1) / length) * width * 0.5;
      const offsetZ = ((x2 - x1) / length) * width * 0.5;
      const y = 0.004;
      vertices.push(
        x1 + offsetX, y, z1 + offsetZ,
        x1 - offsetX, y, z1 - offsetZ,
        x2 + offsetX, y, z2 + offsetZ,
        x2 + offsetX, y, z2 + offsetZ,
        x1 - offsetX, y, z1 - offsetZ,
        x2 - offsetX, y, z2 - offsetZ,
      );
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const material = new THREE.MeshBasicMaterial({
      color: stageColor(color),
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const lines = new THREE.Mesh(geometry, material);
    lines.frustumCulled = false;
    lines.renderOrder = 1;
    return lines;
  };

  group.add(makeLines(minor, DIRECTOR_GRID_PALETTE.minor, 0.7, 0.014));
  group.add(makeLines(major, DIRECTOR_GRID_PALETTE.major, 0.85, 0.026));
  group.add(makeLines(axisX, DIRECTOR_GRID_PALETTE.axisX, 0.74, 0.04));
  group.add(makeLines(axisZ, DIRECTOR_GRID_PALETTE.axisZ, 0.74, 0.04));
  return group;
}

export function createDirectorFloorHitTarget() {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300),
    new THREE.MeshBasicMaterial({
      color: DIRECTOR_GRID_PALETTE.clickTarget,
      colorWrite: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.name = '__floor';
  return floor;
}

function requestPilotPointerLock(canvas: HTMLCanvasElement, onFailure: () => void): void {
  try {
    const pending = canvas.requestPointerLock?.();
    if (pending && typeof pending.catch === 'function') void pending.catch(onFailure);
  } catch {
    onFailure();
  }
}

function setRingAppearance(ring: any, color: number, opacity: number) {
  const material = ring?.material as any;
  if (!material) return;
  material.color.copy(stageColor(color));
  material.opacity = opacity;
  material.needsUpdate = true;
}

export const BlueprintScene = memo(forwardRef<BlueprintSceneHandle, BlueprintSceneProps>(function BlueprintScene({
  items,
  onAssetLoadError,
  onAssetReady,
  onItemsChange,
  referenceImages = [],
  mode = 'flat',
  panoramaUrl,
  width = 720,
  height = 440,
  selectedItemId,
  selectedItemIds,
  cameraSelected = false,
  onCameraLookAt,
  onCameraTargetSelect,
  onSelectionChange,
  onSelectedItemChange,
  followSelectedItem = false,
  pointerMode = 'orbit',
  orbitNavigation = false,
  transformMode = null,
  onPointerModeChange,
  customActionPoses,
  cameraFov = 45,
  cameraDistance = DEFAULT_CAMERA.distance,
  lighting = DEFAULT_LIGHTING,
  grid = DEFAULT_GRID,
  viewSettings: rawViewSettings = DEFAULT_VIEW_SETTINGS,
  keyboardShortcutsEnabled = true,
  fullBleed = false,
  motionProject,
  motionRoutesVisible = true,
  motionRouteSelection = null,
  onMotionRoutePointSelect,
  onMotionRoutePointMove,
  onMotionRouteRetime,
  onMotionRouteToggleClosed,
  onMotionRoutePointInsert,
  motionRouteDraft = null,
  onMotionRouteDraftComplete,
  onMotionRouteDraftCancel,
  onMotionRouteDraftProgress,
  pilotActive = false,
  onPilotActiveChange,
  onPilotRecordCamera,
  onPilotTargetChange,
  poseEditItemId = null,
  poseEditJoint = null,
  onPoseEditJointChange,
  onPoseEditCommit,
  shotPreview = null,
  onShotPreviewActivate,
}, ref) {
  const { t } = useTranslation();
  const panoramaControlSensitivity = useSettingsStore((s) => s.panoramaControlSensitivity);
  const panoramaControlSensitivityMultiplier =
    getPanoramaControlSensitivityMultiplier(panoramaControlSensitivity);
  // ---------------------------------------------------------------------
  // Refs to live Three.js state. We keep these out of React state to avoid
  // re-rendering on every camera tick / mesh update.
  // ---------------------------------------------------------------------
  const hostElRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const miniMapRef = useRef<HTMLCanvasElement | null>(null);
  const captureRevisionRef = useRef<BlueprintSceneCaptureRevision | null>(null);

  const rendererRef = useRef<any>(null);
  const sceneRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const itemsGroupRef = useRef<any>(null);
  const meshByIdRef = useRef<Map<string, any>>(new Map());
  const itemsByIdRef = useRef<Map<string, BlueprintItem>>(new Map());
  const panoMeshRef = useRef<any>(null);
  const hoverRingRef = useRef<any>(null);
  const selectionRingRef = useRef<any>(null);
  const gridRef = useRef<any>(null);
  const floorRef = useRef<any>(null);
  const ambientLightRef = useRef<any>(null);
  const mainLightRef = useRef<any>(null);
  const motionRoutesRef = useRef<any>(null);
  const motionRouteDraftGroupRef = useRef<any>(null);
  const motionRouteDraftPointsRef = useRef<DirectorMotionVector3[]>([]);
  /** Ground point under the cursor while placing points / a line (rubber band + length readout). */
  const motionRouteDraftHoverRef = useRef<DirectorMotionVector3 | null>(null);
  const motionRouteDraftRubberRef = useRef<RouteDraftRubberLine | null>(null);
  const motionRouteDraftRef = useRef(motionRouteDraft);
  motionRouteDraftRef.current = motionRouteDraft;
  const onMotionRouteDraftProgressRef = useRef(onMotionRouteDraftProgress);
  onMotionRouteDraftProgressRef.current = onMotionRouteDraftProgress;
  const motionPlaybackActiveRef = useRef(false);
  const exportModeRef = useRef(false);
  const exportSizeRef = useRef<{ width: number; height: number } | null>(null);
  const exportVisibilityRef = useRef<{
    grid: boolean;
    floor: boolean;
    selectionRing: boolean;
    hoverRing: boolean;
    transformHelper: boolean;
    motionRoutes: boolean;
  } | null>(null);
  const motionPreviewModeRef = useRef<'route' | 'shot'>('route');
  const routePreviewCameraRef = useRef<DirectorSceneCameraSnapshot | null>(null);
  const pilotStateRef = useRef({ active: false, yaw: 0, pitch: 0, position: new THREE.Vector3() });
  const cameraSnapshotTargetRef = useRef<DirectorSceneCameraSnapshot | null>(null);
  const shotPreviewRef = useRef(shotPreview);
  shotPreviewRef.current = shotPreview;
  const shotCameraFrameRef = useRef<SampledDirectorMotionFrame['camera']>(null);
  const pipCameraRef = useRef<InstanceType<typeof THREE.PerspectiveCamera> | null>(null);
  const shotPipElRef = useRef<HTMLDivElement | null>(null);
  const shotPipLabelRef = useRef<HTMLSpanElement | null>(null);
  const renderShotPipRef = useRef<() => void>(() => {});
  const transformControlsRef = useRef<TransformControls | null>(null);
  const transformHelperRef = useRef<any>(null);
  const transformDraggingRef = useRef(false);
  const cameraGuideRef = useRef<StageCameraGuide | null>(null);
  const cameraSelectedRef = useRef(cameraSelected); cameraSelectedRef.current = cameraSelected;
  const onCameraLookAtRef = useRef(onCameraLookAt); onCameraLookAtRef.current = onCameraLookAt;
  const cameraTransformOriginalRef = useRef<SampledDirectorMotionFrame['camera']>(null);
  const cameraDoubleClickRef = useRef<{ itemId: string; at: number } | null>(null);
  const cameraEndpointDragRef = useRef<{ pointerId: number; plane: InstanceType<typeof THREE.Plane>; original: SampledDirectorMotionFrame['camera']; moved: boolean } | null>(null);
  const routeControlsRef = useRef<HTMLDivElement | null>(null);
  const routeControlTarget: StageRouteRef | null = motionRouteSelection ?? (selectedItemId ? { kind: 'object', trackId: selectedItemId } : cameraSelected ? { kind: 'camera', trackId: 'camera' } : null);
  const routeControlFrames = motionProject && routeControlTarget ? stageRouteFrames(motionProject, routeControlTarget) : [];
  const routeControlTargetRef = useRef(routeControlTarget); routeControlTargetRef.current = routeControlTarget;
  const routeControlFramesRef = useRef(routeControlFrames); routeControlFramesRef.current = routeControlFrames;
  const cameraDistanceRef = useRef(DEFAULT_CAMERA.distance);
  const gridHeightRef = useRef(grid.height);
  const poseEditorRef = useRef<PersonPoseEditor | null>(null);
  const poseEditItemIdRef = useRef(poseEditItemId);
  poseEditItemIdRef.current = poseEditItemId;
  const onPoseEditJointChangeRef = useRef(onPoseEditJointChange);
  onPoseEditJointChangeRef.current = onPoseEditJointChange;
  const onPoseEditCommitRef = useRef(onPoseEditCommit);
  onPoseEditCommitRef.current = onPoseEditCommit;

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const motionRoutesVisibleRef = useRef(motionRoutesVisible);
  motionRoutesVisibleRef.current = motionRoutesVisible;
  itemsByIdRef.current = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );
  const customActionPosesRef = useRef<Record<string, BlueprintActionPose> | undefined>(customActionPoses);
  customActionPosesRef.current = customActionPoses;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const getPanoramaModeControlMultiplier = useCallback(
    () => (modeRef.current === 'panorama' ? panoramaControlSensitivityMultiplier : 1),
    [panoramaControlSensitivityMultiplier]
  );
  const onItemsChangeRef = useRef(onItemsChange);
  onItemsChangeRef.current = onItemsChange;
  const selectedItemIdRef = useRef<string | null>(selectedItemId);
  selectedItemIdRef.current = selectedItemId;
  const selectedIdsRef = useRef<readonly string[]>([]);
  selectedIdsRef.current = selectedItemIds ?? (selectedItemId ? [selectedItemId] : []);
  const [selectionBox, setSelectionBox] = useState<{ x: number; y: number; endX: number; endY: number; toggle: boolean } | null>(null);
  const selectionBoxRef = useRef(selectionBox);
  selectionBoxRef.current = selectionBox;
  const [transformHint, setTransformHint] = useState('');
  const selectionPivotRef = useRef<InstanceType<typeof THREE.Group> | null>(null);
  const transformStartRef = useRef<{ inverse: InstanceType<typeof THREE.Matrix4>; position: InstanceType<typeof THREE.Vector3>; rotation: InstanceType<typeof THREE.Euler>; matrices: Map<string, InstanceType<typeof THREE.Matrix4>> } | null>(null);
  const displayedTransformHintRef = useRef('');
  const pointerModeRef = useRef<'orbit' | 'position'>(pointerMode);
  pointerModeRef.current = pointerMode;
  const orbitNavigationRef = useRef(orbitNavigation);
  orbitNavigationRef.current = orbitNavigation;
  gridHeightRef.current = Number.isFinite(grid.height) ? grid.height : DEFAULT_GRID.height;
  const viewSettings = useMemo(() => normalizeViewSettings(rawViewSettings), [rawViewSettings]);
  const viewSettingsRef = useRef(viewSettings);
  viewSettingsRef.current = viewSettings;

  // Camera orbit state. `target` is a THREE.Vector3 we mutate in-place.
  const camStateRef = useRef({
    yaw: DEFAULT_CAMERA.yaw,
    pitch: DEFAULT_CAMERA.pitch,
    distance: DEFAULT_CAMERA.distance,
    target: new THREE.Vector3(0, DEFAULT_CAMERA.targetY, 0),
  });

  // ---------------------------------------------------------------------
  // Render scheduling: schedule at most one rAF render per change so
  // mounted but idle scenes don't burn CPU.
  // ---------------------------------------------------------------------
  const renderScheduledRef = useRef(false);
  const updateOverlayLabelsRef = useRef<() => void>(() => {});
  const requestRender = useCallback(() => {
    if (renderScheduledRef.current) return;
    renderScheduledRef.current = true;
    requestAnimationFrame(() => {
      renderScheduledRef.current = false;
      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      if (!renderer || !scene || !camera) return;
      renderer.render(scene, camera);
      renderShotPipRef.current();
      updateOverlayLabelsRef.current();
    });
  }, []);

  // ---------------------------------------------------------------------
  // UI state
  // ---------------------------------------------------------------------
  const [editMode, setEditMode] = useState(false); // WASD camera move
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fsSize, setFsSize] = useState({ w: 0, h: 0 });

  const effectiveWidth = isFullscreen ? Math.max(320, (fsSize.w || window.innerWidth) - 24) : width;
  const effectiveHeight = isFullscreen ? Math.max(240, (fsSize.h || window.innerHeight) - 180) : height;
  // Dense director scenes use a lighter procedural silhouette so opening the
  // studio remains interactive while the camera and timeline settle.
  const meshDetail: 'full' | 'preview' = fullBleed && items.length > 24 ? 'preview' : 'full';
  const captureInputs = useMemo<BlueprintSceneCaptureInputs>(() => ({
    items, customActionPoses, mode, panoramaUrl, cameraFov, cameraDistance, lighting,
    motionProject, meshDetail, width: effectiveWidth, height: effectiveHeight,
  }), [items, customActionPoses, mode, panoramaUrl, cameraFov, cameraDistance, lighting, motionProject, meshDetail, effectiveWidth, effectiveHeight]);
  useLayoutEffect(() => {
    // Revoke the preceding commit synchronously, including for retained old
    // imperative handles and encoders settling before passive effects run.
    captureRevisionRef.current = null;
    return () => { captureRevisionRef.current = null; };
  }, [captureInputs]);

  const hint = motionRouteDraft
    ? t(`directorStudio.motion.route.${motionRouteDraft.method === 'draw' ? 'hintDraw' : motionRouteDraft.method === 'line' ? 'hintLine' : 'hintPoints'}`)
    : poseEditItemId
    ? t('directorStudio.pose.viewportHint')
    : orbitNavigation
    ? t('ui.stage.orbitToolHint')
    : pointerMode === 'position'
    ? t('directorStudio.scene.positionHint')
    : editMode
      ? t('directorStudio.scene.moveHint')
      : t('directorStudio.scene.orbitHint');

  // ---------------------------------------------------------------------
  // Camera helpers
  // ---------------------------------------------------------------------
  const applyCamera = useCallback(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const s = camStateRef.current;
    s.pitch = Math.max(0.05, Math.min(Math.PI / 2 - 0.02, s.pitch));
    if (modeRef.current === 'panorama') {
      clampPanoramaCameraState(s);
    }
    const { yaw, pitch, target } = s;
    camera.position.set(
      target.x + s.distance * Math.cos(pitch) * Math.sin(yaw),
      target.y + s.distance * Math.sin(pitch),
      target.z + s.distance * Math.cos(pitch) * Math.cos(yaw),
    );
    camera.lookAt(target);
  }, []);

  const getCameraSnapshot = useCallback((): DirectorSceneCameraSnapshot | null => {
    const camera = cameraRef.current;
    if (!camera) return null;
    const position = camera.position.clone();
    const target = camStateRef.current.target.clone();
    if (modeRef.current === 'panorama') {
      clampPanoramaCameraPoints(position, target);
      camera.position.copy(position);
      camStateRef.current.target.copy(target);
    }
    const snapshot = {
      position: { x: position.x, y: position.y, z: position.z },
      target: { x: target.x, y: target.y, z: target.z },
      fov: camera.fov,
      trackTargetId: cameraSnapshotTargetRef.current?.trackTargetId ?? null,
      trackTargetBodyPart: cameraSnapshotTargetRef.current?.trackTargetBodyPart ?? null,
    } satisfies DirectorSceneCameraSnapshot;
    cameraSnapshotTargetRef.current = snapshot;
    return snapshot;
  }, []);

  const handleResetCamera = useCallback(() => {
    camStateRef.current.yaw = DEFAULT_CAMERA.yaw;
    camStateRef.current.pitch = DEFAULT_CAMERA.pitch;
    camStateRef.current.distance = cameraDistanceRef.current;
    camStateRef.current.target.set(0, DEFAULT_CAMERA.targetY, 0);
    applyCamera();
    requestRender();
  }, [applyCamera, requestRender]);

  const handleFitCamera = useCallback((view?: 'front') => {
    const placed = itemsRef.current;
    if (placed.length === 0) { handleResetCamera(); return; }
    // Placement origins alone omit the actual extent of imported models and relief backdrops.
    const group = itemsGroupRef.current;
    const box = group ? new THREE.Box3().setFromObject(group) : new THREE.Box3();
    if (box.isEmpty()) placed.forEach((item) => { const p = ensurePos3d(item); box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z)); });
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const camera = cameraRef.current;
    const verticalFov = (camera?.fov ?? 45) * Math.PI / 180;
    const aspect = camera?.aspect ?? 1;
    const halfExtent = Math.max(size.y, size.x / Math.max(aspect, 0.01), size.z, 2) / 2;
    camStateRef.current.target.copy(center);
    camStateRef.current.distance = Math.max(4, halfExtent / Math.tan(verticalFov / 2) * 1.25 + size.z / 2);
    if (view === 'front') { camStateRef.current.yaw = 0; camStateRef.current.pitch = 0; }
    applyCamera();
    requestRender();
  }, [applyCamera, handleResetCamera, requestRender]);

  const handleFocusItem = useCallback((itemId: string) => {
    const item = itemsRef.current.find((it) => it.id === itemId);
    if (!item) return;
    const p = ensurePos3d(item);
    camStateRef.current.target.set(p.x, Math.max(p.y, 0.9), p.z);
    applyCamera();
    requestRender();
  }, [applyCamera, requestRender]);

  // ---------------------------------------------------------------------
  // Three.js scene setup (once on mount)
  // ---------------------------------------------------------------------
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(DIRECTOR_SCENE_BACKGROUND);
    scene.fog = new THREE.FogExp2(stageColor(DIRECTOR_SCENE_CLEAR), 0.009);

    const camera = new THREE.PerspectiveCamera(cameraFov, width / height, 0.1, 500);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(DIRECTOR_SCENE_CLEAR, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.04;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.touchAction = 'none';

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, DEFAULT_LIGHTING.ambientIntensity);
    scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.65);
    dir.position.set(6, 10, 4);
    // Metric frustum sized for a room-to-street stage; 2048 map keeps feet contact crisp.
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -18;
    dir.shadow.camera.right = 18;
    dir.shadow.camera.top = 18;
    dir.shadow.camera.bottom = -18;
    dir.shadow.camera.near = 0.5;
    dir.shadow.camera.far = 60;
    dir.shadow.bias = -0.0004;
    dir.shadow.normalBias = 0.02;
    scene.add(dir);
    scene.add(dir.target);
    ambientLightRef.current = ambient;
    mainLightRef.current = dir;

    // Floor grid + invisible click target
    const grid = createDirectorFloorGrid();
    scene.add(grid);
    gridRef.current = grid;
    const floor = createDirectorFloorHitTarget();
    scene.add(floor);
    floorRef.current = floor;

    // Hover ring for placement-target preview
    const hoverRing = new THREE.Mesh(
      new THREE.RingGeometry(0.44, 0.49, 48),
      new THREE.MeshBasicMaterial({
        color: stageColor(DIRECTOR_GRID_PALETTE.hover),
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthTest: false,
      }),
    );
    hoverRing.rotation.x = -Math.PI / 2;
    hoverRing.position.y = 0.01;
    hoverRing.renderOrder = 700;
    hoverRing.visible = false;
    scene.add(hoverRing);
    hoverRingRef.current = hoverRing;

    // Selection ring (under selected item)
    const selRing = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.58, 64),
      new THREE.MeshBasicMaterial({
        color: stageColor(DIRECTOR_GRID_PALETTE.selection),
        transparent: true,
        opacity: 0.96,
        side: THREE.DoubleSide,
        depthTest: false,
      }),
    );
    selRing.rotation.x = -Math.PI / 2;
    selRing.renderOrder = 800;
    selRing.visible = false;
    scene.add(selRing);
    selectionRingRef.current = selRing;

    // Inverted sphere for panorama background
    const panoGeom = new THREE.SphereGeometry(PANORAMA_SPHERE_RADIUS, 48, 32);
    panoGeom.scale(-1, 1, 1);
    const panoMesh = new THREE.Mesh(panoGeom, new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
    panoMesh.visible = false;
    scene.add(panoMesh);
    panoMeshRef.current = panoMesh;

    // Items live in a dedicated group so we can clear/iterate easily.
    const itemsGroup = new THREE.Group();
    itemsGroup.name = '__itemsGroup';
    scene.add(itemsGroup);
    itemsGroupRef.current = itemsGroup;

    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.enabled = false;
    transformControls.setSize(0.85);
    (transformControls as any).setColors?.(
      DIRECTOR_GRID_PALETTE.transformX,
      DIRECTOR_GRID_PALETTE.transformY,
      DIRECTOR_GRID_PALETTE.transformZ,
      DIRECTOR_GRID_PALETTE.transformActive,
    );
    const transformHelper = transformControls.getHelper();
    transformHelper.visible = false;
    scene.add(transformHelper);
    transformControlsRef.current = transformControls;
    transformHelperRef.current = transformHelper;

    const cameraGuide = new StageCameraGuide();
    cameraGuide.group.visible = false;
    scene.add(cameraGuide.group);
    cameraGuideRef.current = cameraGuide;

    const poseEditor = new PersonPoseEditor(camera, renderer.domElement, {
      requestRender,
      onJointChange: (joint) => onPoseEditJointChangeRef.current?.(joint),
      onCommit: (edit) => {
        const itemId = poseEditItemIdRef.current;
        if (itemId) onPoseEditCommitRef.current?.(itemId, edit);
      },
    });
    scene.add(poseEditor.helper);
    poseEditorRef.current = poseEditor;

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    applyCamera();
    renderer.render(scene, camera);

    return () => {
      captureRevisionRef.current = null;
      renderer.dispose();
      transformControls.detach();
      transformControls.dispose();
      for (const mesh of meshByIdRef.current.values()) disposeBlueprintItemMesh(mesh);
      scene.remove(transformHelper);
      poseEditor.dispose();
      cameraGuide.dispose(); cameraGuideRef.current = null;
      poseEditorRef.current = null;
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      transformControlsRef.current = null;
      transformHelperRef.current = null;
      transformDraggingRef.current = false;
      // Critical: also drop references to the dead itemsGroup and any
      // meshes we cached as children of it. StrictMode in dev mounts the
      // component, runs this cleanup, then remounts — which builds a
      // brand-new scene + itemsGroup. Without clearing these, the items
      // effect on remount finds prior meshes in meshByIdRef with matching
      // cache keys, takes the recolor-only fast path, and NEVER re-adds
      // them to the new itemsGroup. Visible symptom: blueprint reopens
      // showing labels + selection ring but no humanoid figures.
      itemsGroupRef.current = null;
      meshByIdRef.current.clear();
      hoverRingRef.current = null;
      selectionRingRef.current = null;
      panoMeshRef.current = null;
      gridRef.current = null;
      floorRef.current = null;
      ambientLightRef.current = null;
      mainLightRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize when width / height change. Also re-attach the renderer's
  // <canvas> when the host element is reparented (fullscreen toggle uses
  // a portal, which gives canvasHostRef a fresh DOM node).
  useEffect(() => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const host = canvasHostRef.current;
    if (!renderer || !camera || !host) return;
    if (renderer.domElement.parentNode !== host) {
      host.appendChild(renderer.domElement);
    }
    renderer.setSize(effectiveWidth, effectiveHeight, false);
    camera.aspect = effectiveWidth / effectiveHeight;
    camera.updateProjectionMatrix();
    requestRender();
  }, [effectiveWidth, effectiveHeight, isFullscreen, requestRender]);

  useEffect(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const nextFov = Math.max(10, Math.min(150, cameraFov));
    if (Math.abs(camera.fov - nextFov) > 0.01) {
      camera.fov = nextFov;
      camera.updateProjectionMatrix();
      requestRender();
    }
  }, [cameraFov, requestRender]);

  useEffect(() => {
    const maxDistance = mode === 'panorama' ? PANORAMA_MAX_CAMERA_DISTANCE : 80;
    const nextDistance = Math.max(2, Math.min(maxDistance, cameraDistance));
    if (Math.abs(cameraDistanceRef.current - nextDistance) >= 0.01) {
      cameraDistanceRef.current = nextDistance;
      camStateRef.current.distance = nextDistance;
    }
    applyCamera();
    requestRender();
  }, [applyCamera, cameraDistance, mode, requestRender]);

  useEffect(() => {
    const ambient = ambientLightRef.current;
    const main = mainLightRef.current;
    if (!ambient || !main) return;

    const normalized = { ...DEFAULT_LIGHTING, ...lighting };
    ambient.intensity = normalized.enabled ? Math.max(0, normalized.ambientIntensity) : 0;
    ambient.color.set(normalized.ambientColor || DEFAULT_LIGHTING.ambientColor);
    main.intensity = normalized.enabled ? Math.max(0, normalized.mainIntensity) : 0;
    main.color.set(normalized.mainColor || DEFAULT_LIGHTING.mainColor);

    const yawRad = THREE.MathUtils.degToRad(normalized.mainYaw);
    const pitchRad = THREE.MathUtils.degToRad(normalized.mainPitch);
    const distance = 24;
    main.position.set(
      distance * Math.cos(pitchRad) * Math.sin(yawRad),
      Math.max(0.5, distance * Math.sin(pitchRad)),
      distance * Math.cos(pitchRad) * Math.cos(yawRad),
    );
    main.castShadow = normalized.enabled && normalized.mainIntensity > 0;
    requestRender();
  }, [lighting, requestRender]);

  useEffect(() => {
    const normalized = { ...DEFAULT_GRID, ...grid };
    const gridObject = gridRef.current;
    const floor = floorRef.current;
    const hoverRing = hoverRingRef.current;
    const selectionRing = selectionRingRef.current;
    const height = Number.isFinite(normalized.height) ? normalized.height : DEFAULT_GRID.height;
    gridHeightRef.current = height;
    if (gridObject) {
      gridObject.visible = normalized.visible;
      gridObject.position.y = height;
    }
    if (floor) {
      floor.position.y = height;
      floor.visible = normalized.visible;
    }
    if (hoverRing) hoverRing.position.y = height + 0.01;
    if (selectionRing) selectionRing.position.y = height + 0.02;
    requestRender();
  }, [grid, requestRender]);

  // Fullscreen viewport size tracking
  useEffect(() => {
    if (!isFullscreen) return;
    const sync = () => setFsSize({ w: window.innerWidth, h: window.innerHeight });
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [isFullscreen]);

  // ESC exits fullscreen
  useEffect(() => {
    if (!isFullscreen || !keyboardShortcutsEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen, keyboardShortcutsEnabled]);

  // Panorama background sync
  useEffect(() => {
    const panoMesh = panoMeshRef.current;
    if (!panoMesh) return;

    const material = panoMesh.material as any;
    const clearPanoramaMap = () => {
      if (material.map) {
        material.map.dispose();
        material.map = null;
        material.needsUpdate = true;
      }
    };

    if (mode === 'panorama' && panoramaUrl) {
      let cancelled = false;
      clearPanoramaMap();
      panoMesh.visible = false;
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin('anonymous');
      const loadingTexture = loader.load(
        panoramaUrl,
        (tex: any) => {
          if (cancelled) {
            tex.dispose?.();
            return;
          }
          tex.colorSpace = (THREE as any).SRGBColorSpace ?? tex.colorSpace;
          material.map = tex;
          material.needsUpdate = true;
          panoMesh.visible = true;
          requestRender();
        },
        undefined,
        () => {
          if (cancelled) return;
          panoMesh.visible = false;
          requestRender();
        },
      );
      return () => {
        cancelled = true;
        if (material.map === loadingTexture) {
          material.map = null;
          material.needsUpdate = true;
        }
        loadingTexture.dispose?.();
      };
    } else {
      panoMesh.visible = false;
      clearPanoramaMap();
      requestRender();
    }
  }, [mode, panoramaUrl, requestRender]);

  // ---------------------------------------------------------------------
  // Mesh sync: rebuild meshes when items change
  // ---------------------------------------------------------------------
  useEffect(() => {
    const group = itemsGroupRef.current;
    if (!group) return;
    const currentIds = new Set(items.map((it) => it.id));
    for (const [id, mesh] of Array.from(meshByIdRef.current.entries())) {
      if (!currentIds.has(id)) {
        group.remove(mesh);
        disposeBlueprintItemMesh(mesh);
        meshByIdRef.current.delete(id);
      }
    }
    items.forEach((it) => {
      const p = ensurePos3d(it);
      let mesh = meshByIdRef.current.get(it.id);
      // Only shape inputs rebuild geometry; pose changes re-apply on the existing rig.
      const cacheKey = getItemMeshCacheKey(it, it.bodyControls, meshDetail);
      if (mesh && mesh.userData.cacheKey !== cacheKey) {
        group.remove(mesh);
        disposeBlueprintItemMesh(mesh);
        meshByIdRef.current.delete(it.id);
        mesh = undefined;
      }
      if (!mesh) {
        mesh = createBlueprintItemMesh(it, customActionPoses, it.bodyControls, meshDetail, () => { requestRender(); onAssetReady?.(); }, (error) => {
          const message = `${it.label}: ${error instanceof Error ? error.message : String(error)}`;
          onAssetLoadError?.(message);
        });
        group.add(mesh);
        meshByIdRef.current.set(it.id, mesh);
        if (mesh.userData.importedModelPending) {
          const placeholder = mesh;
          const itemId = it.id;
          void resolveImportedModelMesh(it).then((model) => {
            // Discard results for removed/rebuilt items or a torn-down scene.
            if (!model || meshByIdRef.current.get(itemId) !== placeholder || placeholder.parent !== itemsGroupRef.current) {
              if (model) disposeImportedModelMesh(model);
              return;
            }
            const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
            if (it.importedModelId && size.y > 0) importedModelHeights.set(it.importedModelId, size.y);
            for (const child of placeholder.children.slice()) {
              placeholder.remove(child);
              disposeImportedModelMesh(child);
            }
            model.traverse((object: InstanceType<typeof THREE.Object3D>) => { if (object.isMesh) object.name = `item:${itemId}`; });
            placeholder.add(model);
            placeholder.userData.importedModelPending = false;
            requestRender();
            onAssetReady?.();
          }).catch((error: unknown) => {
            placeholder.userData.importedModelError = error instanceof Error ? error.message : String(error);
            onAssetLoadError?.(`${it.label}: ${placeholder.userData.importedModelError}`);
            console.error('[stage] imported model failed to load', itemId, error);
          });
        }
      } else {
        if (it.category === 'person' && !motionPlaybackActiveRef.current) applyItemPose(mesh, resolveItemStaticPose(it, customActionPoses));
        // Cheap recolor without rebuilding geometry. Persons rebuild instead (their tint
        // depends on role), so this only touches object/scene materials.
        if (it.category !== 'person') {
          const col = new THREE.Color(it.color);
          mesh.traverse((o: InstanceType<typeof THREE.Mesh>) => {
            if (!o.isMesh || !o.material?.color || o.material.userData?.[BLUEPRINT_PRESERVE_MATERIAL_COLOR]) return;
            o.material.color.copy(col);
          });
        }
        // Defense-in-depth: if the cached mesh got orphaned from the
        // current itemsGroup (e.g. its old parent was a previous mount's
        // itemsGroup that the dispose path didn't traverse), re-attach it
        // so it actually renders. Without this, blueprint reopens that
        // hit the recolor path leave figures invisible.
        if (mesh.parent !== group) {
          mesh.parent?.remove(mesh);
          group.add(mesh);
        }
      }
      // Grounding lives inside the person rig, so the root sits exactly at the item position.
      const baseRotation = mesh.userData?.baseRotation ?? { x: 0, y: 0, z: 0 };
      const baseScale = mesh.userData?.baseScale ?? { x: 1, y: 1, z: 1 };
      const rotation = normalizeItemRotation(it);
      const scale = normalizeItemScale(it);
      mesh.rotation.set(
        baseRotation.x + rotation.x,
        baseRotation.y + rotation.y,
        baseRotation.z + rotation.z,
      );
      mesh.scale.set(
        baseScale.x * scale.x,
        baseScale.y * scale.y,
        baseScale.z * scale.z,
      );
      mesh.position.set(p.x, p.y, p.z);
      mesh.visible = it.hidden !== true;
    });
    requestRender();
  }, [items, customActionPoses, meshDetail, requestRender, onAssetLoadError, onAssetReady]);

  // Pose mode follows the edited person's current mesh (meshes are rebuilt when body shape changes).
  useEffect(() => {
    const editor = poseEditorRef.current;
    if (!editor) return;
    const item = poseEditItemId ? itemsByIdRef.current.get(poseEditItemId) : undefined;
    editor.attach(item?.category === 'person' && !item.locked && !item.hidden ? meshByIdRef.current.get(item.id) ?? null : null);
  }, [items, meshDetail, poseEditItemId]);

  useEffect(() => {
    poseEditorRef.current?.setJoint(poseEditItemId ? poseEditJoint : null);
  }, [poseEditItemId, poseEditJoint]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const previous = motionRoutesRef.current;
    if (previous) {
      previous.traverse((object: any) => {
        const mesh = object as any;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material as any;
        if (Array.isArray(material)) material.forEach((entry: any) => entry.dispose());
        else material?.dispose();
      });
      scene.remove(previous);
    }
    const routes = new THREE.Group();
    routes.name = '__directorMotionRoutes';
    const addRoute = (
      kind: DirectorMotionRouteSelection['kind'],
      trackId: string,
      keyframes: Array<{ id: string; time: number; position: DirectorMotionVector3 }>,
      color: number,
      dashed = false,
    ) => {
      const points = keyframes.map((keyframe) => new THREE.Vector3(
        keyframe.position.x,
        (kind === 'camera' ? gridHeightRef.current : keyframe.position.y) + 0.03,
        keyframe.position.z,
      ));
      if (points.length >= 2) {
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = dashed
          ? new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.95, dashSize: 0.22, gapSize: 0.1 })
          : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 });
        const line = new THREE.Line(geometry, material);
        line.userData.directorRouteTrack = { kind, trackId, keyframes };
        if (dashed) line.computeLineDistances();
        routes.add(line);
      }
      keyframes.forEach((keyframe, index) => {
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 14, 10),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 1,
            depthTest: false,
          }),
        );
        marker.position.copy(points[index]);
        marker.renderOrder = 20;
        marker.userData.directorRoutePoint = {
          kind,
          trackId,
          keyframeId: keyframe.id,
          time: keyframe.time,
          position: keyframe.position,
          color,
        };
        routes.add(marker);
      });
    };
    Object.entries(motionProject?.objectTracks ?? {}).forEach(([itemId, track]) => {
      const item = itemsRef.current.find((entry) => entry.id === itemId);
      if (item?.hidden || item?.locked) return;
      addRoute('object', itemId, track, itemsRef.current.find((item) => item.id === itemId)?.category === 'person' ? 0xf59e0b : 0x60a5fa, true);
    });
    addRoute('camera', 'camera', motionProject?.cameraTrack ?? [], 0x67e8f9);
    routes.visible = motionRoutesVisible && !exportModeRef.current && !motionPlaybackActiveRef.current;
    scene.add(routes);
    motionRoutesRef.current = routes;
    requestRender();
    return () => {
      routes.traverse((object: any) => {
        const mesh = object as any;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material as any;
        if (Array.isArray(material)) material.forEach((entry: any) => entry.dispose());
        else material?.dispose();
      });
      scene.remove(routes);
      if (motionRoutesRef.current === routes) motionRoutesRef.current = null;
    };
  }, [grid.height, items, motionProject, motionRoutesVisible, requestRender]);

  useEffect(() => {
    const routes = motionRoutesRef.current;
    if (!routes) return;
    routes.traverse((object: any) => {
      const point = object.userData?.directorRoutePoint;
      if (!point || !object.material) return;
      const selected = motionRouteSelection !== null
        && motionRouteSelection.kind === point.kind
        && motionRouteSelection.trackId === point.trackId
        && motionRouteSelection.keyframeId === point.keyframeId;
      object.scale.setScalar(selected ? 1.55 : 1);
      object.material.color.setHex(selected ? 0xffffff : point.color);
      object.material.opacity = 1;
    });
    requestRender();
  }, [motionRouteSelection, requestRender]);

  /** Dashed segment from the last placed point to the cursor; geometry is reused across moves. */
  const updateMotionRouteDraftRubber = useCallback(() => {
    const group = motionRouteDraftGroupRef.current;
    if (!group) return;
    const draft = motionRouteDraftRef.current;
    const last = motionRouteDraftPointsRef.current[motionRouteDraftPointsRef.current.length - 1];
    const hover = motionRouteDraftHoverRef.current;
    let rubber = motionRouteDraftRubberRef.current;
    if (!draft || draft.method === 'draw' || !last || !hover) {
      if (rubber?.visible) {
        rubber.visible = false;
        requestRender();
      }
      return;
    }
    if (!rubber) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geometry, new THREE.LineDashedMaterial({ dashSize: 0.18, gapSize: 0.12, depthTest: false, transparent: true, opacity: 0.9 }));
      line.renderOrder = 22;
      line.frustumCulled = false;
      group.add(line);
      rubber = line as RouteDraftRubberLine;
      motionRouteDraftRubberRef.current = rubber;
    }
    rubber.material.color.setHex(draft.kind === 'camera' ? 0x67e8f9 : 0xfbbf24);
    const position = rubber.geometry.attributes.position;
    position.setXYZ(0, last.x, last.y + 0.06, last.z);
    position.setXYZ(1, hover.x, hover.y + 0.06, hover.z);
    position.needsUpdate = true;
    rubber.computeLineDistances();
    rubber.visible = true;
    requestRender();
  }, [requestRender]);

  const refreshMotionRouteDraftVisual = useCallback(() => {
    const group = motionRouteDraftGroupRef.current;
    if (!group) return;
    motionRouteDraftRubberRef.current = null;
    group.children.slice().forEach((child: any) => {
      group.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    });
    const points = motionRouteDraftPointsRef.current;
    onMotionRouteDraftProgressRef.current?.(points.length);
    const color = motionRouteDraftRef.current?.kind === 'camera' ? 0x67e8f9 : 0xfbbf24;
    if (points.length >= 2) {
      const geometry = new THREE.BufferGeometry().setFromPoints(points.map((point) => new THREE.Vector3(point.x, point.y + 0.06, point.z)));
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, depthTest: false }));
      line.renderOrder = 22;
      group.add(line);
    }
    points.forEach((point) => {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.075, 8, 6),
        new THREE.MeshBasicMaterial({ color, depthTest: false }),
      );
      marker.position.set(point.x, point.y + 0.06, point.z);
      marker.renderOrder = 23;
      group.add(marker);
    });
    updateMotionRouteDraftRubber();
    requestRender();
  }, [requestRender, updateMotionRouteDraftRubber]);

  useEffect(() => {
    motionRouteDraftPointsRef.current = [];
    motionRouteDraftHoverRef.current = null;
    motionRouteDraftRubberRef.current = null;
    onMotionRouteDraftProgressRef.current?.(0);
    const scene = sceneRef.current;
    if (!motionRouteDraft || !scene) return;
    const group = new THREE.Group();
    group.name = '__directorMotionRouteDraft';
    scene.add(group);
    motionRouteDraftGroupRef.current = group;
    requestRender();
    return () => {
      group.children.slice().forEach((child: any) => {
        child.geometry?.dispose();
        child.material?.dispose();
      });
      scene.remove(group);
      if (motionRouteDraftGroupRef.current === group) motionRouteDraftGroupRef.current = null;
      motionRouteDraftPointsRef.current = [];
      motionRouteDraftHoverRef.current = null;
      motionRouteDraftRubberRef.current = null;
      requestRender();
    };
  }, [motionRouteDraft?.kind, motionRouteDraft?.trackId, motionRouteDraft?.method, refreshMotionRouteDraftVisual, requestRender]);

  const completeMotionRouteDraft = useCallback(() => {
    if (!motionRouteDraftRef.current || motionRouteDraftPointsRef.current.length < 2) return false;
    onMotionRouteDraftComplete?.([...motionRouteDraftPointsRef.current]);
    motionRouteDraftPointsRef.current = [];
    refreshMotionRouteDraftVisual();
    return true;
  }, [onMotionRouteDraftComplete, refreshMotionRouteDraftVisual]);

  const cancelMotionRouteDraft = useCallback(() => {
    motionRouteDraftPointsRef.current = [];
    motionRouteDraftHoverRef.current = null;
    refreshMotionRouteDraftVisual();
  }, [refreshMotionRouteDraftVisual]);

  useEffect(() => {
    if (!motionRouteDraft) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelMotionRouteDraft();
        onMotionRouteDraftCancel?.();
        return;
      }
      // Enter finishes a point route; a focused rail button must not re-toggle the tool instead.
      if (event.key !== 'Enter' || motionRouteDraftRef.current?.method !== 'points') return;
      if ((event.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      completeMotionRouteDraft();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [cancelMotionRouteDraft, completeMotionRouteDraft, motionRouteDraft, onMotionRouteDraftCancel]);

  const commitTransformFromMesh = useCallback((itemId: string) => {
    const mesh = meshByIdRef.current.get(itemId);
    if (!mesh) return;
    const item = itemsRef.current.find((it) => it.id === itemId);
    if (!item || item.locked || item.hidden) return;

    const baseRotation = (mesh as any).userData?.baseRotation ?? { x: 0, y: 0, z: 0 };
    const baseScale = (mesh as any).userData?.baseScale ?? { x: 1, y: 1, z: 1 };
    const scale = {
      x: THREE.MathUtils.clamp(baseScale.x ? mesh.scale.x / baseScale.x : 1, 0.1, 5),
      y: THREE.MathUtils.clamp(baseScale.y ? mesh.scale.y / baseScale.y : 1, 0.1, 5),
      z: THREE.MathUtils.clamp(baseScale.z ? mesh.scale.z / baseScale.z : 1, 0.1, 5),
    };
    mesh.scale.set(baseScale.x * scale.x, baseScale.y * scale.y, baseScale.z * scale.z);

    const clampedMeshPosition = new THREE.Vector3(mesh.position.x, mesh.position.y, mesh.position.z);
    if (modeRef.current === 'panorama') {
      clampPanoramaPointAtFixedY(clampedMeshPosition);
      mesh.position.copy(clampedMeshPosition);
    }
    const pos3d = {
      x: clampedMeshPosition.x,
      y: clampedMeshPosition.y,
      z: clampedMeshPosition.z,
    };
    const legacy = pos3dToLegacy(pos3d);
    const rotation3d = {
      x: mesh.rotation.x - baseRotation.x,
      y: mesh.rotation.y - baseRotation.y,
      z: mesh.rotation.z - baseRotation.z,
    };

    onItemsChangeRef.current(itemsRef.current.map((it) =>
      it.id === itemId
        ? { ...it, pos3d, x: legacy.x, y: legacy.y, rotation3d, scale3d: scale }
        : it
    ));
  }, []);

  const syncCameraGuide = useCallback(() => {
    const guide = cameraGuideRef.current, camera = cameraRef.current;
    if (!guide || !camera) return;
    guide.group.visible = cameraSelectedRef.current && !exportModeRef.current && !motionPlaybackActiveRef.current && !pilotStateRef.current.active && motionPreviewModeRef.current === 'route';
    if (transformDraggingRef.current || cameraEndpointDragRef.current) return;
    guide.update(shotCameraFrameRef.current ?? { position: camera.position, target: camStateRef.current.target, fov: camera.fov });
  }, []);
  useEffect(() => { syncCameraGuide(); requestRender(); }, [cameraSelected, motionProject, pilotActive, requestRender, syncCameraGuide]);

  const commitSelectedTransforms = useCallback(() => {
    const captured = transformStartRef.current;
    if (!captured || captured.matrices.size <= 1) {
      if (selectedItemIdRef.current) commitTransformFromMesh(selectedItemIdRef.current);
      return;
    }
    onItemsChangeRef.current(itemsRef.current.map((item) => {
      const mesh = meshByIdRef.current.get(item.id);
      if (!captured.matrices.has(item.id) || !mesh || item.locked || item.hidden) return item;
      const baseRotation = mesh.userData.baseRotation ?? { x: 0, y: 0, z: 0 };
      const baseScale = mesh.userData.baseScale ?? { x: 1, y: 1, z: 1 };
      const pos3d = { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z };
      const legacy = pos3dToLegacy(pos3d);
      return { ...item, ...legacy, pos3d,
        rotation3d: { x: mesh.rotation.x - baseRotation.x, y: mesh.rotation.y - baseRotation.y, z: mesh.rotation.z - baseRotation.z },
        scale3d: { x: mesh.scale.x / (baseScale.x || 1), y: mesh.scale.y / (baseScale.y || 1), z: mesh.scale.z / (baseScale.z || 1) } };
    }));
  }, [commitTransformFromMesh]);

  useEffect(() => {
    const controls = transformControlsRef.current;
    if (!controls) return;

    const handleChange = () => requestRender();
    const handleObjectChange = () => {
      const captured = transformStartRef.current;
      const object = controls.object;
      const guide = cameraGuideRef.current;
      if (guide && object === guide.camera) {
        guide.rotateTarget(guide.camera.position.distanceTo(guide.endpoint.position));
        const { x, y, z } = guide.camera.rotation;
        const previous = shotCameraFrameRef.current;
        shotCameraFrameRef.current = { position: { ...guide.camera.position }, target: { ...guide.endpoint.position }, fov: previous?.fov ?? cameraRef.current?.fov ?? 45, freeRotation: { x, y, z } };
      }
      if (captured && object) {
        object.updateMatrixWorld(true);
        if (captured.matrices.size > 1) {
          const delta = object.matrixWorld.clone().multiply(captured.inverse);
          for (const [id, matrix] of captured.matrices) {
            const mesh = meshByIdRef.current.get(id);
            if (mesh) delta.clone().multiply(matrix).decompose(mesh.position, mesh.quaternion, mesh.scale);
          }
        }
        const distance = object.position.distanceTo(captured.position);
        const angle = Math.max(Math.abs(object.rotation.x - captured.rotation.x), Math.abs(object.rotation.y - captured.rotation.y), Math.abs(object.rotation.z - captured.rotation.z)) * 180 / Math.PI;
        const hint = controls.mode === 'rotate' ? `Δ ${angle.toFixed(1)}°` : controls.mode === 'scale' ? `× ${object.scale.x.toFixed(2)}` : `Δ ${distance.toFixed(2)}m`;
        if (hint !== displayedTransformHintRef.current) { displayedTransformHintRef.current = hint; setTransformHint(hint); }
      }
      if (modeRef.current === 'panorama' && selectedItemIdRef.current) {
        const mesh = meshByIdRef.current.get(selectedItemIdRef.current);
        if (mesh) {
          const clampedPosition = new THREE.Vector3(mesh.position.x, mesh.position.y, mesh.position.z);
          clampPanoramaPointAtFixedY(clampedPosition);
          mesh.position.copy(clampedPosition);
        }
      }
      requestRender();
    };
    const handleDraggingChanged = (event: { value?: boolean }) => {
      transformDraggingRef.current = Boolean(event.value);
      if (event.value && controls.object) {
        if (controls.object === cameraGuideRef.current?.camera) cameraTransformOriginalRef.current = shotCameraFrameRef.current;
        controls.object.updateMatrixWorld(true);
        const matrices = new Map<string, InstanceType<typeof THREE.Matrix4>>();
        for (const id of selectedIdsRef.current) {
          const item = itemsRef.current.find((entry) => entry.id === id);
          const mesh = meshByIdRef.current.get(id);
          if (!mesh || item?.locked || item?.hidden) continue;
          mesh.updateMatrixWorld(true); matrices.set(id, mesh.matrixWorld.clone());
        }
        transformStartRef.current = { inverse: controls.object.matrixWorld.clone().invert(), position: controls.object.position.clone(), rotation: controls.object.rotation.clone(), matrices };
      } else if (!event.value) {
        const guide = cameraGuideRef.current;
        if (guide && controls.object === guide.camera && transformStartRef.current) {
          const before = transformStartRef.current.rotation, after = guide.camera.rotation;
          if (before.x !== after.x || before.y !== after.y || before.z !== after.z) {
            const applied = onCameraLookAtRef.current?.({ mode: 'free', rotation: { x: after.x, y: after.y, z: after.z } });
            if (!applied) { shotCameraFrameRef.current = cameraTransformOriginalRef.current; syncCameraGuide(); }
          }
        } else if (selectedItemIdRef.current) commitSelectedTransforms();
        transformStartRef.current = null; displayedTransformHintRef.current = ''; setTransformHint('');
      }
      requestRender();
    };

    controls.addEventListener('change', handleChange);
    controls.addEventListener('objectChange', handleObjectChange);
    controls.addEventListener('dragging-changed', handleDraggingChanged);
    return () => {
      controls.removeEventListener('change', handleChange);
      controls.removeEventListener('objectChange', handleObjectChange);
      controls.removeEventListener('dragging-changed', handleDraggingChanged);
    };
  }, [commitSelectedTransforms, requestRender, syncCameraGuide]);

  useEffect(() => {
    const controls = transformControlsRef.current;
    const helper = transformHelperRef.current;
    if (!controls || !helper) return;

    const guide = cameraGuideRef.current;
    if (cameraSelected && transformMode === 'rotate' && guide) {
      syncCameraGuide();
      if (controls.object !== guide.camera) {
        // The authored shot camera may be behind or above the editing viewport.
        // Center its gizmo without moving the authored camera itself.
        camStateRef.current.target.copy(guide.camera.position);
        camStateRef.current.distance = Math.max(3, Math.min(8, camStateRef.current.distance));
        applyCamera();
      }
      controls.enabled = true; controls.setMode('rotate'); controls.setSpace('local');
      controls.showX = true; controls.showY = true; controls.showZ = true;
      controls.attach(guide.camera); helper.visible = true; requestRender(); return;
    }
    const selected = items.find((item) => item.id === selectedItemId);
    if (!transformMode || !selectedItemId || selected?.locked || selected?.hidden || selectedIdsRef.current.some((id) => items.find((item) => item.id === id)?.locked)) {
      controls.detach();
      controls.enabled = false;
      helper.visible = false;
      requestRender();
      return;
    }

    let mesh = meshByIdRef.current.get(selectedItemId);
    const targets = selectedIdsRef.current.map((id) => items.find((item) => item.id === id)).filter((item) => item && !item.locked && !item.hidden);
    if (targets.length > 1 && sceneRef.current && !controls.dragging) {
      const pivot = selectionPivotRef.current ?? new THREE.Group();
      selectionPivotRef.current = pivot;
      if (!pivot.parent) sceneRef.current.add(pivot);
      const bounds = new THREE.Box3();
      for (const item of targets) { if (item) { const object = meshByIdRef.current.get(item.id); if (object) bounds.expandByObject(object); } }
      const center = bounds.getCenter(new THREE.Vector3());
      pivot.position.copy(center); pivot.rotation.set(0, 0, 0); pivot.scale.set(1, 1, 1); mesh = pivot;
    }
    if (!mesh) {
      controls.detach();
      controls.enabled = false;
      helper.visible = false;
      requestRender();
      return;
    }

    controls.enabled = true;
    if (!controls.dragging) {
      controls.setMode(toThreeTransformMode(transformMode));
      controls.setSpace(transformMode === 'move' ? 'world' : 'local');
      controls.setSize(transformMode === 'rotate' ? 0.95 : 0.85);
    }
    if (controls.object !== mesh) {
      controls.attach(mesh);
    }
    helper.visible = true;
    requestRender();
  }, [items, requestRender, selectedItemId, selectedItemIds, transformMode, cameraSelected, syncCameraGuide, applyCamera]);

  useEffect(() => {
    const update = (event: KeyboardEvent) => {
      const controls = transformControlsRef.current;
      if (!controls) return;
      const selected = itemsRef.current.find((item) => item.id === selectedItemIdRef.current);
      controls.setTranslationSnap(event.metaKey || event.ctrlKey ? 0.5 : null);
      controls.setRotationSnap(event.metaKey || event.ctrlKey ? Math.PI / 12 : null);
      const ground = transformMode === 'move' && selected?.category !== 'scene' && !event.shiftKey;
      const yawOnly = transformMode === 'rotate' && selected?.category === 'person' && !event.shiftKey;
      controls.showX = !yawOnly; controls.showY = !ground; controls.showZ = !yawOnly;
      requestRender();
    };
    window.addEventListener('keydown', update); window.addEventListener('keyup', update);
    update(new KeyboardEvent('keyup'));
    return () => { window.removeEventListener('keydown', update); window.removeEventListener('keyup', update); };
  }, [transformMode, selectedItemId, requestRender]);

  // ---------------------------------------------------------------------
  // Selection ring follows the currently-selected item
  // ---------------------------------------------------------------------
  useEffect(() => {
    const ring = selectionRingRef.current;
    if (!ring) return;
    const item = items.find((it) => it.id === selectedItemId);
    if (!item || item.hidden) {
      ring.visible = false;
      requestRender();
      return;
    }
    const p = ensurePos3d(item);
    const itemScale = normalizeItemScale(item);
    const ringScale = Math.max(0.82, Math.min(2.8, getItemHeight(item) * Math.max(itemScale.x, itemScale.z) * 0.54));
    setRingAppearance(ring, DIRECTOR_GRID_PALETTE.selection, 0.96);
    ring.scale.setScalar(ringScale);
    const displayedPosition = meshByIdRef.current.get(item.id)?.position ?? p;
    ring.position.set(displayedPosition.x, gridHeightRef.current + 0.02, displayedPosition.z);
    ring.visible = true;
    requestRender();
  }, [items, selectedItemId, requestRender]);

  // Optional: re-aim camera at the selected item.
  useEffect(() => {
    if (!followSelectedItem || !selectedItemId) return;
    const item = items.find((it) => it.id === selectedItemId);
    if (!item) return;
    const p = ensurePos3d(item);
    camStateRef.current.target.set(p.x, Math.max(0.4, p.y + 0.9), p.z);
    applyCamera();
    requestRender();
  }, [followSelectedItem, items, selectedItemId, applyCamera, requestRender]);

  // ---------------------------------------------------------------------
  // Mini-map rendering
  // ---------------------------------------------------------------------
  const drawMiniMap = useCallback(() => {
    const canvas = miniMapRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    const theme = getComputedStyle(canvas);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = `rgb(${theme.getPropertyValue('--raised-rgb').trim()})`;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = theme.getPropertyValue('--line').trim();
    ctx.lineWidth = 1;
    const step = 10;
    for (let x = 0; x <= W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    const worldExtent = 20;
    const toMini = (wx: number, wz: number) => ({
      x: ((wx / worldExtent) + 0.5) * W,
      y: ((wz / worldExtent) + 0.5) * H,
    });
    for (const it of itemsRef.current) {
      const p = ensurePos3d(it);
      const m = toMini(p.x, p.z);
      ctx.fillStyle = it.color;
      ctx.beginPath();
      ctx.arc(m.x, m.y, it.id === selectedItemIdRef.current ? 5 : 3, 0, Math.PI * 2);
      ctx.fill();
    }
    const cam = cameraRef.current;
    if (cam) {
      const camXZ = toMini(cam.position.x, cam.position.z);
      const fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      const angle = Math.atan2(fwd.x, fwd.z);
      ctx.fillStyle = `rgb(${theme.getPropertyValue('--accent-rgb').trim()} / 0.9)`;
      ctx.beginPath();
      ctx.moveTo(camXZ.x + Math.sin(angle) * 6, camXZ.y + Math.cos(angle) * 6);
      ctx.lineTo(camXZ.x + Math.sin(angle + 2.5) * 5, camXZ.y + Math.cos(angle + 2.5) * 5);
      ctx.lineTo(camXZ.x + Math.sin(angle - 2.5) * 5, camXZ.y + Math.cos(angle - 2.5) * 5);
      ctx.closePath();
      ctx.fill();
    }
  }, []);
  useEffect(() => { drawMiniMap(); }, [drawMiniMap, items, selectedItemId]);

  // ---------------------------------------------------------------------
  // Pointer interactions
  // ---------------------------------------------------------------------
  const interactRef = useRef<{
    mode: 'idle' | 'orbit' | 'pan' | 'drag' | 'routeDrag' | 'routePoint' | 'routeDraw' | 'pose' | 'marquee';
    dragItemId: string | null;
    dragLastPos3d: { x: number; y: number; z: number } | null;
    routeSelection: DirectorMotionRouteSelection | null;
    routeDragObject: any | null;
    routePlaneY: number;
    routeLastPosition: DirectorMotionVector3 | null;
    lastX: number;
    lastY: number;
    pointerId: number | null;
    moved: boolean;
  }>({
    mode: 'idle',
    dragItemId: null,
    dragLastPos3d: null,
    routeSelection: null,
    routeDragObject: null,
    routePlaneY: 0,
    routeLastPosition: null,
    lastX: 0,
    lastY: 0,
    pointerId: null,
    moved: false,
  });

  const getLocalXY = (e: PointerEvent | React.PointerEvent | React.MouseEvent) => {
    const rect = rendererRef.current!.domElement.getBoundingClientRect();
    return { x: (e as any).clientX - rect.left, y: (e as any).clientY - rect.top };
  };
  const ndc = (x: number, y: number) => ({
    x: (x / effectiveWidth) * 2 - 1,
    y: -((y / effectiveHeight) * 2 - 1),
  });
  const setCanvasCursor = useCallback((cursor: string) => {
    const canvas = rendererRef.current?.domElement as HTMLCanvasElement | undefined;
    if (canvas && canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  }, []);

  const isTransformControlPointerActive = useCallback((lx: number, ly: number, button = 0) => {
    const controls = transformControlsRef.current;
    if (!controls?.enabled || !transformMode || (!selectedItemIdRef.current && !cameraSelectedRef.current)) return false;
    if (controls.dragging) return true;
    const n = ndc(lx, ly);
    controls.pointerHover({ x: n.x, y: n.y, button });
    return Boolean(controls.axis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveWidth, effectiveHeight, transformMode]);

  const raycastMotionRoutePoint = useCallback((lx: number, ly: number) => {
    const camera = cameraRef.current;
    const routes = motionRoutesRef.current;
    if (!camera || !routes?.visible || exportModeRef.current) return null;
    const rc = new THREE.Raycaster();
    const n = ndc(lx, ly);
    rc.setFromCamera(new THREE.Vector2(n.x, n.y), camera);
    const hit = rc.intersectObjects(routes.children, true)
      .find((candidate: any) => candidate.object.userData?.directorRoutePoint);
    if (!hit) return null;
    const data = (hit.object as any).userData.directorRoutePoint as {
      kind: DirectorMotionRouteSelection['kind'];
      trackId: string;
      keyframeId: string;
      time: number;
      position: DirectorMotionVector3;
    };
    return {
      selection: { kind: data.kind, trackId: data.trackId, keyframeId: data.keyframeId },
      time: data.time,
      position: data.position,
      object: hit.object as any,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveHeight, effectiveWidth]);

  const raycastMotionRouteSegment = useCallback((lx: number, ly: number) => {
    const camera = cameraRef.current;
    const routes = motionRoutesRef.current;
    if (!camera || !routes?.visible || exportModeRef.current) return null;
    const rc = new THREE.Raycaster();
    rc.params.Line = { threshold: 0.28 };
    const n = ndc(lx, ly);
    rc.setFromCamera(new THREE.Vector2(n.x, n.y), camera);
    const hit = rc.intersectObjects(routes.children, false)
      .find((candidate: any) => candidate.object.userData?.directorRouteTrack);
    if (!hit) return null;
    const data = (hit.object as any).userData.directorRouteTrack as {
      kind: DirectorMotionRouteSelection['kind'];
      trackId: string;
      keyframes: Array<{ time: number; position: DirectorMotionVector3 }>;
    };
    let best: { distance: number; time: number; position: DirectorMotionVector3 } | null = null;
    for (let index = 0; index < data.keyframes.length - 1; index += 1) {
      const from = data.keyframes[index];
      const to = data.keyframes[index + 1];
      const line = new THREE.Line3(
        new THREE.Vector3(from.position.x, (data.kind === 'camera' ? gridHeightRef.current : from.position.y) + 0.03, from.position.z),
        new THREE.Vector3(to.position.x, (data.kind === 'camera' ? gridHeightRef.current : to.position.y) + 0.03, to.position.z),
      );
      // A vertical camera move collapses to one point in the ground view.
      // It has no projected segment to split; edit its height in the inspector.
      if (line.start.distanceToSquared(line.end) < 0.000001) continue;
      const amount = line.closestPointToPointParameter((hit as any).point, true);
      const closest = line.at(amount, new THREE.Vector3());
      const distance = closest.distanceTo((hit as any).point);
      if (best && distance >= best.distance) continue;
      best = {
        distance,
        time: THREE.MathUtils.lerp(from.time, to.time, amount),
        position: {
          x: THREE.MathUtils.lerp(from.position.x, to.position.x, amount),
          y: THREE.MathUtils.lerp(from.position.y, to.position.y, amount),
          z: THREE.MathUtils.lerp(from.position.z, to.position.z, amount),
        },
      };
    }
    return best ? { ...best, kind: data.kind, trackId: data.trackId } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveHeight, effectiveWidth]);

  const raycastItem = useCallback((lx: number, ly: number): string | null => {
    const camera = cameraRef.current!;
    const group = itemsGroupRef.current!;
    const rc = new THREE.Raycaster();
    const n = ndc(lx, ly);
    rc.setFromCamera(new THREE.Vector2(n.x, n.y), camera);
    const selectable = group.children.filter((child: InstanceType<typeof THREE.Object3D>) => {
      const item = itemsRef.current.find((entry) => entry.id === child.userData.itemId);
      return item && !item.hidden && !item.locked;
    });
    const hits = rc.intersectObjects(selectable, true);
    if (hits.length > 0) {
      const first: any = hits[0].object;
      if (first.name && first.name.startsWith('item:')) return first.name.slice(5);
      let p: any = first.parent;
      while (p) {
        if (p.userData?.itemId) return p.userData.itemId;
        p = p.parent;
      }
    }
    // Fallback: nearest-on-screen within 24px so thin silhouettes remain
    // selectable when raycast misses by a hair.
    let bestId: string | null = null;
    let bestDist = 24;
    for (const child of selectable) {
      const itemId = (child as any).userData?.itemId;
      if (!itemId) continue;
      const wp = new THREE.Vector3();
      (child as any).getWorldPosition(wp);
      wp.y += 0.6;
      const proj = wp.clone().project(camera);
      if (proj.z > 1 || proj.z < -1) continue;
      const sx = (proj.x * 0.5 + 0.5) * effectiveWidth;
      const sy = (-proj.y * 0.5 + 0.5) * effectiveHeight;
      const d = Math.hypot(sx - lx, sy - ly);
      if (d < bestDist) { bestDist = d; bestId = itemId; }
    }
    return bestId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveWidth, effectiveHeight]);

  const raycastGround = useCallback((lx: number, ly: number, atY = gridHeightRef.current): any | null => {
    const camera = cameraRef.current!;
    const rc = new THREE.Raycaster();
    const n = ndc(lx, ly);
    rc.setFromCamera(new THREE.Vector2(n.x, n.y), camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -atY);
    const target = new THREE.Vector3();
    return rc.ray.intersectPlane(plane, target) ? target : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveWidth, effectiveHeight]);

  /** Ground point for the route draft; `orthogonal` (Shift) snaps to the last point's X or Z axis. */
  const routeDraftGroundPoint = useCallback((lx: number, ly: number, orthogonal: boolean): DirectorMotionVector3 | null => {
    const hit = raycastGround(lx, ly, gridHeightRef.current);
    if (!hit) return null;
    if (modeRef.current === 'panorama') clampPanoramaPointAtFixedY(hit);
    const point = { x: hit.x, y: hit.y, z: hit.z };
    const points = motionRouteDraftPointsRef.current;
    const previous = points[points.length - 1];
    if (orthogonal && previous) {
      if (Math.abs(point.x - previous.x) >= Math.abs(point.z - previous.z)) point.z = previous.z;
      else point.x = previous.x;
    }
    return point;
  }, [raycastGround]);

  const appendMotionRouteDraftPoint = useCallback((lx: number, ly: number, minDistance = 0.04, orthogonal = false) => {
    const point = routeDraftGroundPoint(lx, ly, orthogonal);
    if (!point) return;
    const points = motionRouteDraftPointsRef.current;
    const previous = points[points.length - 1];
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) < minDistance) return;
    if (points.length >= 192) return;
    points.push(point);
    refreshMotionRouteDraftVisual();
  }, [refreshMotionRouteDraftVisual, routeDraftGroundPoint]);

  const hoverMotionRouteDraft = useCallback((lx: number, ly: number, orthogonal: boolean) => {
    motionRouteDraftHoverRef.current = routeDraftGroundPoint(lx, ly, orthogonal);
    updateMotionRouteDraftRubber();
    // Labels (numbers, live length) are positioned in the render pass.
    requestRender();
  }, [requestRender, routeDraftGroundPoint, updateMotionRouteDraftRubber]);

  const getSuggestedInsertPosition = useCallback(() => {
    const centerGround = cameraRef.current
      ? raycastGround(effectiveWidth / 2, effectiveHeight / 2, gridHeightRef.current)
      : null;
    const fallbackTarget = camStateRef.current.target;
    const point = Number.isFinite(centerGround?.x) && Number.isFinite(centerGround?.z)
      ? centerGround!.clone()
      : new THREE.Vector3(fallbackTarget.x, gridHeightRef.current, fallbackTarget.z);
    point.y = gridHeightRef.current;
    if (modeRef.current === 'panorama') {
      clampPanoramaPointAtFixedY(point);
    }
    return {
      x: Math.round(point.x * 2) / 2,
      y: point.y,
      z: Math.round(point.z * 2) / 2,
    };
  }, [effectiveHeight, effectiveWidth, raycastGround]);

  const applyPilotCamera = useCallback(() => {
    const camera = cameraRef.current;
    if (!camera || !pilotStateRef.current.active) return;
    const state = pilotStateRef.current;
    const direction = new THREE.Vector3(
      Math.cos(state.pitch) * Math.sin(state.yaw),
      Math.sin(state.pitch),
      Math.cos(state.pitch) * Math.cos(state.yaw),
    ).normalize();
    if (modeRef.current === 'panorama') {
      clampVectorToRadiusInPlace(state.position, PANORAMA_CAMERA_RADIUS_LIMIT);
    }
    const target = state.position.clone().addScaledVector(direction, 3);
    if (modeRef.current === 'panorama') {
      clampPanoramaCameraPoints(state.position, target);
    }
    camera.position.copy(state.position);
    camera.lookAt(target);
    camStateRef.current.target.copy(target);
    camStateRef.current.distance = Math.max(0.01, state.position.distanceTo(target));
    cameraSnapshotTargetRef.current = {
      position: { x: state.position.x, y: state.position.y, z: state.position.z },
      target: { x: target.x, y: target.y, z: target.z },
      fov: camera.fov,
      trackTargetId: cameraSnapshotTargetRef.current?.trackTargetId ?? null,
      trackTargetBodyPart: cameraSnapshotTargetRef.current?.trackTargetBodyPart ?? null,
    };
    requestRender();
  }, [requestRender]);

  useEffect(() => {
    if (!pilotActive) {
      pilotStateRef.current.active = false;
      return;
    }
    const canvas = rendererRef.current?.domElement as HTMLCanvasElement | undefined;
    if (!canvas) return;
    pilotStateRef.current.active = true;
    const keys = new Set<string>();
    let moveRaf: number | null = null;
    const clear = () => {
      keys.clear();
      if (moveRaf !== null) cancelAnimationFrame(moveRaf);
      moveRaf = null;
    };
    const step = () => {
      if (!pilotStateRef.current.active || !cameraRef.current) { moveRaf = null; return; }
      const state = pilotStateRef.current;
      const speed = keys.has('shift') ? 0.16 : 0.06;
      const forward = new THREE.Vector3(Math.sin(state.yaw), 0, Math.cos(state.yaw));
      const right = new THREE.Vector3(forward.z, 0, -forward.x);
      if (keys.has('w') || keys.has('arrowup')) state.position.addScaledVector(forward, speed);
      if (keys.has('s') || keys.has('arrowdown')) state.position.addScaledVector(forward, -speed);
      if (keys.has('a') || keys.has('arrowleft')) state.position.addScaledVector(right, -speed);
      if (keys.has('d') || keys.has('arrowright')) state.position.addScaledVector(right, speed);
      if (keys.has('e')) state.position.y += speed;
      if (keys.has('q')) state.position.y -= speed;
      applyPilotCamera();
      moveRaf = requestAnimationFrame(step);
    };
    const ensureMove = () => {
      if (moveRaf === null) moveRaf = requestAnimationFrame(step);
    };
    const onKeyDownPilot = (event: KeyboardEvent) => {
      if (isEditableKeyboardTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'escape') {
        event.preventDefault();
        pilotStateRef.current.active = false;
        if (document.pointerLockElement) document.exitPointerLock?.();
        onPilotActiveChange?.(false);
        return;
      }
      if (key === 'enter') {
        event.preventDefault();
        const camera = getCameraSnapshot();
        if (camera) onPilotRecordCamera?.(camera);
        return;
      }
      if (key === 'f') {
        event.preventDefault();
        const target = raycastItem(effectiveWidth / 2, effectiveHeight / 2);
        onPilotTargetChange?.(target);
        cameraSnapshotTargetRef.current = {
          ...(cameraSnapshotTargetRef.current ?? getCameraSnapshot()!),
          trackTargetId: target,
        };
        return;
      }
      if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(key)) {
        keys.add(key);
        event.preventDefault();
        ensureMove();
      }
    };
    const onKeyUpPilot = (event: KeyboardEvent) => keys.delete(event.key.toLowerCase());
    const onMouseMovePilot = (event: MouseEvent) => {
      if (!pilotStateRef.current.active) return;
      pilotStateRef.current.yaw -= event.movementX * 0.0024;
      pilotStateRef.current.pitch = THREE.MathUtils.clamp(pilotStateRef.current.pitch - event.movementY * 0.0024, -1.35, 1.35);
      applyPilotCamera();
    };
    const onPointerLockChange = () => {
      if (document.pointerLockElement !== canvas && pilotStateRef.current.active) {
        pilotStateRef.current.active = false;
        onPilotActiveChange?.(false);
      }
    };
    window.addEventListener('keydown', onKeyDownPilot, true);
    window.addEventListener('keyup', onKeyUpPilot, true);
    window.addEventListener('mousemove', onMouseMovePilot);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    return () => {
      window.removeEventListener('keydown', onKeyDownPilot, true);
      window.removeEventListener('keyup', onKeyUpPilot, true);
      window.removeEventListener('mousemove', onMouseMovePilot);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      clear();
    };
  }, [applyPilotCamera, effectiveHeight, effectiveWidth, getCameraSnapshot, onPilotActiveChange, onPilotRecordCamera, onPilotTargetChange, pilotActive, raycastItem]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!rendererRef.current) return;
    if (pilotStateRef.current.active) {
      requestPilotPointerLock(rendererRef.current.domElement as HTMLCanvasElement, () => {
        pilotStateRef.current.active = false;
        onPilotActiveChange?.(false);
      });
      e.preventDefault();
      return;
    }
    const local = getLocalXY(e);
    if ((orbitNavigationRef.current || e.altKey) && e.button === 0) {
      try { hostElRef.current?.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      Object.assign(interactRef.current, { mode: e.shiftKey ? 'pan' : 'orbit', pointerId: e.pointerId,
        lastX: local.x, lastY: local.y, moved: false, dragItemId: null, dragLastPos3d: null });
      e.preventDefault();
      return;
    }
    const routeDraft = motionRouteDraftRef.current;
    if (routeDraft && e.button === 0) {
      try { hostElRef.current?.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      interactRef.current.mode = routeDraft.method === 'draw' ? 'routeDraw' : 'routePoint';
      interactRef.current.pointerId = e.pointerId;
      interactRef.current.lastX = local.x;
      interactRef.current.lastY = local.y;
      interactRef.current.moved = false;
      if (routeDraft.method === 'draw') appendMotionRouteDraftPoint(local.x, local.y);
      e.preventDefault();
      return;
    }
    const poseEditor = poseEditorRef.current;
    if (poseEditor?.attachedRoot && e.button === 0 && !motionPlaybackActiveRef.current && cameraRef.current) {
      const n = ndc(local.x, local.y);
      // The joint gizmo handles its own press (it listens on the canvas before React).
      if (poseEditor.hoversGizmo(n, e.button)) {
        interactRef.current.mode = 'idle';
        return;
      }
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(n.x, n.y), cameraRef.current);
      if (poseEditor.pointerDown(n, { width: effectiveWidth, height: effectiveHeight }, cameraRef.current, rc)) {
        try { hostElRef.current?.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        interactRef.current.mode = 'pose';
        interactRef.current.pointerId = e.pointerId;
        e.preventDefault();
        return;
      }
    }
    const guide = cameraGuideRef.current, viewportCamera = cameraRef.current;
    if (e.button === 0 && guide?.group.visible && viewportCamera) {
      const ray = new THREE.Raycaster(), point = ndc(local.x, local.y);
      ray.setFromCamera(new THREE.Vector2(point.x, point.y), viewportCamera);
      guide.group.updateMatrixWorld(true);
      const projected = guide.endpoint.position.clone().project(viewportCamera);
      const nearEndpoint = projected.z >= -1 && projected.z <= 1 && Math.hypot(local.x - (projected.x * 0.5 + 0.5) * effectiveWidth, local.y - (-projected.y * 0.5 + 0.5) * effectiveHeight) <= 12;
      if (nearEndpoint || ray.intersectObject(guide.endpoint, false).length) {
        const normal = viewportCamera.getWorldDirection(new THREE.Vector3());
        cameraEndpointDragRef.current = { pointerId: e.pointerId, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, guide.endpoint.position), original: shotCameraFrameRef.current, moved: false };
        hostElRef.current?.setPointerCapture(e.pointerId); e.preventDefault(); return;
      }
    }
    if (isTransformControlPointerActive(local.x, local.y, e.button)) {
      interactRef.current.mode = 'idle';
      interactRef.current.dragItemId = null;
      interactRef.current.dragLastPos3d = null;
      interactRef.current.routeSelection = null;
      interactRef.current.routeDragObject = null;
      interactRef.current.routeLastPosition = null;
      return;
    }
    const host = hostElRef.current;
    if (host) {
      try { host.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    interactRef.current.pointerId = e.pointerId;
    interactRef.current.lastX = local.x;
    interactRef.current.lastY = local.y;
    interactRef.current.moved = false;

    if (e.button === 0) {
      const cameraClickedItem = cameraSelectedRef.current ? raycastItem(local.x, local.y) : null;
      if (cameraClickedItem) cameraDoubleClickRef.current = { itemId: cameraClickedItem, at: performance.now() };
      const routePoint = pointerModeRef.current !== 'position'
        ? raycastMotionRoutePoint(local.x, local.y)
        : null;
      if (routePoint) {
        interactRef.current.mode = 'routeDrag';
        interactRef.current.routeSelection = routePoint.selection;
        interactRef.current.routeDragObject = routePoint.object;
        interactRef.current.routePlaneY = routePoint.selection.kind === 'camera' ? gridHeightRef.current : routePoint.position.y;
        interactRef.current.routeLastPosition = null;
        onMotionRoutePointSelect?.(routePoint.selection, routePoint.time);
        e.preventDefault();
        return;
      }
      const itemId = raycastItem(local.x, local.y);
      if (itemId && pointerModeRef.current !== 'position') {
        if (cameraSelectedRef.current) cameraDoubleClickRef.current = { itemId, at: performance.now() };
        if (onSelectionChange && (e.shiftKey || e.metaKey || e.ctrlKey)) {
          onSelectionChange([itemId], true); interactRef.current.mode = 'idle'; return;
        }
        if (selectedIdsRef.current.includes(itemId) && selectedIdsRef.current.some((id) => itemsRef.current.find((item) => item.id === id)?.locked)) {
          interactRef.current.mode = 'idle'; return;
        }
        interactRef.current.mode = 'drag';
        interactRef.current.dragItemId = itemId;
        interactRef.current.dragLastPos3d = null;
        if (!selectedIdsRef.current.includes(itemId)) {
          if (onSelectionChange) onSelectionChange([itemId]); else onSelectedItemChange(itemId);
        }
        return;
      }
      if (onSelectionChange && !e.altKey && pointerModeRef.current !== 'position') {
        interactRef.current.mode = 'marquee';
        const box = { x: local.x, y: local.y, endX: local.x, endY: local.y, toggle: e.shiftKey || e.metaKey || e.ctrlKey };
        selectionBoxRef.current = box; setSelectionBox(box);
      } else if (e.shiftKey) {
        interactRef.current.mode = 'pan';
      } else {
        interactRef.current.mode = 'orbit';
      }
    } else if (e.button === 2 || e.button === 1) {
      interactRef.current.mode = 'pan';
      e.preventDefault();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendMotionRouteDraftPoint, effectiveHeight, effectiveWidth, isTransformControlPointerActive, onMotionRoutePointSelect, onPilotActiveChange, onSelectedItemChange, onSelectionChange, raycastItem, raycastMotionRoutePoint]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const st = interactRef.current;
    const local = getLocalXY(e);
    const cameraDrag = cameraEndpointDragRef.current, guide = cameraGuideRef.current;
    if (cameraDrag && guide && cameraRef.current) {
      const ray = new THREE.Raycaster(), point = ndc(local.x, local.y);
      ray.setFromCamera(new THREE.Vector2(point.x, point.y), cameraRef.current);
      const target = ray.ray.intersectPlane(cameraDrag.plane, new THREE.Vector3());
      if (target) {
        if (e.metaKey || e.ctrlKey) target.set(Math.round(target.x * 2) / 2, Math.round(target.y * 2) / 2, Math.round(target.z * 2) / 2);
        cameraDrag.moved = true; guide.setTarget(target); guide.camera.lookAt(target);
        shotCameraFrameRef.current = { position: { ...guide.camera.position }, target: { ...target }, fov: cameraDrag.original?.fov ?? cameraRef.current.fov };
        setCanvasCursor('grabbing'); requestRender();
      }
      return;
    }
    if (transformDraggingRef.current || (poseEditorRef.current?.isDragging() && st.mode !== 'pose')) {
      setCanvasCursor('grabbing');
      return;
    }
    if (st.mode === 'pose') {
      const camera = cameraRef.current;
      if (camera) {
        const n = ndc(local.x, local.y);
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(n.x, n.y), camera);
        if (poseEditorRef.current?.pointerMove(rc)) setCanvasCursor('grabbing');
      }
      return;
    }
    if (st.mode === 'routeDraw' || st.mode === 'routePoint') {
      if (Math.hypot(local.x - st.lastX, local.y - st.lastY) > 2) st.moved = true;
      st.lastX = local.x;
      st.lastY = local.y;
      if (st.mode === 'routeDraw') appendMotionRouteDraftPoint(local.x, local.y, 0.14);
      setCanvasCursor('crosshair');
      return;
    }
    const hoverDraft = motionRouteDraftRef.current;
    if (hoverDraft && hoverDraft.method !== 'draw' && st.mode === 'idle') {
      hoverMotionRouteDraft(local.x, local.y, e.shiftKey);
      setCanvasCursor('crosshair');
      return;
    }
    if (st.mode === 'drag' || st.mode === 'routeDrag' || st.mode === 'orbit') {
      setCanvasCursor('grabbing');
    } else if (st.mode === 'pan') {
      setCanvasCursor('move');
    }
    // Hover ring during move-XY mode and object hover.
    const ring = hoverRingRef.current;
    if (ring) {
      const showHover = pointerModeRef.current === 'position' && selectedItemIdRef.current && st.mode === 'idle';
      if (showHover) {
        const pt = raycastGround(local.x, local.y, gridHeightRef.current);
        if (pt) {
          const hoverPoint = modeRef.current === 'panorama'
            ? clampPanoramaPointAtFixedY(pt.clone())
            : pt;
          const snapped = { x: Math.round(hoverPoint.x * 2) / 2, z: Math.round(hoverPoint.z * 2) / 2 };
          setRingAppearance(ring, DIRECTOR_GRID_PALETTE.hover, 0.6);
          ring.scale.setScalar(1);
          ring.position.set(snapped.x, gridHeightRef.current + 0.01, snapped.z);
          ring.visible = true;
          setCanvasCursor('crosshair');
          requestRender();
        } else if (ring.visible) {
          ring.visible = false; requestRender();
        }
      } else if (st.mode === 'idle' && pointerModeRef.current !== 'position') {
        const hoverItemId = raycastItem(local.x, local.y);
        const hoverItem = hoverItemId ? itemsRef.current.find((item) => item.id === hoverItemId) : null;
        if (hoverItem && hoverItem.id !== selectedItemIdRef.current) {
          const p = ensurePos3d(hoverItem);
          const itemScale = normalizeItemScale(hoverItem);
          const ringScale = Math.max(0.8, Math.min(2.6, getItemHeight(hoverItem) * Math.max(itemScale.x, itemScale.z) * 0.52));
          setRingAppearance(ring, DIRECTOR_GRID_PALETTE.hover, 0.38);
          ring.scale.setScalar(ringScale);
          ring.position.set(p.x, gridHeightRef.current + 0.018, p.z);
          ring.visible = true;
          setCanvasCursor('grab');
          requestRender();
        } else {
          setCanvasCursor(fullBleed ? 'grab' : 'default');
          if (ring.visible) {
            ring.visible = false;
            requestRender();
          }
        }
      } else if (ring.visible) {
        ring.visible = false; requestRender();
      }
    }
    if (st.mode === 'marquee' && selectionBoxRef.current) {
      const box = { ...selectionBoxRef.current, endX: local.x, endY: local.y };
      selectionBoxRef.current = box; setSelectionBox(box); return;
    }
    if (st.mode === 'idle') return;
    const dx = local.x - st.lastX;
    const dy = local.y - st.lastY;
    if (Math.hypot(dx, dy) > 2) st.moved = true;
    st.lastX = local.x;
    st.lastY = local.y;
    const sensitivityMultiplier = getPanoramaModeControlMultiplier();
    if (st.mode === 'orbit') {
      camStateRef.current.yaw -= dx * 0.008 * sensitivityMultiplier;
      camStateRef.current.pitch += dy * 0.008 * sensitivityMultiplier;
      applyCamera();
      requestRender();
    } else if (st.mode === 'pan') {
      const camera = cameraRef.current!;
      const panScale = camStateRef.current.distance * 0.0018 * sensitivityMultiplier;
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      camera.matrix.extractBasis(right, up, new THREE.Vector3());
      const move = right.multiplyScalar(-dx * panScale).add(up.multiplyScalar(dy * panScale));
      camStateRef.current.target.add(move);
      applyCamera();
      requestRender();
    } else if (st.mode === 'drag' && st.dragItemId) {
      const mesh = meshByIdRef.current.get(st.dragItemId);
      if (!mesh) return;
      const atY = mesh.position.y;
      const p = raycastGround(local.x, local.y, atY);
      if (p) {
        const nextPoint = modeRef.current === 'panorama'
          ? clampPanoramaPointAtFixedY(p.clone())
          : p;
        nextPoint.x = Math.round(nextPoint.x * 2) / 2;
        nextPoint.z = Math.round(nextPoint.z * 2) / 2;
        const anchor = itemsRef.current.find((item) => item.id === st.dragItemId);
        const origin = anchor ? ensurePos3d(anchor) : mesh.position;
        for (const id of selectedIdsRef.current) {
          const item = itemsRef.current.find((entry) => entry.id === id);
          const sibling = meshByIdRef.current.get(id);
          if (!item || item.locked || item.hidden || !sibling) continue;
          const start = ensurePos3d(item);
          sibling.position.set(start.x + nextPoint.x - origin.x, start.y, start.z + nextPoint.z - origin.z);
        }
        mesh.position.set(nextPoint.x, nextPoint.y, nextPoint.z);
        st.dragLastPos3d = { x: nextPoint.x, y: nextPoint.y, z: nextPoint.z };
        requestRender();
      }
    } else if (st.mode === 'routeDrag' && st.routeSelection && st.routeDragObject) {
      const point = raycastGround(local.x, local.y, st.routePlaneY);
      if (point) {
        if (modeRef.current === 'panorama') clampPanoramaPointAtFixedY(point);
        // Camera paths are edited as a ground projection while retaining the
        // authored camera altitude, which remains editable in the inspector.
        const altitude = st.routeSelection.kind === 'camera'
          ? st.routeDragObject.userData.directorRoutePoint.position.y
          : point.y;
        const position = { x: point.x, y: altitude, z: point.z };
        st.routeDragObject.position.set(position.x, st.routePlaneY + 0.03, position.z);
        const routeLine = motionRoutesRef.current?.children.find((child: any) => {
          const track = child.userData?.directorRouteTrack;
          return track?.kind === st.routeSelection?.kind && track?.trackId === st.routeSelection?.trackId;
        });
        const track = routeLine?.userData?.directorRouteTrack;
        const pointIndex = track?.keyframes.findIndex((keyframe: { id: string }) => (
          keyframe.id === st.routeSelection?.keyframeId
        )) ?? -1;
        const positions = routeLine?.geometry?.getAttribute('position');
        if (pointIndex >= 0 && positions) {
          positions.setXYZ(pointIndex, position.x, st.routePlaneY + 0.03, position.z);
          positions.needsUpdate = true;
          routeLine.computeLineDistances?.();
        }
        st.routeLastPosition = position;
        requestRender();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    appendMotionRouteDraftPoint,
    applyCamera,
    fullBleed,
    getPanoramaModeControlMultiplier,
    raycastGround,
    raycastItem,
    requestRender,
    setCanvasCursor,
  ]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const st = interactRef.current;
    const host = hostElRef.current;
    if (host) {
      try { host.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    const cameraDrag = cameraEndpointDragRef.current, guide = cameraGuideRef.current;
    if (cameraDrag && guide) {
      cameraEndpointDragRef.current = null;
      const applied = e.type !== 'pointercancel' && cameraDrag.moved && onCameraLookAtRef.current?.({ mode: 'point', point: { x: guide.endpoint.position.x, y: guide.endpoint.position.y, z: guide.endpoint.position.z } });
      if (!applied) { shotCameraFrameRef.current = cameraDrag.original; syncCameraGuide(); }
      setCanvasCursor(fullBleed ? 'grab' : 'default'); requestRender(); return;
    }
    if (e.type === 'pointercancel') {
      for (const item of itemsRef.current) { const mesh = meshByIdRef.current.get(item.id); const position = ensurePos3d(item); mesh?.position.set(position.x, position.y, position.z); }
      selectionBoxRef.current = null; setSelectionBox(null); st.mode = 'idle'; st.pointerId = null; requestRender(); return;
    }
    if (st.mode === 'marquee') {
      const box = selectionBoxRef.current;
      if (box && cameraRef.current) {
        const ids = itemsRef.current.filter((item) => {
          if (item.hidden || item.locked) return false;
          const position = meshByIdRef.current.get(item.id)?.position.clone();
          if (!position) return false;
          position.y += 0.6; position.project(cameraRef.current);
          const x = (position.x * 0.5 + 0.5) * effectiveWidth;
          const y = (-position.y * 0.5 + 0.5) * effectiveHeight;
          return position.z >= -1 && position.z <= 1 && x >= Math.min(box.x, box.endX) && x <= Math.max(box.x, box.endX) && y >= Math.min(box.y, box.endY) && y <= Math.max(box.y, box.endY);
        }).map((item) => item.id);
        onSelectionChange?.(ids, box.toggle);
      }
      selectionBoxRef.current = null; setSelectionBox(null); st.mode = 'idle'; st.pointerId = null; return;
    }
    if (st.mode === 'pose') {
      poseEditorRef.current?.pointerUp();
      st.mode = 'idle';
      st.pointerId = null;
      setCanvasCursor(fullBleed ? 'grab' : 'default');
      return;
    }
    if (st.mode === 'routePoint' || st.mode === 'routeDraw') {
      const local = getLocalXY(e);
      if (st.mode === 'routePoint' && !st.moved) {
        appendMotionRouteDraftPoint(local.x, local.y, 0.04, e.shiftKey);
        if (motionRouteDraftRef.current?.method === 'line' && motionRouteDraftPointsRef.current.length >= 2) completeMotionRouteDraft();
      }
      if (st.mode === 'routeDraw') {
        appendMotionRouteDraftPoint(local.x, local.y, 0.04);
        completeMotionRouteDraft();
      }
      st.mode = 'idle';
      st.pointerId = null;
      st.moved = false;
      setCanvasCursor('crosshair');
      return;
    }
    if (st.mode === 'drag' && st.dragItemId && st.dragLastPos3d) {
      const finalP = st.dragLastPos3d;
      const dragId = st.dragItemId;
      const next = itemsRef.current.map((it) => {
        if ((!selectedIdsRef.current.includes(it.id) && it.id !== dragId) || it.locked || it.hidden) return it;
        const source = itemsRef.current.find((item) => item.id === dragId);
        const anchor = source ? ensurePos3d(source) : finalP;
        const original = ensurePos3d(it);
        const position = { x: original.x + finalP.x - anchor.x, y: original.y, z: original.z + finalP.z - anchor.z };
        const legacy = pos3dToLegacy(position);
        return { ...it, pos3d: position, x: legacy.x, y: legacy.y };
      });
      onItemsChangeRef.current(next);
    }
    if (st.mode === 'routeDrag' && st.routeSelection && st.routeLastPosition) {
      onMotionRoutePointMove?.(st.routeSelection, st.routeLastPosition);
    }
    // Move-XY mode: a click on the ground (no orbit drag) teleports the
    // currently-selected item to the clicked floor position.
    if (
      pointerModeRef.current === 'position' &&
      selectedItemIdRef.current &&
      st.mode === 'orbit' &&
      !st.moved
    ) {
      const local = getLocalXY(e);
      const pt = raycastGround(local.x, local.y, gridHeightRef.current);
      if (pt) {
        const id = selectedItemIdRef.current;
        pt.y = gridHeightRef.current;
        if (modeRef.current === 'panorama') {
          clampPanoramaPointAtFixedY(pt);
        }
        const snapped = { x: Math.round(pt.x * 2) / 2, y: pt.y, z: Math.round(pt.z * 2) / 2 };
        const next = itemsRef.current.map((it) => {
          if (it.id !== id || it.locked || it.hidden) return it;
          const y = it.pos3d?.y ?? 0;
          const pos3d = { x: snapped.x, y, z: snapped.z };
          const legacy = pos3dToLegacy(pos3d);
          return { ...it, pos3d, x: legacy.x, y: legacy.y };
        });
        onItemsChangeRef.current(next);
        onPointerModeChange?.('orbit');
      }
    }
    st.mode = 'idle';
    st.dragItemId = null;
    st.dragLastPos3d = null;
    st.routeSelection = null;
    st.routeDragObject = null;
    st.routeLastPosition = null;
    st.pointerId = null;
    st.moved = false;
    setCanvasCursor(fullBleed ? 'grab' : 'default');
  }, [appendMotionRouteDraftPoint, completeMotionRouteDraft, fullBleed, onMotionRoutePointMove, onPointerModeChange, onSelectionChange, effectiveWidth, effectiveHeight, raycastGround, setCanvasCursor, requestRender, syncCameraGuide]);

  const handleDoubleClick = useCallback((event: React.MouseEvent) => {
    if (motionRouteDraftRef.current) {
      event.preventDefault();
      event.stopPropagation();
      completeMotionRouteDraft();
      return;
    }
    if (pilotStateRef.current.active || pointerModeRef.current === 'position' || orbitNavigationRef.current) return;
    const local = getLocalXY(event);
    const itemId = raycastItem(local.x, local.y);
    if (itemId) {
      event.preventDefault(); event.stopPropagation();
      const cameraIntent = cameraDoubleClickRef.current;
      if (onCameraTargetSelect && (cameraSelectedRef.current || (cameraIntent?.itemId === itemId && performance.now() - cameraIntent.at < 700))) onCameraTargetSelect(itemId);
      else handleFocusItem(itemId);
      cameraDoubleClickRef.current = null; return;
    }
    if (raycastMotionRoutePoint(local.x, local.y)) return;
    const segment = raycastMotionRouteSegment(local.x, local.y);
    if (!segment) return;
    event.preventDefault();
    event.stopPropagation();
    onMotionRoutePointInsert?.(
      segment.kind,
      segment.trackId,
      segment.time,
      segment.position,
    );
  }, [completeMotionRouteDraft, onMotionRoutePointInsert, raycastMotionRoutePoint, raycastMotionRouteSegment, raycastItem, handleFocusItem, onCameraTargetSelect]);

  const handleWheel = useCallback((e: WheelEvent) => {
    if (transformDraggingRef.current || poseEditorRef.current?.isDragging()) return;
    e.preventDefault();
    if (pilotStateRef.current.active && cameraRef.current) {
      cameraRef.current.fov = THREE.MathUtils.clamp(cameraRef.current.fov + e.deltaY * 0.04, 10, 150);
      cameraRef.current.updateProjectionMatrix();
      requestRender();
      return;
    }
    if (!viewSettings.wheelZoomEnabled) return;
    const zoomsOut = viewSettings.reverseWheelZoom ? e.deltaY < 0 : e.deltaY > 0;
    const sensitivityMultiplier = mode === 'panorama' ? panoramaControlSensitivityMultiplier : 1;
    const zoomStep = 1 + 0.1 * sensitivityMultiplier;
    const factor = zoomsOut ? zoomStep : 1 / zoomStep;
    const maxDistance = mode === 'panorama' ? PANORAMA_MAX_CAMERA_DISTANCE : 60;
    camStateRef.current.distance = Math.max(2, Math.min(maxDistance, camStateRef.current.distance * factor));
    applyCamera();
    requestRender();
  }, [
    applyCamera,
    mode,
    panoramaControlSensitivityMultiplier,
    requestRender,
    viewSettings.reverseWheelZoom,
    viewSettings.wheelZoomEnabled,
  ]);

  useEffect(() => {
    const host = hostElRef.current;
    if (!host) return;
    host.addEventListener('wheel', handleWheel, { passive: false });
    return () => host.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // ---------------------------------------------------------------------
  // WASD movement. In panorama mode this moves the camera target inside the
  // environment sphere; applyCamera() clamps the target/camera before render.
  // ---------------------------------------------------------------------
  const keysDownRef = useRef<Set<string>>(new Set());
  const moveRafRef = useRef<number | null>(null);
  const clearMovementKeys = useCallback(() => {
    keysDownRef.current.clear();
    if (moveRafRef.current !== null) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
    }
  }, []);
  const ensureMoveLoop = useCallback(() => {
    if (moveRafRef.current != null) return;
    const step = () => {
      const keys = keysDownRef.current;
      const hasMovementKey = ['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']
        .some((key) => keys.has(key));
      if (!hasMovementKey || !cameraRef.current) {
        moveRafRef.current = null;
        return;
      }
      const sensitivityMultiplier = modeRef.current === 'panorama'
        ? panoramaControlSensitivityMultiplier
        : 1;
      const speed =
        Math.max(0.05, camStateRef.current.distance * 0.02) *
        sensitivityMultiplier *
        (keys.has('shift') ? 3 : 1);
      const cam = cameraRef.current;
      const fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      fwd.y = 0; fwd.normalize();
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      if (keys.has('w') || keys.has('arrowup')) camStateRef.current.target.addScaledVector(fwd, speed);
      if (keys.has('s') || keys.has('arrowdown')) camStateRef.current.target.addScaledVector(fwd, -speed);
      if (keys.has('a') || keys.has('arrowleft')) camStateRef.current.target.addScaledVector(right, -speed);
      if (keys.has('d') || keys.has('arrowright')) camStateRef.current.target.addScaledVector(right, speed);
      if (keys.has('e')) camStateRef.current.target.y += speed;
      if (keys.has('q')) camStateRef.current.target.y -= speed;
      applyCamera();
      requestRender();
      moveRafRef.current = requestAnimationFrame(step);
    };
    moveRafRef.current = requestAnimationFrame(step);
  }, [applyCamera, panoramaControlSensitivityMultiplier, requestRender]);

  useEffect(() => {
    if (!keyboardShortcutsEnabled || (!fullBleed && !editMode)) {
      clearMovementKeys();
      return;
    }
    const onDown = (e: KeyboardEvent) => {
      if (isEditableKeyboardTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'shift') {
        keysDownRef.current.add('shift');
        return;
      }
      if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        if (e.shiftKey) keysDownRef.current.add('shift');
        keysDownRef.current.add(k);
        ensureMoveLoop();
        e.preventDefault();
      }
    };
    const onUp = (e: KeyboardEvent) => keysDownRef.current.delete(e.key.toLowerCase());
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        clearMovementKeys();
      }
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', clearMovementKeys);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', clearMovementKeys);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clearMovementKeys();
    };
  }, [clearMovementKeys, editMode, ensureMoveLoop, fullBleed, keyboardShortcutsEnabled]);

  // ---------------------------------------------------------------------
  // Overlay HTML labels — pinned over each 3D figure with the item name.
  // No inline editing here; parent's right rail handles all edits.
  // ---------------------------------------------------------------------
  const pedestrianNumberById = useMemo(() => buildPedestrianNumberMap(items), [items]);

  const overlayLabels = useMemo(
    () => items.filter((item) =>
      !item.hidden && (item.showLabel !== false ||
      (viewSettings.showAdvancedPedestrianTags && pedestrianNumberById.has(item.id)))
    ),
    [items, pedestrianNumberById, viewSettings.showAdvancedPedestrianTags],
  );

  /** Point numbers (points/line) and the live segment length (line) of the route draft. */
  function updateRouteDraftLabels(overlay: HTMLDivElement, camera: { projectionMatrix: unknown }) {
    const layer = overlay.querySelector<HTMLDivElement>(':scope > [data-route-draft-labels]');
    if (!layer) return;
    const draft = motionRouteDraftRef.current;
    const points = motionRouteDraftPointsRef.current;
    const hover = motionRouteDraftHoverRef.current;
    const labels: Array<{ text: string; at: DirectorMotionVector3; kind: 'index' | 'length' }> = [];
    if (draft && draft.method !== 'draw') {
      points.forEach((point, index) => labels.push({ text: String(index + 1), at: point, kind: 'index' }));
      const last = points[points.length - 1];
      if (draft.method === 'line' && points.length === 1 && last && hover) {
        const length = Math.hypot(hover.x - last.x, hover.z - last.z);
        labels.push({ text: `${length.toFixed(1)}m`, at: hover, kind: 'length' });
      }
    }
    while (layer.children.length < labels.length) layer.appendChild(document.createElement('div'));
    for (let i = 0; i < layer.children.length; i++) {
      const el = layer.children[i] as HTMLDivElement;
      const label = labels[i];
      if (!label) { el.style.display = 'none'; continue; }
      const projected = new THREE.Vector3(label.at.x, label.at.y + 0.06, label.at.z).project(camera);
      if (projected.z > 1 || projected.z < -1) { el.style.display = 'none'; continue; }
      const sx = (projected.x * 0.5 + 0.5) * effectiveWidth;
      const sy = (-projected.y * 0.5 + 0.5) * effectiveHeight;
      el.className = label.kind === 'index' ? 'stage-route-index' : 'stage-route-length';
      el.dataset.kind = draft?.kind ?? 'object';
      el.textContent = label.text;
      el.style.display = 'block';
      el.style.transform = label.kind === 'index'
        ? `translate(${sx + 8}px, ${sy - 22}px)`
        : `translate(${sx + 14}px, ${sy + 10}px)`;
    }
  }

  function updateOverlayLabels() {
    const overlay = overlayRef.current;
    const camera = cameraRef.current;
    const controls = routeControlsRef.current, frames = routeControlFramesRef.current;
    if (controls && camera && frames.length > 1) {
      const anchor = frames[0].position;
      const projected = new THREE.Vector3(anchor.x, routeControlTargetRef.current?.kind === 'camera' ? gridHeightRef.current : anchor.y, anchor.z).project(camera);
      const visible = motionRoutesVisibleRef.current && !motionPlaybackActiveRef.current && !exportModeRef.current && !motionRouteDraftRef.current && projected.z >= -1 && projected.z <= 1;
      controls.style.visibility = visible ? 'visible' : 'hidden';
      controls.style.transform = `translate(${Math.min(effectiveWidth - 175, Math.max(8, (projected.x * 0.5 + 0.5) * effectiveWidth + 16))}px, ${Math.min(effectiveHeight - 64, Math.max(8, (-projected.y * 0.5 + 0.5) * effectiveHeight + 16))}px)`;
    }
    if (overlay && camera) updateRouteDraftLabels(overlay, camera);
    if (!overlay || !camera) return;
    if (motionPlaybackActiveRef.current) return;
    const children = overlay.children;
    for (let i = 0; i < children.length; i++) {
      const el = children[i] as HTMLDivElement;
      const itemId = el.dataset.itemId;
      if (!itemId) continue;
      const mesh = meshByIdRef.current.get(itemId);
      if (!mesh) { el.style.display = 'none'; continue; }
      const pos = new THREE.Vector3();
      mesh.getWorldPosition(pos);
      const item = itemsRef.current.find((it) => it.id === itemId);
      const labelHeight = item ? getItemHeight(item) * normalizeItemScale(item).y : 1;
      pos.y += Math.max(0.75, labelHeight + 0.25);
      const proj = pos.clone().project(camera);
      if (proj.z > 1 || proj.z < -1) { el.style.display = 'none'; continue; }
      const sx = (proj.x * 0.5 + 0.5) * effectiveWidth;
      const sy = (-proj.y * 0.5 + 0.5) * effectiveHeight;
      el.style.display = 'block';
      el.style.transform = `translate(-50%, -100%) translate(${sx}px, ${sy}px)`;
    }
  }
  updateOverlayLabelsRef.current = updateOverlayLabels;

  // Second pass into a scissored corner: the sampled shot camera, without editing helpers.
  // Shadow maps are reused from the main pass (they depend on lights, not on the viewer).
  renderShotPipRef.current = () => {
    const overlay = shotPipElRef.current;
    const preview = shotPreviewRef.current;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const mainCamera = cameraRef.current;
    const active = Boolean(preview && renderer && scene && mainCamera
      && !exportModeRef.current && !pilotStateRef.current.active && motionPreviewModeRef.current === 'route');
    if (overlay) overlay.hidden = !active;
    if (!active || !preview) return;
    const frame = shotCameraFrameRef.current;
    overlay?.toggleAttribute('data-empty', !frame);
    if (!frame) return;
    let pipCamera = pipCameraRef.current;
    if (!pipCamera) {
      pipCamera = new THREE.PerspectiveCamera(45, preview.aspect, 0.05, 500);
      pipCameraRef.current = pipCamera;
    }
    const position = new THREE.Vector3(frame.position.x, frame.position.y, frame.position.z);
    const target = new THREE.Vector3(frame.target.x, frame.target.y, frame.target.z);
    if (modeRef.current === 'panorama') clampPanoramaCameraPoints(position, target);
    pipCamera.position.copy(position);
    pipCamera.lookAt(target);
    if (frame.freeRotation) pipCamera.rotation.set(frame.freeRotation.x, frame.freeRotation.y, frame.freeRotation.z, 'XYZ');
    const fov = Math.max(10, Math.min(150, frame.fov));
    pipCamera.fov = fov;
    pipCamera.aspect = preview.aspect;
    pipCamera.near = mainCamera.near;
    pipCamera.far = mainCamera.far;
    pipCamera.updateProjectionMatrix();
    const rect = computeShotPipRect(effectiveWidth, effectiveHeight, preview.aspect);
    const helpers = [cameraGuideRef.current?.group, motionRoutesRef.current, motionRouteDraftGroupRef.current, transformHelperRef.current, selectionRingRef.current, hoverRingRef.current]
      .filter((object) => object?.visible);
    for (const object of helpers) object.visible = false;
    const previousViewport = renderer.getViewport(new THREE.Vector4());
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    const bottom = effectiveHeight - rect.top - rect.height;
    renderer.shadowMap.autoUpdate = false;
    renderer.setScissorTest(true);
    renderer.setScissor(rect.left, bottom, rect.width, rect.height);
    renderer.setViewport(rect.left, bottom, rect.width, rect.height);
    renderer.render(scene, pipCamera);
    renderer.setScissorTest(false);
    renderer.setViewport(previousViewport);
    renderer.shadowMap.autoUpdate = shadowAutoUpdate;
    for (const object of helpers) object.visible = true;
    if (shotPipLabelRef.current) {
      shotPipLabelRef.current.textContent = `${preview.cameraLabel} · ${Math.round(focalLengthFromFov(fov))}mm · ${preview.aspectLabel}`;
    }
  };

  // Toggling or reshaping the picture-in-picture needs a frame even when nothing else moved.
  const shotPreviewKey = shotPreview ? `${shotPreview.aspect}|${shotPreview.cameraLabel}|${shotPreview.aspectLabel}` : '';
  useEffect(() => {
    requestRender();
  }, [requestRender, shotPreviewKey, effectiveWidth, effectiveHeight]);

  // ---------------------------------------------------------------------
  // Imperative handle (delegated to internals component below)
  // ---------------------------------------------------------------------
  const exportScenePng = useCallback((options?: BlueprintSceneExportOptions) => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const source = renderer?.domElement as HTMLCanvasElement | undefined;
    if (!renderer || !scene || !camera || !source) return null;
    const cameraGuide = cameraGuideRef.current?.group;
    const guideVisible = cameraGuide?.visible ?? false;
    if (cameraGuide) cameraGuide.visible = false;
    renderer.render(scene, camera);
    if (cameraGuide) cameraGuide.visible = guideVisible;
    requestRender();

    const sourceWidth = source.width;
    const sourceHeight = source.height;
    if (!options?.frameAspect && !options?.targetWidth && !options?.targetHeight) {
      return source.toDataURL('image/png');
    }

    let sx = 0;
    let sy = 0;
    let sw = sourceWidth;
    let sh = sourceHeight;
    const frameAspect = options?.frameAspect;
    if (frameAspect && Number.isFinite(frameAspect) && frameAspect > 0) {
      const sourceAspect = sourceWidth / sourceHeight;
      if (sourceAspect > frameAspect) {
        sw = Math.max(1, Math.round(sourceHeight * frameAspect));
        sx = Math.max(0, Math.round((sourceWidth - sw) / 2));
      } else if (sourceAspect < frameAspect) {
        sh = Math.max(1, Math.round(sourceWidth / frameAspect));
        sy = Math.max(0, Math.round((sourceHeight - sh) / 2));
      }
    }

    const targetWidth = Math.max(1, Math.round(options?.targetWidth ?? sw));
    const targetHeight = Math.max(1, Math.round(options?.targetHeight ?? sh));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
    const sourceScaleY = sourceHeight / Math.max(1, effectiveHeight);
    const cropCssHeight = sh / Math.max(0.001, sourceScaleY);
    const labelScale = Math.max(0.85, Math.min(3, targetHeight / Math.max(1, cropCssHeight)));
    const fontSize = 10 * labelScale;
    const paddingX = 6 * labelScale;
    const paddingY = 3 * labelScale;
    const labelHeight = fontSize + paddingY * 2;
    const pedestrianNumbers = buildPedestrianNumberMap(itemsRef.current);
    const showAdvancedPedestrianTags = viewSettingsRef.current.showAdvancedPedestrianTags;

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = `${fontSize}px sans-serif`;
    for (const item of itemsRef.current) {
      if (item.hidden) continue;
      const mesh = meshByIdRef.current.get(item.id);
      if (!mesh) continue;
      const segments = getSceneLabelSegments(item, showAdvancedPedestrianTags, pedestrianNumbers.get(item.id));
      if (!segments) continue;

      const pos = new THREE.Vector3();
      mesh.getWorldPosition(pos);
      const labelHeightWorld = getItemHeight(item) * normalizeItemScale(item).y;
      pos.y += Math.max(0.75, labelHeightWorld + 0.25);
      const projected = pos.clone().project(camera);
      if (projected.z > 1 || projected.z < -1) continue;

      const sourceX = (projected.x * 0.5 + 0.5) * sourceWidth;
      const sourceY = (-projected.y * 0.5 + 0.5) * sourceHeight;
      const x = ((sourceX - sx) / sw) * targetWidth;
      const y = ((sourceY - sy) / sh) * targetHeight;
      if (x < -160 * labelScale || x > targetWidth + 160 * labelScale || y < -40 * labelScale || y > targetHeight + 40 * labelScale) {
        continue;
      }

      const textWidth = segments.reduce((width, segment) => width + ctx.measureText(segment.text).width, 0);
      const boxWidth = textWidth + paddingX * 2;
      const boxX = x - boxWidth / 2;
      const boxY = y - labelHeight;
      drawRoundedRect(ctx, boxX, boxY, boxWidth, labelHeight, 4 * labelScale);
      ctx.fillStyle = 'rgba(0,0,0,0.70)';
      ctx.fill();
      ctx.strokeStyle = item.color || 'rgba(255,255,255,0.7)';
      ctx.lineWidth = Math.max(1, labelScale);
      ctx.stroke();

      let cursorX = boxX + paddingX;
      const textY = boxY + labelHeight / 2;
      for (const segment of segments) {
        ctx.fillStyle = segment.color;
        ctx.fillText(segment.text, cursorX, textY);
        cursorX += ctx.measureText(segment.text).width;
      }
    }
    ctx.restore();
    return canvas.toDataURL('image/png');
  }, [effectiveHeight, effectiveWidth, requestRender]);

  const renderFrame = useCallback(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;
    renderer.render(scene, camera);
    renderShotPipRef.current();
    updateOverlayLabelsRef.current();
  }, []);

  const getCanvas = useCallback(() => rendererRef.current?.domElement as HTMLCanvasElement | null, []);

  const applyMotionFrame = useCallback((frame: SampledDirectorMotionFrame, previewMode: 'route' | 'shot' = 'shot') => {
    shotCameraFrameRef.current = frame.camera;
    Object.entries(frame.objects).forEach(([itemId, sampled]) => {
      const item = itemsByIdRef.current.get(itemId);
      let mesh = meshByIdRef.current.get(itemId);
      if (!mesh || !item) return;
      const sampledAction = frame.actions[itemId];
      const pose = sampledAction?.pose;
      if (item.category === 'person') {
        const bodyControls = sampledAction?.bodyControls ?? item.bodyControls;
        const cacheKey = getItemMeshCacheKey(item, bodyControls, meshDetail);
        if (mesh.userData?.cacheKey !== cacheKey && itemsGroupRef.current) {
          const previousMesh = mesh;
          mesh = createBlueprintItemMesh(item, customActionPosesRef.current, bodyControls, meshDetail);
          itemsGroupRef.current.remove(previousMesh);
          disposeBlueprintItemMesh(previousMesh);
          itemsGroupRef.current.add(mesh);
          meshByIdRef.current.set(itemId, mesh);
          const transformControls = transformControlsRef.current;
          if (transformControls && transformControls.object === previousMesh) {
            transformControls.detach();
            transformControls.attach(mesh);
          }
        }
        applyItemPose(mesh, pose ?? resolveItemStaticPose(item, customActionPosesRef.current));
      }
      const baseRotation = mesh.userData?.baseRotation ?? { x: 0, y: 0, z: 0 };
      const baseScale = mesh.userData?.baseScale ?? { x: 1, y: 1, z: 1 };
      mesh.position.set(sampled.position.x, sampled.position.y, sampled.position.z);
      mesh.rotation.set(baseRotation.x + sampled.rotation.x, baseRotation.y + sampled.rotation.y, baseRotation.z + sampled.rotation.z);
      mesh.scale.set(baseScale.x * sampled.scale.x, baseScale.y * sampled.scale.y, baseScale.z * sampled.scale.z);
      if (itemId === selectedItemIdRef.current && selectionRingRef.current) {
        selectionRingRef.current.position.set(sampled.position.x, gridHeightRef.current + 0.02, sampled.position.z);
      }
    });
    const camera = cameraRef.current;
    if (camera && previewMode === 'route' && motionPreviewModeRef.current === 'shot' && routePreviewCameraRef.current) {
      const routeCamera = routePreviewCameraRef.current;
      camera.position.set(routeCamera.position.x, routeCamera.position.y, routeCamera.position.z);
      camera.lookAt(routeCamera.target.x, routeCamera.target.y, routeCamera.target.z);
      camera.fov = routeCamera.fov;
      camera.updateProjectionMatrix();
      camStateRef.current.target.set(routeCamera.target.x, routeCamera.target.y, routeCamera.target.z);
      camStateRef.current.distance = camera.position.distanceTo(camStateRef.current.target);
      cameraSnapshotTargetRef.current = routeCamera;
    }
    if (camera && previewMode === 'shot') {
      if (motionPreviewModeRef.current === 'route') {
        routePreviewCameraRef.current = {
          position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
          target: {
            x: camStateRef.current.target.x,
            y: camStateRef.current.target.y,
            z: camStateRef.current.target.z,
          },
          fov: camera.fov,
          trackTargetId: null,
          trackTargetBodyPart: null,
        };
      }
      if (frame.camera) {
        const position = new THREE.Vector3(frame.camera.position.x, frame.camera.position.y, frame.camera.position.z);
        const target = new THREE.Vector3(frame.camera.target.x, frame.camera.target.y, frame.camera.target.z);
        if (modeRef.current === 'panorama') clampPanoramaCameraPoints(position, target);
        camera.position.copy(position);
        camera.lookAt(target);
        if (frame.camera.freeRotation) {
          const rotation = frame.camera.freeRotation;
          camera.rotation.set(rotation.x, rotation.y, rotation.z, 'XYZ');
        }
        camera.fov = Math.max(10, Math.min(150, frame.camera.fov));
        camera.updateProjectionMatrix();
        camStateRef.current.target.copy(target);
        camStateRef.current.distance = camera.position.distanceTo(camStateRef.current.target);
        cameraSnapshotTargetRef.current = frame.camera;
      }
    }
    motionPreviewModeRef.current = previewMode;
    syncCameraGuide();
    requestRender();
  }, [meshDetail, requestRender, syncCameraGuide]);

  const setMotionPlaybackActive = useCallback((active: boolean) => {
    motionPlaybackActiveRef.current = active;
    syncCameraGuide();
    const renderer = rendererRef.current;
    if (renderer) {
      renderer.setPixelRatio(active ? 0.8 : Math.min(window.devicePixelRatio, 2));
      renderer.setSize(effectiveWidth, effectiveHeight, false);
    }
    if (motionRoutesRef.current) {
      motionRoutesRef.current.visible = !active
        && !exportModeRef.current
        && motionRoutesVisibleRef.current;
    }
    if (overlayRef.current) overlayRef.current.style.visibility = active ? 'hidden' : '';
    poseEditorRef.current?.setVisible(!active && !exportModeRef.current);
    if (!active) updateOverlayLabelsRef.current();
    requestRender();
  }, [effectiveHeight, effectiveWidth, requestRender, syncCameraGuide]);

  const setExportMode = useCallback((enabled: boolean, size?: { width: number; height: number }) => {
    if (enabled && !exportModeRef.current) {
      exportVisibilityRef.current = {
        grid: gridRef.current?.visible ?? false,
        floor: floorRef.current?.visible ?? false,
        selectionRing: selectionRingRef.current?.visible ?? false,
        hoverRing: hoverRingRef.current?.visible ?? false,
        transformHelper: transformHelperRef.current?.visible ?? false,
        motionRoutes: motionRoutesRef.current?.visible ?? false,
      };
    }
    const previousVisibility = exportVisibilityRef.current;
    exportModeRef.current = enabled;
    syncCameraGuide();
    exportSizeRef.current = enabled ? size ?? null : null;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (renderer && camera) {
      const nextWidth = enabled ? size?.width ?? effectiveWidth : effectiveWidth;
      const nextHeight = enabled ? size?.height ?? effectiveHeight : effectiveHeight;
      renderer.setPixelRatio(enabled ? 1 : Math.min(window.devicePixelRatio, 2));
      renderer.setSize(nextWidth, nextHeight, false);
      camera.aspect = nextWidth / Math.max(1, nextHeight);
      camera.updateProjectionMatrix();
    }
    if (gridRef.current) gridRef.current.visible = enabled ? false : previousVisibility?.grid ?? grid.visible;
    if (floorRef.current) floorRef.current.visible = enabled ? false : previousVisibility?.floor ?? grid.visible;
    if (selectionRingRef.current) selectionRingRef.current.visible = enabled ? false : previousVisibility?.selectionRing ?? false;
    if (hoverRingRef.current) hoverRingRef.current.visible = enabled ? false : previousVisibility?.hoverRing ?? false;
    if (transformHelperRef.current) transformHelperRef.current.visible = enabled ? false : previousVisibility?.transformHelper ?? false;
    if (motionRoutesRef.current) motionRoutesRef.current.visible = enabled
      ? false
      : !motionPlaybackActiveRef.current && (previousVisibility?.motionRoutes ?? motionRoutesVisible);
    if (motionRouteDraftGroupRef.current) motionRouteDraftGroupRef.current.visible = !enabled;
    poseEditorRef.current?.setVisible(!enabled && !motionPlaybackActiveRef.current);
    if (!enabled) exportVisibilityRef.current = null;
    requestRender();
  }, [effectiveHeight, effectiveWidth, grid.visible, motionRoutesVisible, requestRender, syncCameraGuide]);

  const enterPilot = useCallback(() => {
    const camera = cameraRef.current;
    const canvas = rendererRef.current?.domElement as HTMLCanvasElement | undefined;
    if (!camera || !canvas) return;
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    pilotStateRef.current.active = true;
    pilotStateRef.current.position.copy(camera.position);
    if (modeRef.current === 'panorama') {
      clampVectorToRadiusInPlace(pilotStateRef.current.position, PANORAMA_CAMERA_RADIUS_LIMIT);
      camera.position.copy(pilotStateRef.current.position);
    }
    pilotStateRef.current.yaw = Math.atan2(direction.x, direction.z);
    pilotStateRef.current.pitch = Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1));
    onPilotActiveChange?.(true);
    requestPilotPointerLock(canvas, () => {
      pilotStateRef.current.active = false;
      onPilotActiveChange?.(false);
    });
  }, [onPilotActiveChange]);

  const getPersonPose = useCallback((itemId: string): BlueprintActionPose | null => {
    const mesh = meshByIdRef.current.get(itemId);
    return mesh && itemsByIdRef.current.get(itemId)?.category === 'person' ? getAppliedPersonPose(mesh) : null;
  }, []);

  const previewPersonPose = useCallback((itemId: string, pose: BlueprintActionPose) => {
    const mesh = meshByIdRef.current.get(itemId);
    const item = itemsByIdRef.current.get(itemId);
    if (!mesh || item?.category !== 'person' || item.locked || item.hidden) return;
    applyPersonPose(mesh, pose);
    requestRender();
  }, [requestRender]);

  const exitPilot = useCallback(() => {
    pilotStateRef.current.active = false;
    if (document.pointerLockElement) document.exitPointerLock?.();
    onPilotActiveChange?.(false);
  }, [onPilotActiveChange]);

  const getCaptureRevision = useCallback((): BlueprintSceneCaptureRevision | null => (
    captureRevisionRef.current?.inputs === captureInputs ? captureRevisionRef.current : null
  ), [captureInputs]);

  const captureFrame = useCallback(async (
    request: BlueprintSceneFrameCaptureRequest,
    signal?: AbortSignal,
  ): Promise<Blob> => {
    assertStageCaptureActive(signal);
    const revision = getCaptureRevision();
    if (!revision || (request.revision && request.revision !== revision)) {
      throw new Error('Stage renderer synchronization is not ready for capture.');
    }
    const rendered = revision.inputs;
    const renderer: InstanceType<typeof THREE.WebGLRenderer> | null = rendererRef.current;
    const scene: InstanceType<typeof THREE.Scene> | null = sceneRef.current;
    const liveCamera: InstanceType<typeof THREE.PerspectiveCamera> | null = cameraRef.current;
    if (!renderer || !scene || !liveCamera) throw new Error('Stage viewport is unavailable.');
    if (rendered.mode === 'panorama' && rendered.panoramaUrl && !panoMeshRef.current?.visible) throw new Error('Stage panorama is not ready for capture.');
    if (request.view === 'shot' && !request.frame?.camera) throw new Error('Stage has no shot camera at the requested time.');
    const captureScene = scene.clone(false);
    const captureCamera = liveCamera.clone();
    const ownedMeshes: InstanceType<typeof THREE.Group>[] = [];
    const copiedLights: InstanceType<typeof THREE.DirectionalLight>[] = [];
    const excluded = new Set([
      itemsGroupRef.current, gridRef.current, floorRef.current, selectionRingRef.current,
      hoverRingRef.current, transformHelperRef.current, motionRoutesRef.current,
      motionRouteDraftGroupRef.current, poseEditorRef.current?.helper, cameraGuideRef.current?.group,
    ]);
    const captureItems = new THREE.Group();
    try {
      for (const child of scene.children) {
        if (excluded.has(child)) continue;
        const clone = child.clone(true);
        captureScene.add(clone);
        if (clone.isDirectionalLight || clone.isSpotLight || clone.isPointLight) copiedLights.push(clone);
      }
      for (const item of rendered.items) {
        if (item.hidden) continue;
        const original: InstanceType<typeof THREE.Group> | undefined = meshByIdRef.current.get(item.id);
        if (!original) throw new Error(`Stage object ${item.id} is not ready for capture.`);
        if (original.userData.importedModelPending || original.userData.importedModelError || (item.relief && original.children.length === 0)) throw new Error(`Stage object ${item.id} is not ready for capture.`);
        const sampled = request.frame?.objects[item.id];
        let clone: InstanceType<typeof THREE.Group>;
        if (sampled && item.category === 'person' && !item.importedModelId) {
          const action = request.frame?.actions[item.id];
          clone = createBlueprintItemMesh(item, rendered.customActionPoses, action?.bodyControls ?? item.bodyControls, rendered.meshDetail);
          ownedMeshes.push(clone);
          applyItemPose(clone, action?.pose ?? resolveItemStaticPose(item, rendered.customActionPoses));
        } else if (item.category === 'person' && !item.importedModelId) {
          // Person root userData owns a circular rig. Copy the already-posed child
          // hierarchy, not that metadata, to preserve the exact currently shown rig.
          clone = new THREE.Group();
          clone.position.copy(original.position);
          clone.quaternion.copy(original.quaternion);
          clone.scale.copy(original.scale);
          clone.visible = original.visible;
          for (const child of original.children) clone.add(child.clone(true));
        } else {
          clone = original.clone(true);
        }
        if (sampled) {
          const baseRotation = original.userData.baseRotation ?? { x: 0, y: 0, z: 0 };
          const baseScale = original.userData.baseScale ?? { x: 1, y: 1, z: 1 };
          clone.position.set(sampled.position.x, sampled.position.y, sampled.position.z);
          clone.rotation.set(baseRotation.x + sampled.rotation.x, baseRotation.y + sampled.rotation.y, baseRotation.z + sampled.rotation.z);
          clone.scale.set(baseScale.x * sampled.scale.x, baseScale.y * sampled.scale.y, baseScale.z * sampled.scale.z);
        }
        captureItems.add(clone);
      }
      captureScene.add(captureItems);
      if (request.view === 'shot' && request.frame?.camera) {
        const shot = request.frame.camera;
        captureCamera.position.set(shot.position.x, shot.position.y, shot.position.z);
        const target = new THREE.Vector3(shot.target.x, shot.target.y, shot.target.z);
        if (rendered.mode === 'panorama') clampPanoramaCameraPoints(captureCamera.position, target);
        captureCamera.lookAt(target);
        if (shot.freeRotation) captureCamera.rotation.set(shot.freeRotation.x, shot.freeRotation.y, shot.freeRotation.z, 'XYZ');
        captureCamera.fov = shot.fov;
      } else if (request.view !== 'current') {
        const box = new THREE.Box3().setFromObject(captureItems);
        if (box.isEmpty()) throw new Error('Stage has no object bounds for four-view capture.');
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(0.1, box.getBoundingSphere(new THREE.Sphere()).radius);
        const aspect = request.options?.frameAspect ?? captureCamera.aspect;
        const vertical = THREE.MathUtils.degToRad(captureCamera.fov);
        const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
        const distance = radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.1;
        const direction = request.view === 'front' ? new THREE.Vector3(0, 0, 1)
          : request.view === 'right' ? new THREE.Vector3(1, 0, 0)
            : request.view === 'back' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(-1, 0, 0);
        captureCamera.position.copy(center).addScaledVector(direction, distance);
        captureCamera.lookAt(center);
        captureCamera.near = 0.01;
        captureCamera.far = Math.max(500, distance + radius * 4);
        captureCamera.aspect = aspect;
      }
      captureCamera.updateProjectionMatrix();
      const image = await renderStageOffscreenImage(renderer, captureScene, captureCamera, request.options, signal);
      if (getCaptureRevision() !== revision) throw new Error('Stage renderer changed during capture.');
      return image;
    } finally {
      // Borrowed scene clones share original geometry/materials/textures. Dispose
      // only new procedural people and shadow targets owned by the copied lights.
      for (const mesh of ownedMeshes) disposeBlueprintItemMesh(mesh);
      for (const light of copiedLights) {
        light.shadow?.map?.dispose();
        light.shadow?.mapPass?.dispose();
      }
      captureScene.clear();
    }
  }, [getCaptureRevision]);

  // This effect is deliberately after every mesh/environment/camera sync effect.
  // Offscreen rendering needs synchronized Three.js data, not a scheduled rAF or
  // an elapsed delay. Cleanup revokes tokens across commits, unmount and StrictMode.
  useEffect(() => {
    if (!rendererRef.current || !sceneRef.current || !cameraRef.current) return;
    const revision: BlueprintSceneCaptureRevision = { inputs: captureInputs };
    captureRevisionRef.current = revision;
    return () => {
      if (captureRevisionRef.current === revision) captureRevisionRef.current = null;
    };
  }, [captureInputs]);

  useImperativeHandle(ref, () => ({
    exportPng: exportScenePng, captureFrame, getCaptureRevision, resetCamera: handleResetCamera,
    fitCamera: handleFitCamera, focusItem: handleFocusItem, getSuggestedInsertPosition,
    getCameraSnapshot, getCanvas, applyMotionFrame, setMotionPlaybackActive, renderFrame,
    setExportMode, enterPilot, exitPilot, completeMotionRouteDraft, cancelMotionRouteDraft,
    getPersonPose, previewPersonPose,
  }), [applyMotionFrame, cancelMotionRouteDraft, captureFrame, completeMotionRouteDraft, enterPilot, exitPilot, exportScenePng, getCaptureRevision, getCameraSnapshot, getCanvas, getPersonPose, getSuggestedInsertPosition, handleFitCamera, handleFocusItem, handleResetCamera, previewPersonPose, renderFrame, setExportMode, setMotionPlaybackActive]);

  return (
    <BlueprintSceneInternals
      hostElRef={hostElRef}
      canvasHostRef={canvasHostRef}
      overlayRef={overlayRef}
      miniMapRef={miniMapRef}
      effectiveWidth={effectiveWidth}
      effectiveHeight={effectiveHeight}
      handlePointerDown={handlePointerDown}
      handlePointerMove={handlePointerMove}
      handlePointerUp={handlePointerUp}
      handleDoubleClick={handleDoubleClick}
      handleContextMenu={handleContextMenu}
      overlayLabels={overlayLabels}
      selectedItemId={selectedItemId ?? null}
      selectedItemIds={selectedItemIds}
      selectionOverlay={<>
        {routeControlTarget && routeControlFrames.length > 1 && onMotionRouteRetime && onMotionRouteToggleClosed && !items.find((item) => item.id === routeControlTarget.trackId && (item.locked || item.hidden)) ? <StageRouteControls
          key={`${routeControlTarget.kind}:${routeControlTarget.trackId}`} ref={routeControlsRef}
          duration={routeControlFrames[routeControlFrames.length - 1].time - routeControlFrames[0].time}
          maxDuration={(motionProject?.durationSeconds ?? 0) - routeControlFrames[0].time} closed={stageRouteClosed(routeControlFrames)}
          onDuration={(duration) => onMotionRouteRetime(routeControlTarget.kind, routeControlTarget.trackId, routeControlFrames[0].time, routeControlFrames[0].time + duration)}
          onToggleClosed={() => onMotionRouteToggleClosed(routeControlTarget.kind, routeControlTarget.trackId)} /> : null}
        {selectionBox ? <div className="pointer-events-none absolute z-30 border border-accent bg-accent/10" style={{ left: Math.min(selectionBox.x, selectionBox.endX), top: Math.min(selectionBox.y, selectionBox.endY), width: Math.abs(selectionBox.endX - selectionBox.x), height: Math.abs(selectionBox.endY - selectionBox.y) }} /> : null}
        {transformHint ? <div className="pointer-events-none absolute bottom-16 left-1/2 z-30 -translate-x-1/2 rounded-lg bg-elevated px-3 py-2 font-mono text-sm text-text shadow-lg">{transformHint}</div> : null}
      </>}
      showAdvancedPedestrianTags={viewSettings.showAdvancedPedestrianTags}
      pedestrianNumberById={pedestrianNumberById}
      isFullscreen={isFullscreen}
      setIsFullscreen={setIsFullscreen}
      editMode={editMode}
      setEditMode={setEditMode}
      pointerMode={pointerMode}
      onPointerModeChange={onPointerModeChange}
      hint={hint}
      mode={mode}
      referenceImages={referenceImages}
      fullBleed={fullBleed}
      handleResetCamera={handleResetCamera}
      handleFitCamera={handleFitCamera}
      handleFocusItem={handleFocusItem}
      exportPng={exportScenePng}
      getSuggestedInsertPosition={getSuggestedInsertPosition}
      getCameraSnapshot={getCameraSnapshot}
      getCanvas={getCanvas}
      applyMotionFrame={applyMotionFrame}
      setMotionPlaybackActive={setMotionPlaybackActive}
      renderFrame={renderFrame}
      setExportMode={setExportMode}
      enterPilot={enterPilot}
      exitPilot={exitPilot}
      completeMotionRouteDraft={completeMotionRouteDraft}
      cancelMotionRouteDraft={cancelMotionRouteDraft}
      getPersonPose={getPersonPose}
      previewPersonPose={previewPersonPose}
      sceneRef={sceneRef}
      t={t}
      forwardRef={ref}
      shotPreview={shotPreview}
      onShotPreviewActivate={onShotPreviewActivate}
      shotPipElRef={shotPipElRef}
      shotPipLabelRef={shotPipLabelRef}
    />
  );
}));

(BlueprintScene as any).displayName = 'BlueprintScene';

// ---------------------------------------------------------------------
// Internals: rendering layer kept as a separate component so the
// imperative handle hook can be wired in via the parent forwardRef.
// (Splitting like this keeps the main hook above readable.)
// ---------------------------------------------------------------------

interface InternalsProps {
  hostElRef: React.MutableRefObject<HTMLDivElement | null>;
  canvasHostRef: React.MutableRefObject<HTMLDivElement | null>;
  overlayRef: React.MutableRefObject<HTMLDivElement | null>;
  miniMapRef: React.MutableRefObject<HTMLCanvasElement | null>;
  effectiveWidth: number;
  effectiveHeight: number;
  handlePointerDown: (e: React.PointerEvent) => void;
  handlePointerMove: (e: React.PointerEvent) => void;
  handlePointerUp: (e: React.PointerEvent) => void;
  handleDoubleClick: (e: React.MouseEvent) => void;
  handleContextMenu: (e: React.MouseEvent) => void;
  overlayLabels: BlueprintItem[];
  selectedItemId: string | null;
  selectedItemIds?: readonly string[];
  selectionOverlay?: React.ReactNode;
  showAdvancedPedestrianTags: boolean;
  pedestrianNumberById: Map<string, number>;
  isFullscreen: boolean;
  setIsFullscreen: (v: boolean | ((p: boolean) => boolean)) => void;
  editMode: boolean;
  setEditMode: (v: boolean | ((p: boolean) => boolean)) => void;
  pointerMode: 'orbit' | 'position';
  onPointerModeChange?: (mode: 'orbit' | 'position') => void;
  hint: string;
  mode: 'flat' | 'panorama';
  referenceImages: BlueprintReferenceImage[];
  fullBleed: boolean;
  handleResetCamera: () => void;
  handleFitCamera: () => void;
  handleFocusItem: (itemId: string) => void;
  exportPng: (options?: BlueprintSceneExportOptions) => string | null;
  getSuggestedInsertPosition: () => { x: number; y: number; z: number };
  getCameraSnapshot: () => DirectorSceneCameraSnapshot | null;
  getCanvas: () => HTMLCanvasElement | null;
  applyMotionFrame: (frame: SampledDirectorMotionFrame, previewMode?: 'route' | 'shot') => void;
  setMotionPlaybackActive: (active: boolean) => void;
  renderFrame: () => void;
  setExportMode: (enabled: boolean, size?: { width: number; height: number }) => void;
  enterPilot: () => void;
  exitPilot: () => void;
  completeMotionRouteDraft: () => boolean;
  cancelMotionRouteDraft: () => void;
  getPersonPose: BlueprintSceneHandle['getPersonPose'];
  previewPersonPose: BlueprintSceneHandle['previewPersonPose'];
  sceneRef: React.MutableRefObject<any>;
  t: ReturnType<typeof useTranslation>['t'];
  shotPreview: BlueprintShotPreview | null;
  onShotPreviewActivate?: () => void;
  shotPipElRef: React.MutableRefObject<HTMLDivElement | null>;
  shotPipLabelRef: React.MutableRefObject<HTMLSpanElement | null>;
  forwardRef: React.Ref<BlueprintSceneHandle>;
}

function BlueprintSceneInternals({
  hostElRef, canvasHostRef, overlayRef, miniMapRef,
  effectiveWidth, effectiveHeight,
  handlePointerDown, handlePointerMove, handlePointerUp, handleDoubleClick, handleContextMenu,
  overlayLabels,
  selectedItemId,
  selectedItemIds,
  selectionOverlay,
  showAdvancedPedestrianTags,
  pedestrianNumberById,
  isFullscreen, setIsFullscreen, editMode, setEditMode,
  pointerMode, onPointerModeChange,
  hint, mode, referenceImages, fullBleed,
  handleResetCamera, handleFitCamera,
  t,
  shotPreview, onShotPreviewActivate, shotPipElRef, shotPipLabelRef,
}: InternalsProps) {

  const tree = (
    <div
      ref={hostElRef}
      className={fullBleed
        ? 'nodrag nopan nowheel relative overflow-hidden bg-elevated select-none'
        : 'nodrag nopan nowheel relative rounded-lg overflow-hidden border border-[var(--line)] bg-elevated select-none'}
      style={{ width: effectiveWidth, height: effectiveHeight, touchAction: 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      <div ref={canvasHostRef} className="absolute inset-0" />
      {selectionOverlay}
      <div ref={overlayRef} className="absolute inset-0 pointer-events-none">
        {/* Route-draft point numbers and live length; children are managed in the render pass. */}
        <div data-route-draft-labels="" className="absolute inset-0" />
        {overlayLabels.map((it) => {
          const pedestrianNumber = showAdvancedPedestrianTags ? pedestrianNumberById.get(it.id) : undefined;
          const pedestrianTag = pedestrianNumber ? `#${pedestrianNumber} · ID ${getShortItemId(it.id)}` : null;
          const showName = it.showLabel !== false;
          return (
            <div
              key={it.id}
              data-item-id={it.id}
              className="stage-label absolute left-0 top-0"
              data-selected={(selectedItemIds?.includes(it.id) ?? it.id === selectedItemId) ? '' : undefined}
            >
              <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-[1px]" style={{ backgroundColor: it.color }} />
              {showName ? it.label : pedestrianTag}
              {showName && pedestrianTag ? <span className="ml-1 opacity-70">{pedestrianTag}</span> : null}
              {showName && it.refImageName ? <span className="ml-1 opacity-60">@{it.refImageName}</span> : null}
            </div>
          );
        })}
      </div>

      {shotPreview ? (() => {
        const rect = computeShotPipRect(effectiveWidth, effectiveHeight, shotPreview.aspect);
        return (
          <div
            ref={shotPipElRef}
            className="stage-pip absolute z-[15]"
            style={rect}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="stage-pip__hit"
              onClick={onShotPreviewActivate}
              aria-label={t('directorStudio.previs.pip.open')}
              data-director-tooltip={t('directorStudio.previs.pip.openHelp')}
            />
            <span className="stage-pip__safe" aria-hidden />
            <span className="stage-pip__empty">
              <Clapperboard className="h-4 w-4" />
              {t('directorStudio.previs.pip.empty')}
            </span>
            <span ref={shotPipLabelRef} className="stage-pip__label">{shotPreview.cameraLabel} · {shotPreview.aspectLabel}</span>
          </div>
        );
      })() : null}

      {/* Top-left toolbar */}
      {!fullBleed ? (
      <div className="absolute top-2 left-2 flex gap-1 rounded-lg border border-[var(--line)] bg-elevated p-1 text-[10px] shadow-[var(--shadow-pop)]">
        <UiButton size="sm" variant="ghost"
          onClick={(e) => { e.stopPropagation(); handleResetCamera(); }}
          title={t('directorStudio.scene.resetView')}>
          <RotateCcw className="h-3.5 w-3.5" /> {t('directorStudio.scene.reset')}
        </UiButton>
        <UiButton size="sm" variant="ghost"
          onClick={(e) => { e.stopPropagation(); handleFitCamera(); }}
          title={t('directorStudio.scene.fitAllTitle')}>
          <Maximize2 className="h-3.5 w-3.5" /> {t('directorStudio.scene.fitAll')}
        </UiButton>
        <UiChipButton active={editMode}
          onClick={(e) => { e.stopPropagation(); setEditMode((v) => !v); }}
          title={editMode ? t('directorStudio.scene.exitMoveMode') : t('directorStudio.scene.enterMoveMode')}>
          {t('directorStudio.scene.moveMode')} {editMode ? t('common.on') : t('common.off')}
        </UiChipButton>
        {pointerMode === 'position' && (
          <UiButton size="sm" variant="ghost"
            onClick={(e) => { e.stopPropagation(); onPointerModeChange?.('orbit'); }}
            title={t('directorStudio.scene.exitMoveXy')}>
            <MousePointer2 className="h-3.5 w-3.5" /> {t('directorStudio.scene.moveXyCancel')}
          </UiButton>
        )}
        <UiChipButton active={isFullscreen}
          onClick={(e) => { e.stopPropagation(); setIsFullscreen((v) => !v); }}
          title={isFullscreen ? t('directorStudio.scene.exitFullscreen') : t('directorStudio.scene.fullscreen')}>
          {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          {isFullscreen ? t('directorStudio.scene.collapse') : t('directorStudio.scene.expand')}
        </UiChipButton>
      </div>
      ) : null}

      {/* Bottom-right mini-map */}
      {!fullBleed ? (
        <div className="absolute bottom-2 right-2 flex flex-col items-end gap-1">
          <canvas
            ref={miniMapRef}
            width={120}
            height={120}
            className="rounded-lg border border-[var(--line)] bg-elevated shadow-[var(--shadow-pop)] backdrop-blur-sm"
          />
        </div>
      ) : null}

      {/* Bottom-left mode hint */}
      {!fullBleed ? (
      <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-lg border border-[var(--line)] bg-elevated px-2 py-1 text-[10px] text-text-muted shadow-[var(--shadow-pop)]">
        <Move3d className="w-3 h-3" /> {t('directorStudio.scene.sceneLabel')} · {mode === 'panorama' ? t('directorStudio.scene.panoramaGround') : t('directorStudio.scene.flatGround')}
      </div>
      ) : null}

      {/* Bottom-center reference legend */}
      {referenceImages.length > 0 && (
        <div className={`${fullBleed ? 'bottom-24' : 'bottom-8'} absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-lg border border-[var(--line)] bg-elevated px-2 py-1 shadow-[var(--shadow-pop)]`}>
          {referenceImages.map((r, idx) => {
            const color = r.color ?? '#60a5fa';
            const displayUrl = resolveImageDisplayUrl(r.url) ?? r.url;
            return (
              <div key={r.id} className="relative group flex flex-col items-center gap-0.5">
                <span
                  className="h-5 w-5 rounded-sm border-2 border-[var(--line-strong)]"
                  style={{ backgroundColor: color }}
                  title={`${t('directorStudio.scene.referenceIndex', { index: idx + 1 })} · ${r.label}`}
                />
                <span className="text-[9px] text-text-muted">{t('directorStudio.scene.referenceIndex', { index: idx + 1 })}</span>
                <div className="pointer-events-none absolute bottom-full mb-1 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity bg-elevated border border-[var(--line-strong)] rounded-sm p-1 shadow-[var(--shadow-pop)] z-20">
                  <img src={displayUrl} alt={r.label} className="w-20 h-20 object-cover rounded-sm" />
                  <div className="mt-1 text-[10px] text-text-dark text-center whitespace-nowrap">@{r.label}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Hint banner under the toolbar */}
      {!fullBleed ? (
      <div className="absolute top-12 left-2 max-w-[420px] rounded-lg border border-[var(--line)] bg-elevated px-2 py-1 text-[10px] text-text-muted shadow-[var(--shadow-pop)]">
        {hint}
      </div>
      ) : null}
    </div>
  );

  if (isFullscreen) {
    return createPortal(
      <div className="dark fixed inset-0 z-9000 bg-surface p-3 overflow-auto">
        {tree}
      </div>,
      document.body,
    );
  }
  return tree;
}
