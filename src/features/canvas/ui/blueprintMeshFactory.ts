import * as THREE from 'three';

import type { BlueprintActionPose, BlueprintBodyControls, BlueprintItem } from '@/features/canvas/domain/canvasNodes';
import { normalizeBlueprintBodyControls } from '@/features/canvas/domain/directorStudioBodyControls';

export const BLUEPRINT_PRESERVE_MATERIAL_COLOR = 'blueprintPreserveMaterialColor';

function preserveMaterialColor<T extends { userData: Record<string, unknown> }>(material: T): T {
  material.userData[BLUEPRINT_PRESERVE_MATERIAL_COLOR] = true;
  return material;
}

/**
 * Three.js mesh factories for blueprint subjects.
 *
 * Person figures use cartoon "big-head, stick-limb" proportions inspired
 * by the user-supplied reference image — a round head ~21% of total
 * height, slim capsule torso, and very thin limb capsules. The intent
 * matches a 2D stick-figure: commit fully to abstraction, eliminate
 * uncanny-valley territory by having no face or clothes, and let
 * silhouette + posture do most of the recognition work. Female presets
 * add only a small head-attached hair shell for identification.
 *
 * Per-preset variation = height, thickness scale, female hair, and
 * elder bind-pose stoop. Color is the user's choice and drives the
 * body material.
 *
 * Skeleton tree (preserved across all visual rewrites so action
 * transforms keep working):
 *   leftShoulder → leftElbow → (hand)
 *   rightShoulder → rightElbow → (hand)
 *   leftHip → leftKnee → (foot)
 *   rightHip → rightKnee → (foot)
 *   headGroup → (skull)
 *   torsoMesh → (capsule body)
 *
 * Joint seam handling
 * -------------------
 * Earlier iterations had visible gaps where limbs left the torso.
 * The fix is two-fold: (1) anchor each shoulder/hip JOINT INSIDE the
 * torso silhouette so the limb's top hemisphere hides inside the body
 * mesh; (2) add a small "ball joint" sphere as the first child of each
 * shoulder/hip group that's just slightly larger than the limb itself.
 * The ball is barely visible at rest (subsumed by the torso) but bridges
 * the seam when the limb rotates away.
 */

interface PersonProportions {
  legH: number;
  thighH: number;
  shinH: number;
  torsoH: number;
  /** Torso half-radius at waist (capsule radius). */
  torsoR: number;
  /** Half-distance from spine to shoulder joint (joint INSIDE torso edge). */
  shoulderHalfWidth: number;
  /** Half-distance from spine to hip joint (joint INSIDE torso edge). */
  hipHalfWidth: number;
  armH: number;
  upperArmH: number;
  forearmH: number;
  armR: number;
  legR: number;
  handR: number;
  footHalfW: number;
  footHalfL: number;
  footHalfH: number;
  headR: number;
  /** Y-axis scale on the head sphere — 1.0 = round, 1.05 = slight egg. */
  headStretchY: number;
  neckR: number;
  /** Default torso lean baked into the bind pose (radians). */
  torsoBindLeanX: number;
  /** Default head pitch baked into the bind pose. */
  headBindPitch: number;
  armSplayZ: number;
  legSplayZ: number;
}

/**
 * Cartoon proportions for a 1.75 m adult — fractions of total height.
 * Tuned so:
 *   total height = head_diameter * 4.5   (cartoon, between Y-Bot and chibi)
 *   limbs read as obvious stick-shapes but stay visible at typical
 *   canvas zoom (radii bumped from 0.022 → 0.030 after the user
 *   reported limbs vanishing into invisible lines)
 *   joints overlap the torso so seams hide inside the body silhouette
 */
const CARTOON_FRACTIONS = {
  legH: 0.45,
  thighRatio: 0.50,
  shinRatio: 0.45,
  torsoH: 0.30,
  torsoR: 0.062,             // narrow waist
  shoulderHalfWidth: 0.075,  // wider shoulders so arms hang clear of torso
  hipHalfWidth: 0.062,       // wider hips so legs don't read as one block
  armH: 0.36,
  upperArmRatio: 0.50,
  forearmRatio: 0.48,
  armR: 0.030,               // stick-thin but visible
  legR: 0.038,
  handR: 0.042,              // readable fist without merging into feet
  footHalfW: 0.040,
  footHalfL: 0.076,
  footHalfH: 0.020,
  headR: 0.110,              // BIG head — ~22% of total height
  headStretchY: 1.04,
  neckR: 0.030,              // thinner neck — earlier value bulged at the joint
} as const;

/**
 * Default ARM/LEG splay baked into the bind pose so the figure no longer
 * stands at attention with arms glued to the torso and legs welded
 * together. Small Z-axis rotations only — large enough to read as
 * "relaxed" but small enough that pose deltas (walk/run/sit) still look
 * correct on top.
 */
const BIND_ARM_SPLAY_Z = 0.26;   // ~15° — hands clear the foot silhouette at rest
const BIND_LEG_SPLAY_Z = 0.05;   // ~3° — feet stay separated without drifting under hands

interface PresetTraits {
  /** Multiplier on the figure's overall height. Tall presets are 10% taller,
   *  child/elder ~7-30% shorter, etc. Driven separately from `thicknessScale`
   *  so a heavy man stays full-height while reading as bulky, and a child
   *  reads as both small AND chubby. */
  heightMultiplier: number;
  /** Multiplier on every "thickness" value (radii). */
  thicknessScale: number;
  /** Multiplier on torso width specifically. */
  torsoTaper: number;
  /** Multiplier on shoulder half-width (broader for heavy, narrower for slim). */
  shoulderScale: number;
  /** Multiplier on hip half-width. */
  hipScale: number;
  /** Multiplier on head radius (kids slightly bigger). */
  headScale: number;
  /** Slight forward stoop baked into the bind pose (radians). */
  torsoBindLeanX: number;
  /** Slight head-down gaze baked into the bind pose (radians). */
  headBindPitch: number;
  /** Optional torso-front bulge for "heavy" presets — round belly. */
  bellyBulge?: boolean;
  /** Optional small hair shell attached to the head for authored character presets. */
  hairStyle?: 'shortBob' | 'shortCap' | 'longHair' | 'pigtails';
  /** Small preserved-color silhouette cue for age-specific models. */
  ageCue?: 'cane' | 'backpack';
}

const DEFAULT_TRAITS: PresetTraits = {
  heightMultiplier: 1.0,
  thicknessScale: 1.0,
  torsoTaper: 1.0,
  shoulderScale: 1.0,
  hipScale: 1.0,
  headScale: 1.0,
  torsoBindLeanX: 0,
  headBindPitch: 0,
};

/**
 * Per-preset visual signatures.
 *
 * Keep the figure abstract for director-table blocking: height, bulk,
 * posture, and a few preserved-color silhouette cues carry most presets.
 * Female presets use longer hair shapes so gender reads at normal canvas
 * scale without relying on body color.
 */
function traitsForPreset(presetId: string | undefined): PresetTraits {
  switch (presetId) {
    case 'person-adult-male-average':
    case 'man':
      return { ...DEFAULT_TRAITS, shoulderScale: 1.06, hipScale: 0.96, hairStyle: 'shortCap' };
    case 'person-adult-male-slim':
      return {
        ...DEFAULT_TRAITS,
        heightMultiplier: 1.07,
        thicknessScale: 0.74,
        torsoTaper: 0.78,
        shoulderScale: 0.84,
        hipScale: 0.86,
        hairStyle: 'shortCap',
      };
    case 'person-adult-male-strong':
      return {
        ...DEFAULT_TRAITS,
        heightMultiplier: 1.06,
        thicknessScale: 1.28,
        torsoTaper: 1.18,
        shoulderScale: 1.46,
        hipScale: 1.08,
        hairStyle: 'shortCap',
      };
    case 'person-adult-male-heavy':
      return {
        ...DEFAULT_TRAITS,
        heightMultiplier: 0.96,
        thicknessScale: 1.58,
        torsoTaper: 1.78,
        shoulderScale: 1.24,
        hipScale: 1.44,
        bellyBulge: true,
        hairStyle: 'shortCap',
      };
    case 'tallMan':
      return { ...DEFAULT_TRAITS, heightMultiplier: 1.18, hairStyle: 'shortCap' };
    case 'shortMan':
      return {
        ...DEFAULT_TRAITS,
        heightMultiplier: 0.85,
        thicknessScale: 1.12,
        hairStyle: 'shortCap',
      };
    case 'heavyMan':
      return {
        ...DEFAULT_TRAITS,
        thicknessScale: 1.55,
        torsoTaper: 1.80,
        shoulderScale: 1.30,
        hipScale: 1.45,
        bellyBulge: true,
        hairStyle: 'shortCap',
      };
    case 'person-adult-female-average':
    case 'woman':
      return {
        ...DEFAULT_TRAITS,
        thicknessScale: 0.86,
        shoulderScale: 0.74,
        hipScale: 1.22,
        hairStyle: 'longHair',
      };
    case 'person-adult-female-slim':
      return {
        ...DEFAULT_TRAITS,
        heightMultiplier: 1.07,
        thicknessScale: 0.66,
        torsoTaper: 0.76,
        shoulderScale: 0.70,
        hipScale: 1.12,
        hairStyle: 'longHair',
      };
    case 'person-adult-female-strong':
      return {
        ...DEFAULT_TRAITS,
        heightMultiplier: 1.02,
        thicknessScale: 1.12,
        torsoTaper: 1.08,
        shoulderScale: 1.18,
        hipScale: 1.16,
        hairStyle: 'longHair',
      };
    case 'person-adult-female-heavy':
      return {
        ...DEFAULT_TRAITS,
        heightMultiplier: 0.96,
        thicknessScale: 1.42,
        torsoTaper: 1.62,
        shoulderScale: 1.08,
        hipScale: 1.42,
        bellyBulge: true,
        hairStyle: 'longHair',
      };
    case 'tallWoman':
      return {
        ...DEFAULT_TRAITS,
        heightMultiplier: 1.12,
        thicknessScale: 0.86,
        shoulderScale: 0.74,
        hipScale: 1.16,
        hairStyle: 'longHair',
      };
    case 'slimWoman':
      return {
        ...DEFAULT_TRAITS,
        heightMultiplier: 1.07,
        thicknessScale: 0.66,
        torsoTaper: 0.76,
        shoulderScale: 0.70,
        hipScale: 1.12,
        hairStyle: 'longHair',
      };
    case 'person-elder-male':
    case 'elder':
      return {
        ...DEFAULT_TRAITS,
        heightMultiplier: 0.90,
        thicknessScale: 0.88,
        // Pronounced forward stoop is the universal "elder" silhouette —
        // no ornament needed.
        torsoBindLeanX: -0.40,
        headBindPitch: 0.25,
        hairStyle: 'shortCap',
        ageCue: 'cane',
      };
    case 'person-elder-female':
      return {
        ...DEFAULT_TRAITS,
        heightMultiplier: 0.88,
        thicknessScale: 0.84,
        shoulderScale: 0.72,
        hipScale: 1.14,
        torsoBindLeanX: -0.40,
        headBindPitch: 0.25,
        hairStyle: 'longHair',
        ageCue: 'cane',
      };
    case 'person-child-boy':
    case 'child':
      return {
        ...DEFAULT_TRAITS,
        // Chibi-short with an oversized head — the universal cartoon
        // signal for "child" reads instantly without ornament.
        heightMultiplier: 0.58,
        thicknessScale: 0.85,
        headScale: 1.55,
        hairStyle: 'shortCap',
        ageCue: 'backpack',
      };
    case 'person-child-girl':
      return {
        ...DEFAULT_TRAITS,
        heightMultiplier: 0.56,
        thicknessScale: 0.82,
        headScale: 1.58,
        shoulderScale: 0.78,
        hipScale: 1.06,
        hairStyle: 'pigtails',
        ageCue: 'backpack',
      };
    case 'person-teen-male':
      return {
        ...DEFAULT_TRAITS,
        heightMultiplier: 0.92,
        thicknessScale: 0.78,
        headScale: 1.12,
        shoulderScale: 0.88,
        hipScale: 0.88,
        hairStyle: 'shortCap',
      };
    case 'person-teen-female':
      return {
        ...DEFAULT_TRAITS,
        heightMultiplier: 0.9,
        thicknessScale: 0.74,
        headScale: 1.12,
        shoulderScale: 0.74,
        hipScale: 1.08,
        hairStyle: 'longHair',
      };
    default:
      return { ...DEFAULT_TRAITS };
  }
}

