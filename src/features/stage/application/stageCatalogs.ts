import { BLUEPRINT_PRESET_LABELS, BLUEPRINT_PERSON_PRESET_LABELS } from '@/features/canvas/domain/blueprintPresetCatalog';
import { DIRECTOR_STUDIO_MODEL_CATALOG, LEGACY_ONLY_DIRECTOR_STUDIO_PRESET_IDS } from '@/features/canvas/domain/directorStudioModelCatalog';
import { PERSON_JOINTS, PERSON_FINGER_FIELDS } from '@/features/canvas/domain/personPose';
import { normalizeBlueprintBodyControls } from '@/features/canvas/domain/directorStudioBodyControls';
import { PERSON_ACTIONS, PERSON_POSES } from '@/features/canvas/application/personMotionLibrary';
import { DIRECTOR_CAMERA_PRESETS } from '@/features/canvas/application/directorMotion';
import { BLUEPRINT_SPRITE_PRESETS } from '@/features/canvas/ui/blueprintPresets';

const personPresetIds: Readonly<Record<string, true>> = Object.fromEntries([
  ...Object.keys(BLUEPRINT_PERSON_PRESET_LABELS),
  ...DIRECTOR_STUDIO_MODEL_CATALOG.filter((model) => model.itemCategory === 'person').map((model) => model.presetId),
].map((id) => [id, true as const]));
export function stageSceneCatalog() {
  const catalog = Object.fromEntries(DIRECTOR_STUDIO_MODEL_CATALOG.map((model) => [model.presetId, model]));
  // Placement catalog for agents and story plans: what the model library offers, not legacy save labels.
  return Object.entries(BLUEPRINT_PRESET_LABELS).filter(([presetId]) => !LEGACY_ONLY_DIRECTOR_STUDIO_PRESET_IDS.has(presetId)).map(([presetId, label]) => ({
    presetId, label, category: personPresetIds[presetId] ? 'person' : catalog[presetId]?.itemCategory ?? 'object',
    // Persons render at sprite height (1.75 m default) scaled by the preset body controls, exactly as the viewport does.
    heightMeters: personPresetIds[presetId]
      ? Math.round((BLUEPRINT_SPRITE_PRESETS[presetId]?.heightMeters ?? 1.75) * normalizeBlueprintBodyControls(catalog[presetId]?.bodyControls).core.height * 100) / 100
      : BLUEPRINT_SPRITE_PRESETS[presetId]?.heightMeters ?? null,
  }));
}
export function stageAgentCatalogs() {
  return {
    scene: stageSceneCatalog(),
    poses: PERSON_POSES.map(({ id, category }) => ({ id, category })),
    actions: PERSON_ACTIONS.map(({ id, durationSeconds, travelSpeed }) => ({ id, durationSeconds, ...(travelSpeed !== undefined ? { travelSpeedMps: travelSpeed } : {}) })),
    cameraPresets: DIRECTOR_CAMERA_PRESETS.map(({ id }) => id),
    poseChannels: PERSON_JOINTS.map(({ key, axes, limits }) => ({ key, axes, limitsDegrees: limits })),
    fingers: { hands: ['leftFingers', 'rightFingers'], fields: PERSON_FINGER_FIELDS, range: [0, 1] },
    story: {
      version: 1, maxDurationSeconds: 120,
      sizes: ['extreme-wide', 'wide', 'full', 'medium', 'close', 'extreme-close'],
      angles: ['eye', 'high', 'low', 'overhead'], movements: ['static', 'push', 'pull', 'pan', 'orbit', 'track', 'crane'],
      positions: 'Absolute {x,y,z}, relative {actorId,offset?}, or {markId,offset?}. Actor-relative endpoints resolve at beat start; lookAt actor aims at head and resamples during the beat. Facing is radians or a position reference.',
      timing: 'A route uses distance / travelSpeedMps (default from the selected locomotion action, otherwise walk). Arrival holds until subsequent blocking. Beat times are never shifted; infeasible speeds and minimum-duration adjustments return explicit warnings. Actor and camera ranges may touch but must not overlap.',
      framing: 'Registered heights are metric; width/depth are conservative proxies, not exact geometry. Always inspect captured frames.',
    },
    units: 'World meters, Y up, radians for authored rotations; side names are anatomical. groupY is nonnegative lift above automatic grounding.',
  };
}