function proportionsForPreset(
  presetId: string | undefined,
  heightM: number,
  bodyControls?: BlueprintBodyControls,
): PersonProportions {
  const f = CARTOON_FRACTIONS;
  const t = traitsForPreset(presetId);
  const controls = normalizeBlueprintBodyControls(bodyControls);

  // Height multiplier scales every linear dimension. This is what makes
  // tallMan visibly taller than shortMan even when the caller passes the
  // same `heightM`.
  const h = heightM * t.heightMultiplier * controls.core.height;

  const legH = h * f.legH * controls.legs.length;
  const torsoH = h * f.torsoH;
  const armH = h * f.armH * controls.arms.length;
  const torsoR = h * f.torsoR * t.thicknessScale * t.torsoTaper * controls.core.torsoWidth;
  const shoulderWidthScale = Math.max(0.55, 0.45 * controls.core.torsoWidth + 0.55 * controls.arms.thickness);
  const hipWidthScale = Math.max(0.55, 0.5 * controls.core.torsoWidth + 0.5 * controls.legs.thickness);

  return {
    legH,
    thighH: legH * f.thighRatio,
    shinH: legH * f.shinRatio,
    torsoH,
    torsoR,
    shoulderHalfWidth: h * f.shoulderHalfWidth * t.shoulderScale * shoulderWidthScale,
    hipHalfWidth: h * f.hipHalfWidth * t.hipScale * hipWidthScale,
    armH,
    upperArmH: armH * f.upperArmRatio,
    forearmH: armH * f.forearmRatio,
    armR: h * f.armR * t.thicknessScale * controls.arms.thickness,
    legR: h * f.legR * t.thicknessScale * controls.legs.thickness,
    handR: h * f.handR * t.thicknessScale * controls.arms.thickness,
    footHalfW: h * f.footHalfW * t.thicknessScale * controls.legs.thickness,
    footHalfL: h * f.footHalfL * t.thicknessScale * controls.legs.thickness,
    footHalfH: h * f.footHalfH * t.thicknessScale * controls.legs.thickness,
    headR: h * f.headR * t.headScale * controls.core.headScale,
    headStretchY: f.headStretchY,
    neckR: h * f.neckR * t.thicknessScale,
    torsoBindLeanX: t.torsoBindLeanX + THREE.MathUtils.degToRad(controls.core.torsoLeanDeg),
    headBindPitch: t.headBindPitch,
    armSplayZ: BIND_ARM_SPLAY_Z + THREE.MathUtils.degToRad(controls.arms.spreadDeg),
    legSplayZ: BIND_LEG_SPLAY_Z + THREE.MathUtils.degToRad(controls.legs.spreadDeg),
  };
}

interface PersonBones {
  leftShoulder: any;
  rightShoulder: any;
  leftElbow: any;
  rightElbow: any;
  leftHip: any;
  rightHip: any;
  leftKnee: any;
  rightKnee: any;
  headGroup: any;
  torsoMesh: any;
  constants: {
    legH: number;
    thighH: number;
    shinH: number;
    armH: number;
  };
}

const BONE_KEYS: ReadonlyArray<keyof PersonBones> = [
  'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee',
  'headGroup', 'torsoMesh',
];

function stashBind(group: any) {
  for (const key of BONE_KEYS) {
    const bone = (group.userData.bones as any)[key];
    if (bone && bone.rotation) {
      bone.userData.bindEuler = [bone.rotation.x, bone.rotation.y, bone.rotation.z];
    }
  }
}

/**
 * Build a stylized humanoid figure with poseable limbs. Returned
 * `THREE.Group` carries `userData.bones` for the action transform.
 *
 * Single material body. Cartoon "big head + stick limbs" silhouette.
 * All joints anchor INSIDE the torso so seams are hidden by the body
 * mesh; small ball-joint spheres bridge any visible gap when the limb
 * rotates away from rest.
 */
export function createPersonMeshGroup(
  color: any,
  heightM: number,
  presetId?: string,
  bodyControls?: BlueprintBodyControls,
  options: { role?: BlueprintItem['directorStudioRole']; detail?: 'full' | 'preview' } = {},
): any {
  const isPreview = options.detail === 'preview';
  const isPedestrian = options.role === 'pedestrian';
  const p = proportionsForPreset(presetId, heightM * (isPedestrian ? 0.94 : 1), bodyControls);
  const traits = traitsForPreset(presetId);
  const controls = normalizeBlueprintBodyControls(bodyControls);
  const showIdentityDetails = !isPedestrian && !isPreview;
  const makeSphere = (
    radius: number,
    widthSegments: number,
    heightSegments: number,
    phiStart?: number,
    phiLength?: number,
    thetaStart?: number,
    thetaLength?: number,
  ) => new THREE.SphereGeometry(
    radius,
    isPreview ? Math.min(widthSegments, 8) : widthSegments,
    isPreview ? Math.min(heightSegments, 6) : heightSegments,
    phiStart,
    phiLength,
    thetaStart,
    thetaLength,
  );
  const makeCapsule = (radius: number, length: number, capSegments: number, radialSegments: number) =>
    new THREE.CapsuleGeometry(radius, length, isPreview ? Math.min(capSegments, 3) : capSegments, isPreview ? Math.min(radialSegments, 6) : radialSegments);
  const makeCylinder = (radiusTop: number, radiusBottom: number, height: number, radialSegments: number, heightSegments = 1, openEnded = false) =>
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, isPreview ? Math.min(radialSegments, 8) : radialSegments, heightSegments, openEnded);

  // Single material for the whole figure. The body color comes from the
  // user; we lift emissive slightly so the silhouette stays legible
  // against the dark blueprint backdrop.
  const sourceColor = new THREE.Color(color);
  const bodyColor = isPedestrian ? sourceColor.clone().lerp(new THREE.Color(0x64748b), 0.38) : sourceColor;
  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor,
    emissive: bodyColor,
    emissiveIntensity: isPedestrian ? 0.055 : 0.12,
    metalness: 0.0,
    roughness: isPedestrian ? 0.78 : 0.68,
  });
  const shoeMat = preserveMaterialColor(new THREE.MeshStandardMaterial({
    color: '#111827',
    emissive: '#020617',
    emissiveIntensity: 0.04,
    roughness: 0.72,
  }));

  const group = new THREE.Group();

  // ── Vertical anchors (from ground). Torso bottom hugs hipY exactly so
  //    there's no gap between hip joints and the body.
  const hipY = p.legH;
  const torsoCenterY = hipY + p.torsoH / 2;
  const torsoTopY = hipY + p.torsoH;
  // Shoulder joints sit just below the top of the torso so the limb
  // top-hemispheres stay inside the body mesh.
  const shoulderY = torsoTopY - p.torsoR * 0.6;
  // Neck is short and tucked into the top of the torso.
  const neckY = torsoTopY - p.neckR * 0.2;
  const headCenterY = neckY + p.neckR * 0.4 + p.headR;

  // ── Torso: single capsule. Total capsule length = torsoH; the
  //    geometry's `length` argument is the cylinder portion only, so we
  //    subtract the two hemisphere radii to get a capsule whose total
  //    height matches torsoH exactly and whose bottom rests at hipY.
  const torsoMesh = new THREE.Group();
  const torsoCapsule = new THREE.Mesh(
    makeCapsule(p.torsoR, Math.max(0.01, p.torsoH - 2 * p.torsoR), 8, 18),
    bodyMat,
  );
  torsoMesh.add(torsoCapsule);

  // ── Optional belly bulge (heavy preset). Sphere on the front of the
  //    torso, scaled to read as a paunch. Lives inside torsoMesh so it
  //    follows torso lean during run/squat poses.
  if (traits.bellyBulge || controls.style === 'heavy') {
    const belly = new THREE.Mesh(
      makeSphere(p.torsoR * 0.95, 18, 14),
      bodyMat,
    );
    // Slightly forward-protruding, biased to lower torso (where a
    // real belly sits).
    belly.position.set(0, -p.torsoH * 0.10, p.torsoR * 0.40);
    belly.scale.set(1.05, 0.85, 0.85);
    torsoMesh.add(belly);
  }

  if (showIdentityDetails) {
    const beltMat = createPreservedMaterial('#111827', { roughness: 0.72 });
    const belt = new THREE.Mesh(
      new THREE.BoxGeometry(p.torsoR * 1.62, p.torsoR * 0.15, p.torsoR * 0.1),
      beltMat,
    );
    belt.position.set(0, -p.torsoH * 0.2, p.torsoR * 0.72);
    torsoMesh.add(belt);

    if (traits.ageCue === 'backpack') {
      const packMat = createPreservedMaterial('#334155', { roughness: 0.82 });
      const backpack = new THREE.Mesh(
        new THREE.BoxGeometry(p.torsoR * 1.65, p.torsoH * 0.5, p.torsoR * 0.38),
        packMat,
      );
      backpack.position.set(0, p.torsoH * 0.02, -p.torsoR * 0.92);
      torsoMesh.add(backpack);
    }
  }

  torsoMesh.position.y = torsoCenterY;
  if (p.torsoBindLeanX) torsoMesh.rotation.x = p.torsoBindLeanX;
  group.add(torsoMesh);

  // ── Helper: build one leg chain, with hip joint INSIDE the torso
  //    silhouette and a small hip-ball sphere to bridge any seam.
  const buildLeg = (sideX: number, splaySign: number) => {
    const hipGroup = new THREE.Group();
    hipGroup.position.set(sideX, hipY, 0);
    // Slight outward splay so the legs read as distinct stick-shapes
    // instead of merging into one column.
    hipGroup.rotation.z = splaySign * p.legSplayZ;
    // Hip ball — fractionally smaller than the leg radius so it never
    // bulges past the limb silhouette. The capsule's hemispherical end
    // still seals the seam against the torso; the ball is just insurance
    // against gaps when the limb rotates away.
    if (!isPreview) {
      const hipBall = new THREE.Mesh(makeSphere(p.legR * 0.95, 12, 10), bodyMat);
      hipGroup.add(hipBall);
    }
    // Thigh — capsule that extends downward into the leg's resting
    // direction. The capsule's top hemisphere overlaps the hip ball so
    // the seam between them disappears.
    const thighMesh = new THREE.Mesh(
      makeCapsule(p.legR, (isPreview ? p.legH : p.thighH) * 0.78, 8, 14),
      bodyMat,
    );
    thighMesh.position.y = -(isPreview ? p.legH : p.thighH) / 2;
    hipGroup.add(thighMesh);

    const kneeGroup = new THREE.Group();
    kneeGroup.position.y = -p.thighH;
    hipGroup.add(kneeGroup);
    // Knee ball — same flush-with-limb sizing rule as the hip.
    if (!isPreview) {
      const kneeBall = new THREE.Mesh(makeSphere(p.legR * 0.92, 10, 8), bodyMat);
      kneeGroup.add(kneeBall);
    }
    // Shin — slightly thinner.
    if (!isPreview) {
      const shinMesh = new THREE.Mesh(
        makeCapsule(p.legR * 0.9, p.shinH * 0.78, 8, 14),
        bodyMat,
      );
      shinMesh.position.y = -p.shinH / 2;
      kneeGroup.add(shinMesh);
    }
    // Ankle ball — small sphere where shin meets foot. Adds anatomical
    // detail so the leg doesn't end abruptly in the foot blob, and gives
    // a visible pivot point for the toe-to-heel direction.
    if (!isPreview) {
      const ankleBall = new THREE.Mesh(
        makeSphere(p.legR * 0.85, 10, 8),
        bodyMat,
      );
      ankleBall.position.y = -p.shinH;
      kneeGroup.add(ankleBall);
    }
    // Foot — shoe-shaped: tapered front (toe) wider back (heel), the
    // body slightly above ground level so shoes read as having sole
    // thickness rather than being half-buried in the floor.
    if (!isPreview) {
      const foot = new THREE.Mesh(makeSphere(1, 16, 12), bodyMat);
      foot.scale.set(p.footHalfW, p.footHalfH, p.footHalfL);
      foot.position.set(0, -p.shinH - p.footHalfH * 0.3, p.footHalfL * 0.35);
      kneeGroup.add(foot);
    }
    // Toe nub — small forward sphere making the toe direction
    // unambiguous from any camera angle (otherwise the foot ellipsoid
    // looks like a featureless blob from above).
    if (!isPreview) {
      const toe = new THREE.Mesh(
        makeSphere(p.footHalfH * 1.4, 10, 8),
        bodyMat,
      );
      toe.position.set(0, -p.shinH - p.footHalfH * 0.6, p.footHalfL * 0.95);
      toe.scale.set(0.7, 0.7, 0.85);
      kneeGroup.add(toe);
    }

    if (showIdentityDetails || isPedestrian) {
      const sole = new THREE.Mesh(
        new THREE.BoxGeometry(
          p.footHalfW * (isPedestrian ? 1.55 : 1.9),
          p.footHalfH * 0.55,
          p.footHalfL * (isPedestrian ? 1.35 : 1.7),
        ),
        shoeMat,
      );
      sole.position.set(0, -p.shinH - p.footHalfH * 0.78, p.footHalfL * 0.35);
      kneeGroup.add(sole);
    }

    return { hip: hipGroup, knee: kneeGroup };
  };
  const leftLeg = buildLeg(-p.hipHalfWidth, -1);
  const rightLeg = buildLeg(p.hipHalfWidth, +1);
  group.add(leftLeg.hip);
  group.add(rightLeg.hip);

  // ── Helper: build one arm chain. Same recipe — joint inside torso,
  //    small shoulder ball, capsule limbs, bigger sphere as hand.
  const buildArm = (sideX: number, splaySign: number) => {
    const shoulderGroup = new THREE.Group();
    shoulderGroup.position.set(sideX, shoulderY, 0);
    // Slight outward splay so the arm hangs clear of the torso silhouette
    // instead of being glued to the side. splaySign=-1 for the left arm
    // tilts the upper-arm out to -X; +1 tilts the right arm out to +X.
    shoulderGroup.rotation.z = splaySign * p.armSplayZ;
    // Shoulder ball — kept just under arm radius (0.95×) so it never reads
    // as a bulky pad. Earlier iterations at 1.5× and 1.1× both still
    // looked like the figure had shoulder armor; flush-with-limb sizing
    // bridges the seam without drawing the eye.
    if (!isPreview) {
      const shoulderBall = new THREE.Mesh(makeSphere(p.armR * 0.95, 12, 10), bodyMat);
      shoulderGroup.add(shoulderBall);
    }
    // Upper arm
    const upperMesh = new THREE.Mesh(
      makeCapsule(p.armR, (isPreview ? p.armH : p.upperArmH) * 0.78, 8, 14),
      bodyMat,
    );
    upperMesh.position.y = -(isPreview ? p.armH : p.upperArmH) / 2;
    shoulderGroup.add(upperMesh);

    const elbowGroup = new THREE.Group();
    elbowGroup.position.y = -p.upperArmH;
    shoulderGroup.add(elbowGroup);
    // Elbow ball — flush with forearm.
    if (!isPreview) {
      const elbowBall = new THREE.Mesh(makeSphere(p.armR * 0.92, 10, 8), bodyMat);
      elbowGroup.add(elbowBall);
    }
    // Forearm
    if (!isPreview) {
      const forearmMesh = new THREE.Mesh(
        makeCapsule(p.armR * 0.9, p.forearmH * 0.78, 8, 14),
        bodyMat,
      );
      forearmMesh.position.y = -p.forearmH / 2;
      elbowGroup.add(forearmMesh);
    }
    // Wrist ball — small joint between forearm and hand. Makes the
    // arm read as having a wrist articulation even though we don't
    // expose wrist rotation in the action-pose schema yet.
    if (!isPreview) {
      const wristBall = new THREE.Mesh(
        makeSphere(p.armR * 0.78, 10, 8),
        bodyMat,
      );
      wristBall.position.y = -p.forearmH;
      elbowGroup.add(wristBall);
    }
    // Hand — sphere clearly larger than the forearm tip so the
    // silhouette reads "this is where the arm ends with a fist". Sits
    // a bit further past the wrist than before so the hand visibly
    // protrudes instead of getting hidden by the elbow bone.
    if (!isPreview) {
      const hand = new THREE.Mesh(makeSphere(p.handR, 14, 10), bodyMat);
      hand.scale.set(0.92, 0.84, 1.05);
      hand.position.set(splaySign * p.handR * 0.72, -p.forearmH - p.handR * 0.72, 0);
      elbowGroup.add(hand);
    }

    return { shoulder: shoulderGroup, elbow: elbowGroup };
  };
  const leftArm = buildArm(-p.shoulderHalfWidth, -1);
  const rightArm = buildArm(p.shoulderHalfWidth, +1);
  group.add(leftArm.shoulder);
  group.add(rightArm.shoulder);

  // ── Head: a big egg-shaped sphere on a stubby neck. The neck cylinder
  //    sinks ~20% into the torso so there's no visible neck-to-shoulder
  //    seam, and the head sphere overlaps the neck top by half a
  //    neck-radius so head-to-neck stays smooth.
  const headGroup = new THREE.Group();
  headGroup.position.set(0, headCenterY, 0);

  if (!isPreview) {
    const neckMesh = new THREE.Mesh(
      makeCylinder(p.neckR * 0.95, p.neckR * 1.05, p.neckR * 1.6, 12),
      bodyMat,
    );
    neckMesh.position.y = -(p.headR * 0.85);
    headGroup.add(neckMesh);
  }

  const skull = new THREE.Mesh(makeSphere(p.headR, 28, 22), bodyMat);
  skull.scale.y = p.headStretchY;
  headGroup.add(skull);

  if ((showIdentityDetails || isPedestrian) && traits.hairStyle) {
    const hairColor = isPedestrian
      ? new THREE.Color(0x1f2937)
      : bodyColor.clone().lerp(new THREE.Color(0x111827), 0.72);
    const hairMat = new THREE.MeshStandardMaterial({
      color: hairColor,
      emissive: hairColor,
      emissiveIntensity: isPedestrian ? 0.025 : 0.06,
      metalness: 0.0,
      roughness: 0.76,
    });
    preserveMaterialColor(hairMat);

    const hairCap = new THREE.Mesh(
      makeSphere(
        p.headR * 1.018,
        isPedestrian ? 18 : 28,
        isPedestrian ? 8 : 12,
        0,
        Math.PI * 2,
        0,
        Math.PI * (isPedestrian ? 0.45 : 0.54),
      ),
      hairMat,
    );
    hairCap.position.z = -p.headR * 0.04;
    hairCap.scale.set(1.04, p.headStretchY * 1.02, 1.02);
    headGroup.add(hairCap);

    if (showIdentityDetails && (traits.hairStyle === 'shortBob' || traits.hairStyle === 'longHair')) {
      const isLongHair = traits.hairStyle === 'longHair';
      const sideLockGeometry = makeCapsule(
        p.headR * (isLongHair ? 0.13 : 0.105),
        p.headR * (isLongHair ? 0.62 : 0.24),
        6,
        10,
      );
      for (const sx of [-1, 1]) {
        const sideLock = new THREE.Mesh(sideLockGeometry, hairMat);
        sideLock.position.set(
          sx * p.headR * 0.76,
          -p.headR * (isLongHair ? 0.42 : 0.18),
          -p.headR * 0.05,
        );
        sideLock.scale.set(0.72, 1.0, isLongHair ? 0.56 : 0.46);
        headGroup.add(sideLock);
      }
      if (isLongHair) {
        const backHair = new THREE.Mesh(
          makeCapsule(p.headR * 0.34, p.headR * 0.78, 8, 14),
          hairMat,
        );
        backHair.position.set(0, -p.headR * 0.48, -p.headR * 0.32);
        backHair.scale.set(1.2, 1.0, 0.42);
        headGroup.add(backHair);
      }
    }

    if (showIdentityDetails && traits.hairStyle === 'pigtails') {
      const tailGeometry = makeCapsule(p.headR * 0.16, p.headR * 0.42, 7, 10);
      for (const sx of [-1, 1]) {
        const tail = new THREE.Mesh(tailGeometry, hairMat);
        tail.position.set(sx * p.headR * 0.94, -p.headR * 0.18, -p.headR * 0.08);
        tail.rotation.z = sx * 0.34;
        tail.scale.set(0.8, 1.0, 0.62);
        headGroup.add(tail);
      }
    }
  }

  if (p.headBindPitch) headGroup.rotation.x = p.headBindPitch;

  group.add(headGroup);

  if (showIdentityDetails && traits.ageCue === 'cane') {
    const caneMat = createPreservedMaterial('#3f3f46', { roughness: 0.6, metalness: 0.12 });
    const cane = new THREE.Mesh(
      makeCylinder(p.armR * 0.34, p.armR * 0.34, p.legH * 0.72, 8),
      caneMat,
    );
    cane.position.set(p.shoulderHalfWidth * 1.45, p.legH * 0.38, p.torsoR * 0.58);
    cane.rotation.z = -0.18;
    group.add(cane);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(p.armR * 0.72, p.armR * 0.16, 7, 18, Math.PI), caneMat);
    handle.position.set(p.shoulderHalfWidth * 1.38, p.legH * 0.74, p.torsoR * 0.58);
    handle.rotation.z = Math.PI;
    group.add(handle);
  }

  const bones: PersonBones = {
    leftShoulder: leftArm.shoulder,
    rightShoulder: rightArm.shoulder,
    leftElbow: leftArm.elbow,
    rightElbow: rightArm.elbow,
    leftHip: leftLeg.hip,
    rightHip: rightLeg.hip,
    leftKnee: leftLeg.knee,
    rightKnee: rightLeg.knee,
    headGroup,
    torsoMesh,
    constants: {
      legH: p.legH,
      thighH: p.thighH,
      shinH: p.shinH,
      armH: p.armH,
    },
  };
  group.userData.bones = bones;
  if (controls.showControls) {
    const controlMat = new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.88,
      depthTest: false,
    });
    preserveMaterialColor(controlMat);
    const addControlBlock = (target: any, scale = 1) => {
      const marker = new THREE.Mesh(
        new THREE.BoxGeometry(0.055 * scale, 0.055 * scale, 0.055 * scale),
        controlMat,
      );
      marker.renderOrder = 900;
      target.add(marker);
    };
    addControlBlock(leftArm.shoulder);
    addControlBlock(rightArm.shoulder);
    addControlBlock(leftArm.elbow, 0.85);
    addControlBlock(rightArm.elbow, 0.85);
    addControlBlock(leftLeg.hip);
    addControlBlock(rightLeg.hip);
    addControlBlock(leftLeg.knee, 0.85);
    addControlBlock(rightLeg.knee, 0.85);
    addControlBlock(headGroup, 1.1);
    addControlBlock(torsoMesh, 1.15);
  }
  // Save bind rotations so resetPersonPose returns to the per-preset
  // natural pose (e.g. elder's stoop) instead of zeroing every joint.
  stashBind(group);

  return group;
}

/** Reset every poseable bone to its bind rotation (per-preset natural
 *  pose). Returns the bones map so callers can apply pose deltas without
 *  redoing the lookup. */
/** Reset every poseable bone to its bind rotation (per-preset natural
 *  pose). Returns the bones map so callers can apply pose deltas without
 *  redoing the lookup.
 *
 *  IMPORTANT: this also resets `group.position.y` to 0 and clears
 *  `userData.poseYOffset`. The action transform stores its pose-induced
 *  Y drop (e.g. -0.66 * legH for squat) on `userData.poseYOffset`
 *  rather than mutating `group.position.y` directly, because the parent
 *  scene calls `mesh.position.set(p.x, p.y, p.z)` after the pose has
 *  been applied — which would otherwise clobber the squat drop and
 *  leave the figure floating with feet above the ground. The scene
 *  reads `userData.poseYOffset` and adds it on top of the world-Y
 *  placement.
 */
function resetPersonPose(group: any): PersonBones | null {
  const bones: PersonBones | undefined = group.userData?.bones;
  if (!bones) return null;
  for (const key of BONE_KEYS) {
    const bone = (bones as any)[key];
    if (!bone || !bone.rotation) continue;
    const bind = bone.userData?.bindEuler;
    if (bind) bone.rotation.set(bind[0], bind[1], bind[2]);
    else bone.rotation.set(0, 0, 0);
  }
  group.scale.set(1, 1, 1);
  group.rotation.set(0, 0, 0);
  group.position.y = 0;
  group.userData.poseYOffset = 0;
  return bones;
}

/** Apply a custom user-authored pose, additive to the bind. */
function applyCustomPose(group: any, bones: PersonBones, pose: BlueprintActionPose): void {
  const setRot = (target: any, src: { x?: number; y?: number; z?: number } | undefined) => {
    if (!src) return;
    if (typeof src.x === 'number') target.rotation.x += src.x;
    if (typeof src.y === 'number') target.rotation.y += src.y;
    if (typeof src.z === 'number') target.rotation.z += src.z;
  };
  setRot(bones.leftShoulder, pose.leftShoulder);
  setRot(bones.rightShoulder, pose.rightShoulder);
  setRot(bones.leftHip, pose.leftHip);
  setRot(bones.rightHip, pose.rightHip);
  setRot(bones.headGroup, pose.head);
  if (pose.leftElbow?.x  != null) bones.leftElbow.rotation.x  += pose.leftElbow.x;
  if (pose.rightElbow?.x != null) bones.rightElbow.rotation.x += pose.rightElbow.x;
  if (pose.leftKnee?.x   != null) bones.leftKnee.rotation.x   += pose.leftKnee.x;
  if (pose.rightKnee?.x  != null) bones.rightKnee.rotation.x  += pose.rightKnee.x;
  if (pose.torso?.x      != null) bones.torsoMesh.rotation.x  += pose.torso.x;
  if (typeof pose.scaleY === 'number') group.scale.y = pose.scaleY;
  if (typeof pose.groupY === 'number') {
    group.userData.poseYOffset = (group.userData.poseYOffset ?? 0) + pose.groupY;
  }
  if (typeof pose.groupRotX === 'number') group.rotation.x += pose.groupRotX;
}

export interface ApplyPoseOptions {
  customPoses?: Record<string, BlueprintActionPose>;
}

/**
 * Pose a person group based on a free-text action label. Built-in
 * keyword presets are tuned for the cartoon mannequin and verified
 * against a full Euler-XYZ matrix derivation — earlier revisions had
 * arms/legs pointing the wrong way because rotation signs were guessed
 * rather than computed.
 *
 * Three.js sign conventions used below (right-handed, +X right, +Y up,
 * +Z toward viewer = "front"):
 *
 *   • Hip rotation about local +X:
 *       hip.x = -X  →  thigh swings FORWARD (toward viewer, +Z).
 *       hip.x = +X  →  thigh swings BACKWARD (away from viewer, -Z).
 *
 *   • Knee folds the shin BACK toward the ground when the thigh is
 *     forward. With both rotations about world +X (parent and child
 *     share the X axis), the shin's world direction comes from the
 *     SUM hip.x + knee.x. Want shin straight down → sum = 0, so
 *     knee.x = -hip.x. For sit (hip = -π/2), knee = +π/2.
 *
 *   • Shoulder rotation mirrors hip:
 *       shoulder.x = -X  →  upper arm swings FORWARD.
 *       shoulder.x = +X  →  upper arm swings BACKWARD.
 *
 *   • Elbow folds the forearm relative to the upper arm:
 *       With shoulder.x = -X (arm forward), elbow.x = -X folds the
 *       forearm CONTINUING forward (toward target / lap / chest).
 *       elbow.x = +X folds it BACKWARD relative to the upper arm
 *       (only useful for "stop" gesture or jump-up-arms-overhead).
 *
 * All previous revisions had elbow signs inverted, sending the forearm
 * back instead of forward in sit/walk/run/talk/observe — that's why
 * those poses still looked weird despite the knee fix in the prior
 * commit. This pass corrects every elbow sign.
 *
 * Custom user poses (when supplied) layer on top of the keyword preset
 * via additive deltas, so a custom "蹲下" can refine the built-in one.
 */
export function applyPersonActionTransform(
  group: any,
  action: string | undefined,
  options: ApplyPoseOptions = {},
): void {
  const bones = resetPersonPose(group);
  if (!bones || !action) return;
  const lower = action.toLowerCase();
  const legH = bones.constants.legH;

  if (lower.includes('半蹲') || (lower.includes('蹲') && (lower.includes('检查') || lower.includes('inspect')))) {
    // Half-squat / detective-inspect: thighs ~50° forward, shins under
    // hip, body leans forward, right hand reaches forward, head down.
    // foot Y before drop is ~0.187m (computed for 1.75m figure), so a
    // 0.24*legH drop puts the feet right on the ground.
    bones.leftHip.rotation.x  += -0.9;
    bones.rightHip.rotation.x += -0.9;
    bones.leftKnee.rotation.x  += 0.9;
    bones.rightKnee.rotation.x += 0.9;
    bones.rightShoulder.rotation.x += -1.4;
    bones.rightElbow.rotation.x    += -0.2;
    bones.leftShoulder.rotation.x  += -0.4;
    bones.leftElbow.rotation.x     += -0.3;
    bones.headGroup.rotation.x     += -0.3;
    bones.torsoMesh.rotation.x     += -0.4;
    group.userData.poseYOffset = -legH * 0.24;
  } else if (lower.includes('坐') || lower.includes('sit')) {
    // Thighs horizontal forward, shins straight down to the floor,
    // hands resting forward on lap. Drop the body by the leg-length
    // it lost when shins pivoted from -Y to forward.
    bones.leftHip.rotation.x  += -Math.PI / 2;
    bones.rightHip.rotation.x += -Math.PI / 2;
    bones.leftKnee.rotation.x  += Math.PI / 2 - 0.05;
    bones.rightKnee.rotation.x += Math.PI / 2 - 0.05;
    // Hands on lap: shoulder slight forward, elbow bent FORWARD (negative
    // sign — see pose convention header).
    bones.leftShoulder.rotation.x  += -0.4;
    bones.rightShoulder.rotation.x += -0.4;
    bones.leftElbow.rotation.x     += -0.55;
    bones.rightElbow.rotation.x    += -0.55;
    // Sit drops the figure so the feet rest on the ground (shins go from
    // -Y to +Z, removing roughly thighH of vertical extent — 0.5 * legH).
    group.userData.poseYOffset = -legH * 0.50;
  } else if (lower.includes('蹲') || lower.includes('squat') || lower.includes('crouch')) {
    // Deep squat: thigh past horizontal (hip flexion ~103°), shin
    // straight down, body leans forward, arms forward for balance.
    // Foot Y in figure-local space after the bone rotations ≈ 0.66*legH
    // below the hip, so a -0.66*legH world offset puts soles flush with
    // the floor.
    bones.leftHip.rotation.x  += -1.8;
    bones.rightHip.rotation.x += -1.8;
    bones.leftKnee.rotation.x  += 1.8;
    bones.rightKnee.rotation.x += 1.8;
    bones.torsoMesh.rotation.x  += -0.4;
    bones.leftShoulder.rotation.x  += -0.5;
    bones.rightShoulder.rotation.x += -0.5;
    bones.leftElbow.rotation.x     += -0.4;
    bones.rightElbow.rotation.x    += -0.4;
    group.userData.poseYOffset = -legH * 0.66;
  } else if (lower.includes('躺') || lower.includes('lying') || lower.includes('lie')) {
    group.rotation.x = -Math.PI / 2;
    group.userData.poseYOffset = 0;
  } else if (lower.includes('跳') || lower.includes('jump')) {
    // Mid-air pose: knees up bent, arms reaching overhead.
    group.userData.poseYOffset = 0.4;
    bones.leftHip.rotation.x  += -0.5;
    bones.rightHip.rotation.x += -0.5;
    bones.leftKnee.rotation.x  += 1.0;
    bones.rightKnee.rotation.x += 1.0;
    // Arms STRAIGHT UP overhead. shoulder.x = -2.4 rotates upper arm
    // from -Y up past forward to nearly +Y. elbow.x = +0.1 keeps it
    // almost straight (small +X folds slightly back, which reads as
    // a natural finger-tip-curl at full reach).
    bones.leftShoulder.rotation.x  += -2.4;
    bones.rightShoulder.rotation.x += -2.4;
    bones.leftElbow.rotation.x     += 0.1;
    bones.rightElbow.rotation.x    += 0.1;
  } else if (lower.includes('奔跑') || lower.includes('跑') || lower.includes('run')) {
    // Sprint mid-stride: front leg high knee tucked back-down, back
    // leg drives extended. Arms strong contralateral, forearms folded
    // forward (sprinter's elbow ~90°).
    bones.leftHip.rotation.x  += -1.0;
    bones.rightHip.rotation.x +=  0.6;
    bones.leftKnee.rotation.x  += 1.5;
    bones.rightKnee.rotation.x += 0.2;
    bones.rightShoulder.rotation.x += -0.9;
    bones.rightElbow.rotation.x    += -0.9;
    bones.leftShoulder.rotation.x  += +0.7;
    bones.leftElbow.rotation.x     += -0.9;
    bones.torsoMesh.rotation.x  += -0.25;
    bones.headGroup.rotation.x  += -0.1;
  } else if (lower.includes('行走') || lower.includes('走') || lower.includes('walk')) {
    // Walk mid-step: front leg slight knee bend, back leg nearly
    // extended in push-off. Arms swing contralateral.
    bones.leftHip.rotation.x  += -0.55;
    bones.rightHip.rotation.x +=  0.30;
    bones.leftKnee.rotation.x  += 0.55;
    bones.rightKnee.rotation.x += 0.10;
    bones.rightShoulder.rotation.x += -0.45;
    bones.rightElbow.rotation.x    += -0.45;
    bones.leftShoulder.rotation.x  += +0.40;
    bones.leftElbow.rotation.x     += -0.40;
  } else if (lower.includes('回头') || lower.includes('look back') || lower.includes('turn around')) {
    bones.headGroup.rotation.y += Math.PI * 0.55;
    bones.torsoMesh.rotation.y += Math.PI * 0.18;
  } else if (lower.includes('伸手') || lower.includes('指向') || lower.includes('point') || lower.includes('reach') || lower.includes('hand out')) {
    // Right arm horizontal forward, hand extended toward target.
    bones.rightShoulder.rotation.x += -Math.PI / 2;
    bones.rightElbow.rotation.x    += -0.10;
    bones.headGroup.rotation.x     += -0.05;
  } else if (lower.includes('对话') || lower.includes('talk') || lower.includes('chat') || lower.includes('speak')) {
    // Hand at chest level mid-gesture: upper arm slight forward-down,
    // forearm folds forward-up so the hand sits near the collarbone.
    bones.rightShoulder.rotation.x += -0.5;
    bones.rightShoulder.rotation.z += -0.20;
    bones.rightElbow.rotation.x    += -1.3;
    bones.headGroup.rotation.y     += 0.25;
    bones.leftShoulder.rotation.x  += 0.05;
  } else if (lower.includes('观察') || lower.includes('observe') || lower.includes('look')) {
    // Hand-shading-eyes: upper arm up-forward, forearm continues
    // up-forward across the brow. Head pitches slightly down.
    bones.rightShoulder.rotation.x += -1.7;
    bones.rightShoulder.rotation.z += 0.30;
    bones.rightElbow.rotation.x    += -0.5;
    bones.headGroup.rotation.x     += -0.18;
    bones.headGroup.rotation.y     += 0.10;
  }
  // 站立 / stand or unknown — bind pose only.

  const custom = options.customPoses?.[action];
  if (custom) applyCustomPose(group, bones, custom);
}

function createPreservedMaterial(
  color: any,
  options: { roughness?: number; metalness?: number; emissive?: any; emissiveIntensity?: number } = {},
): any {
  return preserveMaterialColor(new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.64,
    metalness: options.metalness ?? 0.08,
    emissive: options.emissive,
    emissiveIntensity: options.emissiveIntensity ?? 0,
  }));
}

function addBox(
  group: any,
  material: any,
  size: [number, number, number],
  position: [number, number, number],
): any {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  mesh.position.set(position[0], position[1], position[2]);
  group.add(mesh);
  return mesh;
}

function addCylinder(
  group: any,
  material: any,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  position: [number, number, number],
  segments = 16,
): any {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), material);
  mesh.position.set(position[0], position[1], position[2]);
  group.add(mesh);
  return mesh;
}

function addWheel(group: any, material: any, x: number, z: number, radius = 0.22, y = radius): any {
  const wheel = addCylinder(group, material, radius, radius, 0.16, [x, y, z], 16);
  wheel.rotation.x = Math.PI / 2;
  return wheel;
}

/**
 * Build a simple 3D mesh for object items. Picks a primitive that vaguely
 * matches the preset id (table = thin top + 4 legs, plant = stem + foliage,
 * car = body + roof + 4 wheels, generic box otherwise).
 */
export function createObjectMeshGroup(color: any, heightM: number, presetId: string | undefined): any {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.11,
    metalness: 0.06, roughness: 0.52, side: THREE.DoubleSide,
  });

  if (presetId?.startsWith('scene-')) {
    const id = presetId.slice('scene-'.length);
    const detail = createPreservedMaterial('#1e293b', { roughness: 0.76 });
    const glass = createPreservedMaterial('#bae6fd', { roughness: 0.24, metalness: 0.02, emissive: '#38bdf8', emissiveIntensity: 0.03 });
    const metal = createPreservedMaterial('#94a3b8', { roughness: 0.42, metalness: 0.2 });
    const wood = createPreservedMaterial('#78350f', { roughness: 0.78 });
    const green = createPreservedMaterial('#22c55e', { roughness: 0.7 });
    const white = createPreservedMaterial('#f8fafc', { roughness: 0.58 });
    const asphalt = createPreservedMaterial('#475569', { roughness: 0.84 });
    const addRoomShell = () => {
      addBox(group, mat, [2.5, 0.08, 1.85], [0, 0.04, 0]);
      addBox(group, mat, [2.5, 1.05, 0.08], [0, 0.56, -0.9]);
      addBox(group, mat, [0.08, 1.0, 1.8], [-1.25, 0.54, 0]);
      addBox(group, detail, [2.55, 0.045, 0.045], [0, 0.12, 0.92]);
      addBox(group, detail, [0.045, 0.045, 1.86], [1.25, 0.12, 0]);
      addBox(group, detail, [2.45, 0.035, 0.05], [0, 0.34, -0.84]);
      addBox(group, detail, [0.05, 0.035, 1.65], [-1.18, 0.34, 0]);
    };
    if (id === 'living-room') {
      addRoomShell();
      addBox(group, mat, [0.95, 0.28, 0.42], [-0.25, 0.22, 0.35]);
      addBox(group, mat, [1.0, 0.36, 0.12], [-0.25, 0.48, 0.16]);
      addBox(group, createPreservedMaterial('#f8fafc', { roughness: 0.68 }), [0.32, 0.12, 0.08], [-0.52, 0.42, 0.12]);
      addBox(group, createPreservedMaterial('#f8fafc', { roughness: 0.68 }), [0.32, 0.12, 0.08], [0.0, 0.42, 0.12]);
      addBox(group, detail, [0.62, 0.36, 0.05], [0.58, 0.58, -0.84]);
      addBox(group, glass, [0.3, 0.24, 0.035], [-0.56, 0.72, -0.84]);
      addBox(group, glass, [0.3, 0.24, 0.035], [-0.2, 0.72, -0.84]);
      addBox(group, wood, [0.56, 0.08, 0.34], [0.36, 0.27, 0.45]);
      addCylinder(group, wood, 0.025, 0.025, 0.25, [0.15, 0.13, 0.32], 8);
      addCylinder(group, wood, 0.025, 0.025, 0.25, [0.57, 0.13, 0.32], 8);
      return group;
    }
    if (id === 'kitchen') {
      addRoomShell();
      addBox(group, white, [1.55, 0.34, 0.38], [-0.15, 0.25, -0.62]);
      addBox(group, detail, [0.42, 0.86, 0.36], [0.82, 0.48, -0.62]);
      addBox(group, glass, [0.35, 0.04, 0.24], [-0.58, 0.46, -0.4]);
      addBox(group, wood, [0.46, 0.18, 0.36], [0.03, 0.52, -0.62]);
      [-0.55, -0.18, 0.18].forEach((x) => addBox(group, metal, [0.11, 0.025, 0.025], [x, 0.28, -0.4]));
      addBox(group, metal, [0.34, 0.025, 0.16], [-0.58, 0.5, -0.4]);
      return group;
    }
    if (id === 'bedroom') {
      addRoomShell();
      addBox(group, mat, [1.12, 0.18, 0.72], [-0.2, 0.22, 0.28]);
      addBox(group, wood, [0.12, 0.55, 0.78], [-0.82, 0.38, 0.28]);
      addBox(group, white, [0.36, 0.08, 0.28], [-0.55, 0.36, 0.28]);
      addBox(group, createPreservedMaterial('#c084fc', { roughness: 0.72 }), [0.74, 0.06, 0.68], [-0.04, 0.38, 0.28]);
      addBox(group, wood, [0.32, 0.32, 0.32], [0.7, 0.2, 0.45]);
      addBox(group, metal, [0.04, 0.08, 0.04], [0.58, 0.38, 0.57]);
      return group;
    }
    if (id === 'office' || id === 'classroom') {
      addRoomShell();
      addBox(group, id === 'classroom' ? createPreservedMaterial('#064e3b') : detail, [1.15, 0.48, 0.05], [0.05, 0.65, -0.86]);
      const rows = id === 'classroom' ? [-0.25, 0.35] : [0.15];
      rows.forEach((z, row) => {
        [-0.45, 0.35].forEach((x) => {
          addBox(group, wood, [0.42, 0.08, 0.28], [x, 0.34, z + row * 0.05]);
          addBox(group, detail, [0.26, 0.26, 0.05], [x, 0.52, z - 0.18]);
          [-0.16, 0.16].forEach((dx) => addCylinder(group, metal, 0.014, 0.014, 0.3, [x + dx, 0.18, z + 0.1], 6));
        });
      });
      return group;
    }
    if (id === 'hospital-room') {
      addRoomShell();
      addBox(group, white, [1.15, 0.22, 0.58], [-0.22, 0.32, 0.22]);
      addBox(group, detail, [0.07, 0.42, 0.62], [-0.86, 0.52, 0.22]);
      addBox(group, glass, [0.3, 0.22, 0.05], [0.62, 0.68, -0.84]);
      addCylinder(group, detail, 0.025, 0.025, 0.95, [0.78, 0.55, -0.35], 8);
      addBox(group, createPreservedMaterial('#ef4444'), [0.12, 0.03, 0.035], [0.62, 0.8, -0.81]);
      addBox(group, createPreservedMaterial('#ef4444'), [0.03, 0.12, 0.035], [0.62, 0.8, -0.81]);
      addBox(group, metal, [1.18, 0.04, 0.04], [-0.22, 0.45, 0.54]);
      return group;
    }
    if (id === 'shop-cafe' || id === 'restaurant') {
      addRoomShell();
      addBox(group, wood, [1.32, 0.24, 0.38], [-0.05, 0.25, -0.45]);
      addBox(group, detail, [0.58, 0.22, 0.05], [0.36, 0.58, -0.86]);
      [-0.52, 0.48].forEach((x) => {
        addCylinder(group, mat, 0.18, 0.18, 0.05, [x, 0.38, 0.34], 20);
        addCylinder(group, detail, 0.025, 0.025, 0.34, [x, 0.19, 0.34], 8);
        addCylinder(group, detail, 0.013, 0.013, 0.34, [x + 0.12, 0.18, 0.34], 6);
        addCylinder(group, detail, 0.013, 0.013, 0.34, [x - 0.12, 0.18, 0.34], 6);
      });
      return group;
    }
    if (id === 'street-corner') {
      addBox(group, asphalt, [2.8, 0.05, 1.95], [0, 0.025, 0]);
      addBox(group, mat, [1.18, 0.08, 0.72], [-0.78, 0.08, -0.52]);
      addBox(group, white, [0.1, 0.012, 1.2], [0.15, 0.07, 0]);
      addBox(group, white, [0.1, 0.012, 1.2], [0.38, 0.07, 0]);
      addBox(group, white, [0.55, 0.012, 0.06], [0.26, 0.071, -0.5]);
      addBox(group, white, [0.55, 0.012, 0.06], [0.26, 0.071, -0.25]);
      addBox(group, detail, [0.045, 0.08, 1.86], [-0.12, 0.09, 0]);
      addCylinder(group, detail, 0.025, 0.025, 0.92, [0.9, 0.48, -0.55], 8);
      addBox(group, createPreservedMaterial('#facc15'), [0.16, 0.1, 0.1], [0.9, 0.95, -0.55]);
      return group;
    }
    if (id === 'parking-lot') {
      addBox(group, asphalt, [2.7, 0.05, 1.9], [0, 0.025, 0]);
      [-0.75, 0, 0.75].forEach((x) => {
        addBox(group, white, [0.04, 0.012, 1.45], [x, 0.06, 0]);
      });
      addBox(group, mat, [0.78, 0.22, 0.42], [0.34, 0.22, 0.18]);
      addWheel(group, detail, 0.1, 0.42, 0.1, 0.12);
      addWheel(group, detail, 0.58, 0.42, 0.1, 0.12);
      return group;
    }
    if (id === 'park-path') {
      addBox(group, createPreservedMaterial('#166534'), [2.6, 0.05, 1.9], [0, 0.025, 0]);
      addBox(group, mat, [0.62, 0.06, 1.9], [0.08, 0.07, 0]);
      [-0.72, 0.86].forEach((x) => {
        addCylinder(group, wood, 0.04, 0.05, 0.46, [x, 0.25, -0.42], 8);
        const crown = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 10), green);
        crown.position.set(x, 0.58, -0.42);
        group.add(crown);
        [-0.1, 0.12].forEach((dx) => {
          const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), green);
          leaf.scale.set(1.3, 0.55, 0.8);
          leaf.position.set(x + dx, 0.58 + Math.abs(dx), -0.28);
          group.add(leaf);
        });
      });
      return group;
    }
    if (id === 'warehouse') {
      addBox(group, mat, [2.5, 0.08, 1.75], [0, 0.04, 0]);
      addBox(group, mat, [2.35, 1.2, 0.08], [0, 0.64, -0.86]);
      [-0.62, 0.18, 0.78].forEach((x) => {
        addBox(group, wood, [0.46, 0.3, 0.4], [x, 0.19, 0.24]);
        addBox(group, detail, [0.5, 0.82, 0.08], [x, 0.52, -0.72]);
        addBox(group, metal, [0.42, 0.035, 0.035], [x, 0.48, -0.66]);
        addBox(group, metal, [0.42, 0.035, 0.035], [x, 0.7, -0.66]);
      });
      return group;
    }
    if (id === 'house-exterior' || id === 'apartment-exterior') {
      if (id === 'apartment-exterior') {
        addBox(group, mat, [0.9, 1.8, 0.72], [0, 0.92, 0]);
        [-0.24, 0, 0.24].forEach((x) => {
          [0.45, 0.85, 1.25].forEach((y) => {
            addBox(group, glass, [0.12, 0.16, 0.03], [x, y, 0.38]);
            addBox(group, detail, [0.14, 0.015, 0.035], [x, y, 0.405]);
          });
        });
      } else {
        addBox(group, mat, [1.1, 0.82, 0.82], [0, 0.45, 0]);
        const roof = new THREE.Mesh(new THREE.ConeGeometry(0.86, 0.42, 4), createPreservedMaterial('#b45309'));
        roof.rotation.y = Math.PI / 4;
        roof.position.y = 1.08;
        group.add(roof);
        addBox(group, wood, [0.18, 0.38, 0.04], [0, 0.28, 0.43]);
        addBox(group, createPreservedMaterial('#facc15'), [0.03, 0.03, 0.02], [0.06, 0.3, 0.46]);
        addBox(group, glass, [0.2, 0.16, 0.04], [-0.3, 0.58, 0.43]);
        addBox(group, glass, [0.2, 0.16, 0.04], [0.3, 0.58, 0.43]);
        addBox(group, detail, [0.22, 0.02, 0.045], [-0.3, 0.58, 0.46]);
        addBox(group, detail, [0.22, 0.02, 0.045], [0.3, 0.58, 0.46]);
      }
      return group;
    }
    const towerLike = id.includes('tower') || id.includes('gate') || id.includes('paifang');
    const wallLike = id.includes('wall');
    addBox(group, mat, [2.4, 0.08, 1.8], [0, 0.04, 0]);
    if (wallLike) {
      addBox(group, mat, [2.5, 0.85, 0.18], [0, 0.5, 0]);
      for (let i = -1; i <= 1; i += 1) addBox(group, mat, [0.32, 0.22, 0.24], [i * 0.8, 1.05, 0]);
      return group;
    }
    const footprints = towerLike
      ? [[0, 0, 0.7, 1.6, 0.7]]
      : [[-0.55, -0.2, 0.75, 1.05, 0.75], [0.45, 0.2, 0.9, 0.72, 0.9], [0.1, -0.55, 0.55, 0.55, 0.55]];
    footprints.forEach(([x, z, w, h, d]) => {
      addBox(group, mat, [w, h, d], [x, 0.08 + h / 2, z]);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.72, 0.34, towerLike ? 8 : 4), mat);
      roof.position.set(x, 0.08 + h + 0.18, z);
      roof.rotation.y = towerLike ? 0 : Math.PI / 4;
      group.add(roof);
    });
    return group;
  }

  if (presetId?.startsWith('vehicle-')) {
    const id = presetId.slice('vehicle-'.length);
    const dark = createPreservedMaterial('#0f172a', { emissive: '#020617', emissiveIntensity: 0.08, roughness: 0.64 });
    const glass = createPreservedMaterial('#bae6fd', { emissive: '#38bdf8', emissiveIntensity: 0.035, roughness: 0.32, metalness: 0.08 });
    const metal = createPreservedMaterial('#cbd5e1', { roughness: 0.42, metalness: 0.18 });
    const redLight = createPreservedMaterial('#ef4444', { emissive: '#991b1b', emissiveIntensity: 0.08, roughness: 0.4 });
    const blueLight = createPreservedMaterial('#38bdf8', { emissive: '#0284c7', emissiveIntensity: 0.08, roughness: 0.4 });
    const makeWheel = (x: number, z: number, r = 0.22) => {
      const wheel = addWheel(group, dark, x, z, r);
      const hub = addCylinder(group, metal, r * 0.36, r * 0.36, 0.18, [x, r, z], 12);
      hub.rotation.x = Math.PI / 2;
      return wheel;
    };
    const addWindowBand = (x: number, y: number, z: number, w: number, h: number) => {
      addBox(group, glass, [w, h, 0.04], [x, y, z]);
      addBox(group, metal, [w + 0.04, 0.022, 0.05], [x, y + h / 2, z + Math.sign(z) * 0.01]);
      addBox(group, metal, [w + 0.04, 0.022, 0.05], [x, y - h / 2, z + Math.sign(z) * 0.01]);
      addBox(group, metal, [0.025, h + 0.03, 0.05], [x, y, z + Math.sign(z) * 0.01]);
    };
    const buildCar = (length: number, bodyH: number, roofW: number, roofH: number, options: { tall?: boolean; emergency?: 'ambulance' | 'police'; taxi?: boolean } = {}) => {
      addBox(group, mat, [length, bodyH, 0.92], [0, 0.36, 0]);
      addBox(group, mat, [roofW, roofH, 0.82], [-0.12, 0.36 + bodyH / 2 + roofH / 2 - 0.02, 0]);
      addWindowBand(-0.12, 0.36 + bodyH / 2 + roofH * 0.42, 0.43, roofW * 0.78, roofH * 0.36);
      addWindowBand(-0.12, 0.36 + bodyH / 2 + roofH * 0.42, -0.43, roofW * 0.78, roofH * 0.36);
      addBox(group, glass, [0.22, roofH * 0.32, 0.56], [length * 0.28, 0.36 + bodyH / 2 + roofH * 0.42, 0]);
      addBox(group, glass, [0.18, roofH * 0.28, 0.5], [-length * 0.38, 0.36 + bodyH / 2 + roofH * 0.34, 0]);
      [-0.47, 0.47].forEach((z) => {
        addBox(group, metal, [0.024, bodyH * 0.58, 0.035], [-length * 0.05, 0.43, z]);
        addBox(group, metal, [0.18, 0.035, 0.035], [length * 0.13, 0.48, z]);
        addBox(group, glass, [0.12, 0.07, 0.04], [length * 0.26, 0.65, z + Math.sign(z) * 0.04]);
      });
      addBox(group, createPreservedMaterial('#fef9c3', { emissive: '#fde68a', emissiveIntensity: 0.08 }), [0.055, 0.08, 0.24], [length / 2 + 0.012, 0.38, 0.3]);
      addBox(group, createPreservedMaterial('#fef9c3', { emissive: '#fde68a', emissiveIntensity: 0.08 }), [0.055, 0.08, 0.24], [length / 2 + 0.012, 0.38, -0.3]);
      addBox(group, redLight, [0.055, 0.08, 0.22], [-length / 2 - 0.012, 0.38, 0.3]);
      addBox(group, redLight, [0.055, 0.08, 0.22], [-length / 2 - 0.012, 0.38, -0.3]);
      makeWheel(-length * 0.33, 0.48, options.tall ? 0.25 : 0.22);
      makeWheel(length * 0.33, 0.48, options.tall ? 0.25 : 0.22);
      makeWheel(-length * 0.33, -0.48, options.tall ? 0.25 : 0.22);
      makeWheel(length * 0.33, -0.48, options.tall ? 0.25 : 0.22);
      if (options.taxi) addBox(group, createPreservedMaterial('#fef3c7'), [0.32, 0.09, 0.22], [-0.1, 0.95, 0]);
      if (options.emergency) {
        addBox(group, options.emergency === 'police' ? redLight : blueLight, [0.42, 0.08, 0.2], [-0.08, 0.98, 0]);
        if (options.emergency === 'ambulance') addBox(group, redLight, [0.08, 0.2, 0.04], [length * 0.17, 0.62, 0.48]);
      }
    };
    if (id === 'helicopter') {
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.05, 8, 18), mat);
      body.rotation.z = Math.PI / 2;
      body.position.y = 0.8;
      group.add(body);
      addBox(group, glass, [0.36, 0.18, 0.36], [0.28, 0.88, 0]);
      addBox(group, mat, [1.1, 0.08, 0.08], [-0.85, 0.82, 0]);
      const rotor = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.035, 0.12), metal);
      rotor.position.y = 1.18;
      group.add(rotor);
      const rotorCross = rotor.clone();
      rotorCross.rotation.y = Math.PI / 2;
      group.add(rotorCross);
      const tailRotor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.028, 0.08), metal);
      tailRotor.position.set(-1.42, 0.86, 0);
      tailRotor.rotation.x = Math.PI / 2;
      group.add(tailRotor);
      [-0.18, 0.18].forEach((z) => {
        const skid = addCylinder(group, dark, 0.018, 0.018, 1.05, [0, 0.42, z], 8);
        skid.rotation.z = Math.PI / 2;
        addCylinder(group, metal, 0.012, 0.012, 0.38, [-0.34, 0.58, z], 6);
        addCylinder(group, metal, 0.012, 0.012, 0.38, [0.34, 0.58, z], 6);
      });
      return group;
    }
    if (['ship', 'submarine', 'yacht'].includes(id)) {
      const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 1.6, 8, 18), mat);
      hull.rotation.z = Math.PI / 2;
      hull.scale.z = 0.55;
      hull.position.y = 0.35;
      group.add(hull);
      addBox(group, metal, [0.55, 0.35, 0.42], [id === 'submarine' ? 0 : -0.15, 0.72, 0]);
      [-0.16, 0.02, 0.2].forEach((x) => addBox(group, glass, [0.08, 0.08, 0.035], [x, 0.78, 0.23]));
      if (id === 'submarine') {
        const periscope = addCylinder(group, metal, 0.025, 0.025, 0.36, [0.12, 1.0, 0], 8);
        periscope.rotation.z = 0.12;
      } else {
        addBox(group, metal, [1.15, 0.025, 0.035], [-0.05, 0.64, 0.39]);
        addBox(group, metal, [1.15, 0.025, 0.035], [-0.05, 0.64, -0.39]);
      }
      return group;
    }
    if (id === 'bicycle' || id === 'motorcycle' || id === 'e-scooter') {
      makeWheel(-0.45, 0, id === 'bicycle' ? 0.26 : 0.23);
      makeWheel(0.45, 0, id === 'bicycle' ? 0.26 : 0.23);
      const frameHeight = id === 'e-scooter' ? 0.42 : 0.52;
      addBox(group, mat, [0.9, 0.08, 0.08], [0, frameHeight, 0]);
      addBox(group, mat, [0.56, 0.055, 0.055], [-0.1, frameHeight - 0.16, 0]);
      addBox(group, dark, [0.22, 0.06, 0.18], [-0.05, frameHeight + 0.2, 0]);
      if (id === 'motorcycle') addBox(group, mat, [0.42, 0.22, 0.26], [0.14, 0.48, 0]);
      if (id === 'e-scooter') {
        const handle = addCylinder(group, metal, 0.025, 0.025, 0.66, [0.45, 0.74, 0], 8);
        handle.rotation.z = -0.22;
      }
      return group;
    }
    if (id === 'tank') {
      const hull = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.42, 0.9), mat);
      hull.position.y = 0.42;
      group.add(hull);
      addBox(group, dark, [1.9, 0.18, 0.08], [0, 0.25, 0.48]);
      addBox(group, dark, [1.9, 0.18, 0.08], [0, 0.25, -0.48]);
      const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.28, 18), mat);
      turret.position.y = 0.82;
      group.add(turret);
      const barrel = addCylinder(group, dark, 0.045, 0.045, 1.0, [0.72, 0.84, 0], 10);
      barrel.rotation.z = Math.PI / 2;
      return group;
    }
    if (id === 'sedan-chair') {
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.8, 0.75), mat);
      cabin.position.y = 0.58;
      group.add(cabin);
      addBox(group, glass, [0.32, 0.28, 0.04], [0, 0.65, 0.4]);
      addBox(group, createPreservedMaterial('#f8fafc', { roughness: 0.62 }), [0.8, 0.16, 0.04], [0, 0.98, 0.4]);
      const pole = addCylinder(group, dark, 0.035, 0.035, 2.4, [0, 0.72, 0], 8);
      pole.rotation.z = Math.PI / 2;
      return group;
    }
    if (id === 'subway-car') {
      addBox(group, mat, [2.8, 0.72, 0.92], [0, 0.5, 0]);
      [-0.82, -0.28, 0.28, 0.82].forEach((x) => {
        addWindowBand(x, 0.68, 0.48, 0.34, 0.18);
        addWindowBand(x, 0.68, -0.48, 0.34, 0.18);
      });
      [-0.52, 0.52].forEach((x) => addBox(group, metal, [0.03, 0.6, 0.98], [x, 0.5, 0]));
      addBox(group, metal, [2.65, 0.035, 0.035], [0, 0.88, 0.48]);
      makeWheel(-0.92, 0.48, 0.18);
      makeWheel(0.92, 0.48, 0.18);
      makeWheel(-0.92, -0.48, 0.18);
      makeWheel(0.92, -0.48, 0.18);
      return group;
    }
    if (id === 'bus' || id === 'van') {
      const length = id === 'bus' ? 2.65 : 2.05;
      addBox(group, mat, [length, 0.78, 0.92], [0, 0.52, 0]);
      [-0.72, -0.2, 0.32, 0.84].slice(0, id === 'bus' ? 4 : 3).forEach((x) => {
        addWindowBand(x, 0.72, 0.48, 0.32, 0.2);
        addWindowBand(x, 0.72, -0.48, 0.32, 0.2);
      });
      addBox(group, metal, [0.03, 0.62, 0.98], [length * 0.22, 0.52, 0]);
      makeWheel(-length * 0.35, 0.48, 0.23);
      makeWheel(length * 0.35, 0.48, 0.23);
      makeWheel(-length * 0.35, -0.48, 0.23);
      makeWheel(length * 0.35, -0.48, 0.23);
      return group;
    }
    if (id === 'truck') {
      addBox(group, mat, [1.46, 0.8, 0.92], [-0.28, 0.54, 0]);
      addBox(group, metal, [0.74, 0.62, 0.88], [0.84, 0.48, 0]);
      addWindowBand(0.84, 0.66, 0.46, 0.42, 0.18);
      addWindowBand(0.84, 0.66, -0.46, 0.42, 0.18);
      addBox(group, dark, [1.22, 0.035, 0.04], [-0.35, 0.92, 0.48]);
      addBox(group, dark, [1.22, 0.035, 0.04], [-0.35, 0.92, -0.48]);
      makeWheel(-0.88, 0.48, 0.24);
      makeWheel(0.72, 0.48, 0.24);
      makeWheel(-0.88, -0.48, 0.24);
      makeWheel(0.72, -0.48, 0.24);
      return group;
    }
    if (id === 'suv') {
      buildCar(2.0, 0.62, 1.18, 0.52, { tall: true });
      return group;
    }
    if (id === 'taxi') {
      buildCar(1.86, 0.54, 1.0, 0.42, { taxi: true });
      return group;
    }
    if (id === 'ambulance') {
      buildCar(2.12, 0.72, 1.24, 0.46, { tall: true, emergency: 'ambulance' });
      return group;
    }
    if (id === 'police-car') {
      buildCar(1.88, 0.54, 1.0, 0.4, { emergency: 'police' });
      return group;
    }
    buildCar(id === 'sedan-01' ? 1.95 : 1.82, 0.52, 0.98, 0.38);
    return group;
  }

  switch (presetId) {
    case 'terrain': {
      const ground = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 1.8), mat);
      ground.position.y = 0.06;
      group.add(ground);
      const mound = new THREE.Mesh(new THREE.SphereGeometry(0.45, 20, 12), mat);
      mound.scale.set(1.7, 0.32, 1.1);
      mound.position.set(0.35, 0.22, -0.1);
      group.add(mound);
      break;
    }
    case 'pipe': {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.55, 28, 1, true), mat);
      pipe.rotation.z = Math.PI / 2;
      pipe.position.y = 0.45;
      group.add(pipe);
      break;
    }
    case 'cube': {
      const cube = new THREE.Mesh(new THREE.BoxGeometry(heightM, heightM, heightM), mat);
      cube.position.y = heightM / 2;
      group.add(cube);
      break;
    }
    case 'sphere': {
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(heightM * 0.5, 24, 16), mat);
      sphere.position.y = heightM * 0.5;
      group.add(sphere);
      break;
    }
    case 'cylinder': {
      const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(heightM * 0.42, heightM * 0.42, heightM, 24), mat);
      cylinder.position.y = heightM / 2;
      group.add(cylinder);
      break;
    }
    case 'cone': {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(heightM * 0.5, heightM, 24), mat);
      cone.position.y = heightM / 2;
      group.add(cone);
      break;
    }
    case 'torus': {
      const torus = new THREE.Mesh(new THREE.TorusGeometry(heightM * 0.38, heightM * 0.12, 14, 32), mat);
      torus.position.y = heightM * 0.5;
      group.add(torus);
      break;
    }
    case 'plane':
    case 'disc': {
      const geometry = presetId === 'disc'
        ? new THREE.CylinderGeometry(0.62, 0.62, 0.06, 36)
        : new THREE.BoxGeometry(1.45, 0.04, 1.0);
      const plane = new THREE.Mesh(geometry, mat);
      plane.position.y = presetId === 'disc' ? 0.03 : 0.02;
      group.add(plane);
      break;
    }
    case 'ramp': {
      const ramp = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.22, 1.0), mat);
      ramp.rotation.z = -0.28;
      ramp.position.set(0, 0.24, 0);
      group.add(ramp);
      break;
    }
    case 'desk':
    case 'table': {
      const topW = presetId === 'desk' ? 1.45 : 1.4;
      const topD = presetId === 'desk' ? 0.72 : 0.8;
      const trim = createPreservedMaterial('#78350f', { roughness: 0.76 });
      addBox(group, mat, [topW, 0.08, topD], [0, heightM, 0]);
      addBox(group, trim, [topW * 0.92, 0.05, 0.05], [0, heightM - 0.075, topD * 0.44]);
      addBox(group, trim, [topW * 0.92, 0.05, 0.05], [0, heightM - 0.075, -topD * 0.44]);
      [[-topW * 0.42, topD * 0.38], [topW * 0.42, topD * 0.38], [-topW * 0.42, -topD * 0.38], [topW * 0.42, -topD * 0.38]].forEach(([x, z]) => {
        addCylinder(group, mat, 0.055, 0.055, heightM, [x, heightM / 2, z], 10);
      });
      if (presetId === 'desk') {
        const drawerMat = createPreservedMaterial('#78350f', { roughness: 0.76 });
        addBox(group, drawerMat, [0.32, 0.28, 0.52], [0.42, heightM * 0.76, 0]);
        addBox(group, createPreservedMaterial('#cbd5e1'), [0.12, 0.025, 0.02], [0.42, heightM * 0.82, 0.27]);
        addBox(group, createPreservedMaterial('#0f172a'), [0.62, 0.035, 0.44], [-0.24, heightM + 0.04, 0.03]);
      }
      break;
    }
    case 'office-chair':
    case 'ergonomic-chair':
    case 'folding-chair':
    case 'official-chair':
    case 'chair': {
      const cushion = createPreservedMaterial('#f8fafc', { roughness: 0.8 });
      addBox(group, mat, [0.5, 0.06, 0.5], [0, heightM * 0.55, 0]);
      addBox(group, cushion, [0.42, 0.045, 0.42], [0, heightM * 0.61, 0.02]);
      addBox(group, mat, [0.5, heightM * 0.5, 0.06], [0, heightM * 0.8, -0.22]);
      addBox(group, createPreservedMaterial('#1e293b', { roughness: 0.68 }), [0.4, 0.035, 0.075], [0, heightM * 0.88, -0.18]);
      if (presetId === 'office-chair' || presetId === 'ergonomic-chair') {
        const metal = createPreservedMaterial('#64748b', { roughness: 0.42, metalness: 0.24 });
        addCylinder(group, metal, 0.04, 0.04, heightM * 0.5, [0, heightM * 0.29, 0], 10);
        [[0.28, 0], [-0.28, 0], [0, 0.28], [0, -0.28]].forEach(([x, z]) => {
          const spoke = addCylinder(group, metal, 0.018, 0.018, 0.56, [x / 2, 0.05, z / 2], 8);
          spoke.rotation.z = z === 0 ? Math.PI / 2 : 0;
          spoke.rotation.x = x === 0 ? Math.PI / 2 : 0;
        });
        addBox(group, mat, [0.36, 0.16, 0.06], [0, heightM * 1.12, -0.22]);
        addBox(group, metal, [0.72, 0.035, 0.045], [0, heightM * 0.73, 0.16]);
      } else {
        [[-0.22, 0.22], [0.22, 0.22], [-0.22, -0.22], [0.22, -0.22]].forEach(([x, z]) => {
          addCylinder(group, mat, 0.04, 0.04, heightM * 0.55, [x, heightM * 0.275, z], 8);
        });
        addBox(group, createPreservedMaterial('#78350f', { roughness: 0.72 }), [0.62, 0.035, 0.035], [0, heightM * 0.42, -0.22]);
      }
      if (presetId === 'official-chair') {
        const crest = addCylinder(group, mat, 0.09, 0.09, 0.68, [0, heightM * 1.08, -0.22], 10);
        crest.rotation.z = Math.PI / 2;
        addCylinder(group, createPreservedMaterial('#facc15'), 0.035, 0.035, 0.52, [0, heightM * 1.27, -0.22], 10).rotation.z = Math.PI / 2;
      }
      break;
    }
    case 'stool':
    case 'drum-stool': {
      addCylinder(group, mat, presetId === 'stool' ? 0.32 : 0.36, presetId === 'stool' ? 0.32 : 0.42, heightM * 0.55, [0, heightM * 0.275, 0], 20);
      addCylinder(group, createPreservedMaterial('#f8fafc', { roughness: 0.78 }), 0.28, 0.3, 0.035, [0, heightM * 0.57, 0], 20);
      if (presetId === 'stool') {
        [[-0.18, 0.18], [0.18, 0.18], [-0.18, -0.18], [0.18, -0.18]].forEach(([x, z]) => {
          addCylinder(group, mat, 0.025, 0.025, heightM * 0.42, [x, heightM * 0.2, z], 8);
        });
      }
      break;
    }
    case 'bookshelf':
    case 'cabinet': {
      const dark = createPreservedMaterial('#1e293b', { roughness: 0.8 });
      addBox(group, mat, [0.9, heightM * 1.3, 0.38], [0, heightM * 0.65, 0]);
      if (presetId === 'bookshelf') {
        [-0.36, -0.08, 0.2, 0.46].forEach((y) => addBox(group, dark, [0.86, 0.03, 0.4], [0, heightM * 0.65 + y, 0.02]));
        [-0.28, -0.08, 0.12, 0.32].forEach((x, index) => addBox(group, createPreservedMaterial(index % 2 === 0 ? '#60a5fa' : '#f97316'), [0.1, 0.24, 0.08], [x, heightM * 0.78, 0.22]));
        addBox(group, createPreservedMaterial('#22c55e'), [0.12, 0.18, 0.08], [0.34, heightM * 0.5, 0.22]);
      } else {
        addBox(group, dark, [0.02, heightM * 1.18, 0.405], [0, heightM * 0.68, 0]);
        addBox(group, dark, [0.82, 0.025, 0.405], [0, heightM * 0.95, 0]);
        addBox(group, dark, [0.82, 0.025, 0.405], [0, heightM * 0.42, 0]);
        addBox(group, createPreservedMaterial('#cbd5e1'), [0.05, 0.03, 0.03], [-0.08, heightM * 0.68, 0.22]);
        addBox(group, createPreservedMaterial('#cbd5e1'), [0.05, 0.03, 0.03], [0.08, heightM * 0.68, 0.22]);
      }
      break;
    }
    case 'screen': {
      [-0.42, 0, 0.42].forEach((x, index) => {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(0.36, 1.35, 0.045), mat);
        panel.position.set(x, 0.675, index === 1 ? -0.04 : 0);
        panel.rotation.y = index === 0 ? -0.12 : index === 2 ? 0.12 : 0;
        group.add(panel);
        addBox(group, createPreservedMaterial('#78350f'), [0.03, 1.25, 0.05], [x - 0.18, 0.675, 0.03]);
        addBox(group, createPreservedMaterial('#78350f'), [0.03, 1.25, 0.05], [x + 0.18, 0.675, 0.03]);
      });
      break;
    }
    case 'sofa': {
      const seam = createPreservedMaterial('#78350f', { roughness: 0.76 });
      addBox(group, mat, [1.35, 0.34, 0.62], [0, 0.24, 0.05]);
      addBox(group, mat, [1.42, 0.44, 0.12], [0, 0.48, -0.25]);
      addBox(group, mat, [0.16, 0.38, 0.66], [-0.76, 0.32, 0.05]);
      addBox(group, mat, [0.16, 0.38, 0.66], [0.76, 0.32, 0.05]);
      addBox(group, seam, [0.03, 0.22, 0.64], [0, 0.34, 0.08]);
      addBox(group, seam, [1.18, 0.035, 0.04], [0, 0.42, 0.38]);
      addBox(group, createPreservedMaterial('#f8fafc', { roughness: 0.82 }), [0.32, 0.18, 0.1], [-0.38, 0.58, -0.1]);
      addBox(group, createPreservedMaterial('#f8fafc', { roughness: 0.82 }), [0.32, 0.18, 0.1], [0.38, 0.58, -0.1]);
      break;
    }
    case 'bed': {
      addBox(group, mat, [1.55, 0.22, 0.92], [0.1, 0.22, 0]);
      addBox(group, createPreservedMaterial('#78350f'), [0.14, 0.72, 0.98], [-0.74, 0.44, 0]);
      addBox(group, createPreservedMaterial('#f8fafc'), [0.46, 0.09, 0.34], [-0.42, 0.38, 0]);
      addBox(group, createPreservedMaterial('#e9d5ff'), [1.0, 0.08, 0.86], [0.28, 0.39, 0]);
      break;
    }
    case 'door': {
      addBox(group, mat, [0.68, 1.8, 0.08], [0, 0.9, 0]);
      addBox(group, createPreservedMaterial('#1e293b'), [0.54, 0.03, 0.035], [0, 1.28, 0.06]);
      addBox(group, createPreservedMaterial('#1e293b'), [0.54, 0.03, 0.035], [0, 0.72, 0.06]);
      addBox(group, createPreservedMaterial('#1e293b'), [0.03, 1.5, 0.035], [-0.26, 0.9, 0.06]);
      addBox(group, createPreservedMaterial('#1e293b'), [0.03, 1.5, 0.035], [0.26, 0.9, 0.06]);
      addBox(group, createPreservedMaterial('#facc15'), [0.055, 0.055, 0.03], [0.22, 0.86, 0.06]);
      break;
    }
    case 'window': {
      const glass = createPreservedMaterial('#bae6fd', { emissive: '#38bdf8', emissiveIntensity: 0.03, roughness: 0.28 });
      addBox(group, glass, [1.05, 0.7, 0.06], [0, 0.85, 0]);
      addBox(group, createPreservedMaterial('#334155'), [1.12, 0.06, 0.08], [0, 1.2, 0.02]);
      addBox(group, createPreservedMaterial('#334155'), [1.12, 0.06, 0.08], [0, 0.5, 0.02]);
      addBox(group, createPreservedMaterial('#334155'), [0.06, 0.72, 0.08], [0, 0.85, 0.02]);
      addBox(group, createPreservedMaterial('#334155'), [1.08, 0.035, 0.085], [0, 0.85, 0.04]);
      break;
    }
    case 'floor-lamp':
    case 'table-lamp':
    case 'lamp': {
      const metal = createPreservedMaterial('#94a3b8', { roughness: 0.38, metalness: 0.24 });
      const shadeY = presetId === 'table-lamp' ? 0.72 : 1.35;
      const stemH = presetId === 'table-lamp' ? 0.58 : 1.22;
      addCylinder(group, metal, 0.025, 0.025, stemH, [0, stemH / 2, 0], 10);
      addCylinder(group, metal, 0.22, 0.22, 0.045, [0, 0.025, 0], 18);
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.34, 20, 1, true), mat);
      shade.position.y = shadeY;
      shade.rotation.x = Math.PI;
      group.add(shade);
      addCylinder(group, createPreservedMaterial('#fef3c7', { emissive: '#facc15', emissiveIntensity: 0.12 }), 0.12, 0.12, 0.08, [0, shadeY - 0.12, 0], 14);
      addCylinder(group, metal, 0.12, 0.18, 0.025, [0, shadeY + 0.08, 0], 18);
      break;
    }
    case 'laptop': {
      const screen = createPreservedMaterial('#0f172a', { emissive: '#020617', emissiveIntensity: 0.06 });
      const metal = createPreservedMaterial('#64748b', { roughness: 0.36, metalness: 0.28 });
      addBox(group, metal, [0.72, 0.035, 0.46], [0, 0.12, 0.12]);
      addBox(group, screen, [0.72, 0.46, 0.04], [0, 0.38, -0.12]);
      addBox(group, createPreservedMaterial('#0f172a'), [0.46, 0.012, 0.18], [0, 0.15, 0.12]);
      addBox(group, createPreservedMaterial('#cbd5e1'), [0.16, 0.01, 0.08], [0, 0.165, 0.28]);
      break;
    }
    case 'phone': {
      addBox(group, createPreservedMaterial('#0f172a', { emissive: '#020617', emissiveIntensity: 0.06 }), [0.26, 0.04, 0.5], [0, 0.06, 0]);
      addBox(group, createPreservedMaterial('#334155'), [0.2, 0.02, 0.38], [0, 0.09, 0]);
      break;
    }
    case 'cup': {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.14, 0.32, 18, 1, true), mat);
      cup.position.y = 0.18;
      group.add(cup);
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.018, 8, 18, Math.PI * 1.35), mat);
      handle.position.set(0.18, 0.2, 0);
      handle.rotation.y = Math.PI / 2;
      group.add(handle);
      break;
    }
    case 'suitcase': {
      addBox(group, mat, [0.62, 0.78, 0.28], [0, 0.42, 0]);
      const handle = addCylinder(group, createPreservedMaterial('#0f172a'), 0.025, 0.025, 0.44, [0, 0.86, 0], 8);
      handle.rotation.z = Math.PI / 2;
      addBox(group, createPreservedMaterial('#0f172a'), [0.04, 0.68, 0.03], [-0.18, 0.42, 0.16]);
      addBox(group, createPreservedMaterial('#0f172a'), [0.04, 0.68, 0.03], [0.18, 0.42, 0.16]);
      break;
    }
    case 'monitor-tv': {
      const screen = createPreservedMaterial('#0f172a', { emissive: '#020617', emissiveIntensity: 0.06 });
      const metal = createPreservedMaterial('#64748b', { roughness: 0.36, metalness: 0.28 });
      addBox(group, screen, [1.0, 0.58, 0.07], [0, 0.72, 0]);
      addBox(group, createPreservedMaterial('#1e293b'), [0.84, 0.44, 0.08], [0, 0.72, 0.02]);
      addCylinder(group, metal, 0.035, 0.035, 0.38, [0, 0.31, 0], 10);
      addBox(group, metal, [0.46, 0.05, 0.28], [0, 0.08, 0]);
      break;
    }
    case 'knife': {
      const blade = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.85, 4), mat);
      blade.rotation.z = -Math.PI / 2;
      blade.position.set(0.15, 0.35, 0);
      group.add(blade);
      const handle = new THREE.Mesh(
        new THREE.BoxGeometry(0.35, 0.08, 0.12),
        preserveMaterialColor(new THREE.MeshStandardMaterial({ color: '#78350f', roughness: 0.7 })),
      );
      handle.position.set(-0.38, 0.35, 0);
      group.add(handle);
      break;
    }
    case 'shield': {
      const shield = new THREE.Mesh(new THREE.SphereGeometry(0.52, 24, 16), mat);
      shield.scale.set(0.82, 1.1, 0.14);
      shield.position.y = 0.62;
      group.add(shield);
      break;
    }
    case 'bow': {
      const bow = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.035, 8, 32, Math.PI * 1.35), mat);
      bow.rotation.z = Math.PI * 0.84;
      bow.position.y = 0.62;
      group.add(bow);
      const string = new THREE.Mesh(
        new THREE.CylinderGeometry(0.01, 0.01, 0.95, 6),
        preserveMaterialColor(new THREE.MeshStandardMaterial({ color: '#e2e8f0', roughness: 0.5 })),
      );
      string.position.y = 0.62;
      group.add(string);
      break;
    }
    case 'plant': {
      const leafMat = createPreservedMaterial('#22c55e', { roughness: 0.72 });
      const stemMat = createPreservedMaterial('#166534', { roughness: 0.76 });
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, heightM * 0.5, 8), stemMat);
      stem.position.y = heightM * 0.25;
      group.add(stem);
      const foliage = new THREE.Mesh(new THREE.SphereGeometry(heightM * 0.32, 18, 14), leafMat);
      foliage.position.y = heightM * 0.7;
      group.add(foliage);
      [[-0.22, 0.62, 0.06], [0.2, 0.74, -0.08], [0.0, 0.88, 0.12]].forEach(([x, y, z]) => {
        const leaf = new THREE.Mesh(new THREE.SphereGeometry(heightM * 0.13, 10, 8), leafMat);
        leaf.scale.set(1.55, 0.52, 0.78);
        leaf.position.set(x, y, z);
        group.add(leaf);
      });
      const pot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.18, 0.18, 14),
        preserveMaterialColor(new THREE.MeshStandardMaterial({ color: '#7c2d12', roughness: 0.7 })),
      );
      pot.position.y = 0.09;
      group.add(pot);
      break;
    }
    case 'car': {
      const lower = new THREE.Mesh(new THREE.BoxGeometry(2.2, heightM * 0.55, 0.95), mat);
      lower.position.y = heightM * 0.45;
      group.add(lower);
      const upper = new THREE.Mesh(new THREE.BoxGeometry(1.2, heightM * 0.4, 0.85), mat);
      upper.position.set(-0.1, heightM * 0.85, 0);
      group.add(upper);
      const glass = createPreservedMaterial('#bae6fd', { emissive: '#38bdf8', emissiveIntensity: 0.03 });
      addBox(group, glass, [0.72, heightM * 0.16, 0.05], [-0.08, heightM * 0.93, 0.45]);
      addBox(group, createPreservedMaterial('#fef9c3', { emissive: '#fde68a', emissiveIntensity: 0.08 }), [0.05, heightM * 0.08, 0.18], [1.12, heightM * 0.47, 0.32]);
      addBox(group, createPreservedMaterial('#ef4444'), [0.05, heightM * 0.08, 0.18], [-1.12, heightM * 0.47, 0.32]);
      const wheelGeom = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 16);
      const wheelMat = preserveMaterialColor(new THREE.MeshStandardMaterial({ color: '#1e293b', roughness: 0.7 }));
      [[-0.7, 0.5], [0.7, 0.5], [-0.7, -0.5], [0.7, -0.5]].forEach(([x, z]) => {
        const wheel = new THREE.Mesh(wheelGeom, wheelMat);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(x, 0.3, z);
        group.add(wheel);
      });
      break;
    }
    case 'box':
    case 'generic-object':
    default: {
      const size = heightM;
      const box = new THREE.Mesh(new THREE.BoxGeometry(size, size * 0.85, size), mat);
      box.position.y = (size * 0.85) / 2;
      group.add(box);
      break;
    }
  }
  return group;
}
