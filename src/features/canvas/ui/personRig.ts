import * as THREE from 'three';
import type { BlueprintActionPose, BlueprintBodyControls, BlueprintItem, BlueprintPoseRotation } from '@/features/canvas/domain/canvasNodes';
import { normalizeBlueprintBodyControls } from '@/features/canvas/domain/directorStudioBodyControls';
import { PERSON_JOINTS, PERSON_JOINT_SPECS, PERSON_LIMBS, PERSON_REST_FINGERS, clampPersonJointValue, normalizePersonPose, type PersonPoseJoint, type PersonLimbEnd, type PersonSide } from '@/features/canvas/domain/personPose';
import { BLUEPRINT_PRESERVE_MATERIAL_COLOR } from './blueprintMeshFactory';

type Group = InstanceType<typeof THREE.Group>;
type Vector = InstanceType<typeof THREE.Vector3>;
type Geometry = InstanceType<typeof THREE.BufferGeometry>;
type Material = InstanceType<typeof THREE.Material>;
type SceneObject = InstanceType<typeof THREE.Object3D>;
export const PERSON_PART = 'personJoint';
interface Finger { base: Group; tip: Group; index: number; }
export interface PersonRig {
  body: Group;
  joints: Record<PersonPoseJoint, Group>;
  bind: Record<PersonPoseJoint, [number, number, number]>;
  fingers: Record<PersonSide, Finger[]>;
  contacts: Array<{ node: Group; point: Vector; radius: number }>;
  pose: BlueprintActionPose;
  inverse: InstanceType<typeof THREE.Matrix4>;
  point: Vector;
}

function material(color: string | number, preserve = false) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.03 });
  if (preserve) mat.userData[BLUEPRINT_PRESERVE_MATERIAL_COLOR] = true;
  return mat;
}

/** Geometry is instance-owned: viewport/thumbnail teardown may dispose it. */
export function createPersonMeshGroup(
  color: string | number | { r: number; g: number; b: number }, heightM: number,
  presetId = 'man', bodyControls?: BlueprintBodyControls,
  options: { role?: BlueprintItem['directorStudioRole']; detail?: 'full' | 'preview' } = {},
): Group {
  const controls = normalizeBlueprintBodyControls(bodyControls);
  const preview = options.detail === 'preview';
  const female = /female|woman|girl|medical|performer/i.test(presetId);
  const child = /child|boy|girl/.test(presetId);
  const elder = /elder/.test(presetId);
  const bulk = /heavy/.test(presetId) ? 1.28 : /strong/.test(presetId) ? 1.18 : /slim/.test(presetId) ? 0.86 : 1;
  const h = Math.max(0.3, heightM) * controls.core.height;
  // Explicit catalog height is authoritative; do not apply another preset height multiplier.
  const headScale = controls.core.headScale * (child && controls.style !== 'childlike' ? 1.25 : 1);
  const u = h / (0.50 * controls.legs.length + 0.37 + 0.13 * headScale);
  const thigh = u * 0.245 * controls.legs.length, shin = u * 0.22 * controls.legs.length;
  const ankleH = u * 0.035, hipH = ankleH + shin + thigh;
  const torsoW = u * 0.11 * controls.core.torsoWidth * bulk;
  const shoulderW = u * (female ? 0.105 : 0.12) * Math.sqrt(controls.core.torsoWidth);
  const hipW = u * (female ? 0.06 : 0.052) * Math.sqrt(controls.core.torsoWidth);
  const armR = u * 0.023 * controls.arms.thickness * bulk;
  const legR = u * 0.035 * controls.legs.thickness * bulk;
  const upper = u * 0.18 * controls.arms.length, fore = u * 0.145 * controls.arms.length;
  const tint = new THREE.Color(color);
  if (options.role === 'pedestrian') tint.lerp(new THREE.Color('#94a3b8'), 0.3);
  const bodyMat = material(tint), jointMat = material(tint.clone().multiplyScalar(0.65), true);
  const darkMat = material('#262932', true), hairMat = material(elder ? '#b9bac0' : '#34343a', true);
  const root = new THREE.Group(), body = new THREE.Group(), pelvis = new THREE.Group();
  root.add(body); body.add(pelvis);
  const rig: PersonRig = { body, joints: {} as PersonRig['joints'], bind: {} as PersonRig['bind'], fingers: { left: [], right: [] }, contacts: [], pose: {}, inverse: new THREE.Matrix4(), point: new THREE.Vector3() };
  root.userData.personRig = rig;
  const seg = preview ? 8 : 16;
  const add = (parent: Group, geometry: Geometry, mat: Material, pos: [number, number, number], joint?: PersonPoseJoint) => {
    const mesh = new THREE.Mesh(geometry, mat); mesh.position.set(...pos);
    mesh.castShadow = true; mesh.receiveShadow = true;
    if (joint) mesh.userData[PERSON_PART] = joint;
    parent.add(mesh); return mesh;
  };
  const ellipsoid = (parent: Group, dimensions: [number, number, number], pos: [number, number, number], joint?: PersonPoseJoint, mat = bodyMat) => {
    const mesh = add(parent, new THREE.SphereGeometry(1, seg, preview ? 6 : 12), mat, pos, joint); mesh.scale.set(...dimensions); return mesh;
  };
  const contact = (node: Group, x: number, y: number, z: number, radius = 0) => rig.contacts.push({ node, point: new THREE.Vector3(x, y, z), radius });
  const joint = (key: PersonPoseJoint, parent: Group, pos: [number, number, number], order = 'XYZ') => {
    const node = new THREE.Group(); node.position.set(...pos); node.rotation.order = order;
    node.userData[PERSON_PART] = key; rig.joints[key] = node; parent.add(node); return node;
  };
  const limb = (node: Group, length: number, rTop: number, rBottom: number, key: PersonPoseJoint) => {
    add(node, new THREE.CylinderGeometry(rTop, rBottom, Math.max(0.01, length - rTop), seg), bodyMat, [0, -length / 2, 0], key);
    ellipsoid(node, [rTop, rTop, rTop], [0, 0, 0], key, jointMat);
    contact(node, 0, -length / 2, 0, Math.max(rTop, rBottom));
  };
  ellipsoid(pelvis, [hipW * 1.5, u * 0.06, u * 0.065], [0, u * 0.018, 0], 'spine');
  contact(pelvis, 0, -u * 0.04, 0, u * 0.045);
  contact(pelvis, -hipW, 0, 0, u * 0.045); contact(pelvis, hipW, 0, 0, u * 0.045);
  const spine = joint('spine', pelvis, [0, u * 0.045, 0], 'YXZ');
  ellipsoid(spine, [torsoW * 0.72, u * 0.07, u * 0.055], [0, u * 0.05, 0], 'spine');
  const chest = joint('chest', spine, [0, u * 0.105, 0], 'YXZ');
  ellipsoid(chest, [torsoW, u * 0.105, u * 0.07], [0, u * 0.07, 0], 'chest');
  contact(chest, 0, u * 0.07, 0, u * 0.075);
  if (/heavy/.test(presetId) || controls.style === 'heavy') ellipsoid(spine, [torsoW * 0.95, u * 0.09, u * 0.085], [0, u * 0.045, u * 0.025], 'spine');
  const neck = joint('neck', chest, [0, u * 0.185, 0], 'YXZ');
  add(neck, new THREE.CylinderGeometry(u * 0.025, u * 0.032, u * 0.045, seg), bodyMat, [0, u * 0.02, 0], 'neck');
  const head = joint('head', neck, [0, u * 0.045, 0], 'YXZ');
  const headH = u * 0.065 * headScale;
  ellipsoid(head, [headH * 0.72, headH, headH * 0.82], [0, headH, 0], 'head');
  contact(head, 0, headH, 0, headH);
  if (!preview) {
    ellipsoid(head, [u * 0.009, u * 0.012, u * 0.014], [0, headH * 0.95, headH * 0.83], 'head');
    for (const side of [-1, 1]) ellipsoid(head, [u * 0.003, u * 0.003, u * 0.002], [side * headH * 0.28, headH * 1.18, headH * 0.76], 'head', darkMat);
    const hair = add(head, new THREE.SphereGeometry(1, seg, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), hairMat, [0, headH * 1.05, -u * 0.003], 'head');
    hair.scale.set(headH * 0.75, headH, headH * 0.84);
    if (female) ellipsoid(head, [headH * 0.7, headH * 0.9, headH * 0.3], [0, headH * 0.6, -headH * 0.6], 'head', hairMat);
    if (/construction|security|raincoat/.test(presetId)) {
      const hat = add(head, new THREE.SphereGeometry(1, seg, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), darkMat, [0, headH * 1.25, 0], 'head');
      hat.scale.set(headH * 0.85, headH * 0.9, headH * 0.9);
    }
  }
  for (const side of ['left', 'right'] as const) {
    const s = side === 'left' ? 1 : -1;
    const clav = joint(`${side}Clavicle`, chest, [s * u * 0.025, u * 0.15, 0]);
    const arm = joint(`${side}UpperArm`, clav, [s * (shoulderW - u * 0.025), 0, 0], 'XYZ');
    limb(arm, upper, armR * 1.22, armR * 0.85, `${side}UpperArm`);
    const elbow = joint(`${side}Forearm`, arm, [0, -upper, 0]);
    limb(elbow, fore, armR * 0.88, armR * 0.58, `${side}Forearm`);
    contact(elbow, 0, 0, 0, armR);
    const wrist = joint(`${side}Wrist`, elbow, [0, -fore, 0], 'XYZ');
    const palm = new THREE.Group(); palm.rotation.y = -s * Math.PI / 2; wrist.add(palm);
    ellipsoid(palm, [u * 0.021, u * 0.029, u * 0.011], [0, -u * 0.022, 0], `${side}Wrist`);
    const count = preview ? 1 : 4;
    for (let i = 0; i < count; i++) {
      const base = new THREE.Group(), tip = new THREE.Group();
      base.position.set(preview ? 0 : (i - 1.5) * u * 0.01, -u * 0.045, 0); palm.add(base);
      const len = u * (preview ? 0.044 : [0.037, 0.043, 0.039, 0.03][i]);
      const r = u * (preview ? 0.018 : 0.005);
      add(base, new THREE.CapsuleGeometry(r, len * 0.5, 3, preview ? 6 : 8), bodyMat, [0, -len * 0.25, 0], `${side}Wrist`);
      tip.position.y = -len * 0.5; base.add(tip);
      add(tip, new THREE.CapsuleGeometry(r * 0.9, len * 0.4, 3, 6), bodyMat, [0, -len * 0.2, 0], `${side}Wrist`);
      rig.fingers[side].push({ base, tip, index: i }); contact(tip, 0, -len * 0.45, 0, r);
    }
    const thumb = new THREE.Group(), thumbTip = new THREE.Group();
    thumb.position.set(s * u * 0.019, -u * 0.013, u * 0.003); palm.add(thumb); thumb.add(thumbTip);
    add(thumbTip, new THREE.CapsuleGeometry(u * 0.006, u * 0.027, 3, 8), bodyMat, [0, -u * 0.012, 0], `${side}Wrist`);
    rig.fingers[side].push({ base: thumb, tip: thumbTip, index: 4 });
    contact(wrist, 0, -u * 0.06, 0, u * 0.02);
    const hip = joint(`${side}Thigh`, pelvis, [s * hipW, 0, 0], 'XYZ');
    limb(hip, thigh, legR * 1.2, legR * 0.8, `${side}Thigh`);
    const knee = joint(`${side}Shin`, hip, [0, -thigh, 0]);
    limb(knee, shin, legR * 0.78, legR * 0.47, `${side}Shin`); contact(knee, 0, 0, 0, legR * 0.8);
    const foot = joint(`${side}Foot`, knee, [0, -shin, 0]);
    ellipsoid(foot, [u * 0.028, ankleH * 0.6, u * 0.055], [0, -ankleH * 0.4, u * 0.015], `${side}Foot`, darkMat);
    contact(foot, 0, -ankleH * 0.85, -u * 0.025); contact(foot, s * u * 0.025, -ankleH * 0.75, u * 0.015);
    const toe = joint(`${side}Toes`, foot, [0, -ankleH * 0.4, u * 0.05]);
    ellipsoid(toe, [u * 0.029, ankleH * 0.5, u * 0.035], [0, 0, u * 0.015], `${side}Toes`, darkMat);
    contact(toe, 0, -ankleH * 0.5, u * 0.04);
    arm.rotation.z = s * THREE.MathUtils.degToRad(6 + controls.arms.spreadDeg);
    hip.rotation.z = s * THREE.MathUtils.degToRad(2 + controls.legs.spreadDeg);
  }
  spine.rotation.x = THREE.MathUtils.degToRad((elder ? 18 : 0) - controls.core.torsoLeanDeg);
  neck.rotation.x = elder ? -0.18 : 0;
  if (!preview && /worker|medical|raincoat|performer/.test(presetId)) {
    for (const s of [-1, 1]) add(chest, new THREE.BoxGeometry(u * 0.025, u * 0.13, u * 0.008), darkMat, [s * torsoW * 0.5, u * 0.07, u * 0.068], 'chest');
  }
  if (!preview && child) add(chest, new THREE.BoxGeometry(torsoW * 1.4, u * 0.16, u * 0.05), darkMat, [0, u * 0.06, -u * 0.075], 'chest');
  for (const spec of PERSON_JOINTS) {
    const r = rig.joints[spec.key].rotation;
    rig.bind[spec.key] = [r.x, r.y, r.z];
    if (controls.showControls) {
      const marker = add(rig.joints[spec.key], new THREE.SphereGeometry(u * 0.009, 6, 4), material('#fbbf24', true), [0, 0, 0], spec.key);
      marker.renderOrder = 20;
    }
  }
  // Pose group pivots about the pelvis, independently of the scene-owned root transform.
  body.userData.hipHeight = hipH;
  applyPersonPose(root, {});
  return root;
}

export function getPersonRig(root: Group): PersonRig | undefined { return root.userData.personRig; }

/** Map authored semantic axes onto local Euler channels, exactly invertible for gizmo readback. */
function mapping(joint: PersonPoseJoint): Array<['x' | 'y' | 'z', 'x' | 'y' | 'z', number]> {
  const s = joint.startsWith('left') ? 1 : -1;
  if (/Clavicle$/.test(joint)) return [['x', 'z', s], ['y', 'y', -s]];
  if (/UpperArm$|Thigh$/.test(joint)) return [['x', 'x', -1], ['y', 'y', -s], ['z', 'z', s]];
  if (/Forearm$/.test(joint)) return [['x', 'x', -1]];
  if (/Shin$/.test(joint)) return [['x', 'x', 1]];
  if (/Wrist$/.test(joint)) return [['x', 'z', -s], ['y', 'y', -s], ['z', 'x', -1]];
  if (/Foot$/.test(joint)) return [['x', 'x', 1], ['y', 'y', -s], ['z', 'z', -s]];
  if (/Toes$/.test(joint)) return [['x', 'x', -1]];
  return [['x', 'x', 1], ['y', 'y', 1], ['z', 'z', 1]];
}

/** Local Euler axes a joint can turn about (drives which gizmo rings are shown). */
export function personJointLocalAxes(joint: PersonPoseJoint): Set<'x' | 'y' | 'z'> {
  const authored = new Set(PERSON_JOINT_SPECS[joint].axes);
  return new Set(mapping(joint).filter(([axis]) => authored.has(axis)).map(([, local]) => local));
}

export function getPersonJointNode(root: Group, joint: PersonPoseJoint): Group | undefined {
  return getPersonRig(root)?.joints[joint];
}

/** World position of a hand (wrist) or foot (ankle): the point IK drags. */
export function getPersonLimbEndWorld(root: Group, end: PersonLimbEnd, target: Vector): Vector | null {
  const node = getPersonRig(root)?.joints[PERSON_LIMBS[end].end];
  if (!node) return null;
  root.updateWorldMatrix(true, true);
  return node.getWorldPosition(target);
}

/** Currently applied pose (after grounding) — the base every interactive edit starts from. */
export function getAppliedPersonPose(root: Group): BlueprintActionPose {
  return getPersonRig(root)?.pose ?? {};
}

export function applyPersonPose(root: Group, pose: BlueprintActionPose = {}, ground = true): void {
  const rig = getPersonRig(root); if (!rig) return;
  for (const spec of PERSON_JOINTS) {
    const node = rig.joints[spec.key], bind = rig.bind[spec.key];
    node.rotation.set(bind[0], bind[1], bind[2]);
    const value = pose[spec.key] as BlueprintPoseRotation | undefined;
    if (value) for (const [authored, local, sign] of mapping(spec.key)) node.rotation[local] += (value[authored] ?? 0) * sign;
  }
  for (const side of ['left', 'right'] as const) {
    const hand = pose[`${side}Fingers`] ?? PERSON_REST_FINGERS;
    for (const finger of rig.fingers[side]) {
      const curl = finger.index === 0 ? hand.index ?? hand.curl ?? 0.25 : hand.curl ?? 0.3;
      if (finger.index === 4) {
        const s = side === 'left' ? 1 : -1;
        finger.base.rotation.set(-0.4 - (hand.thumb ?? 0.2) * 0.8, 0, s * (0.65 - (hand.thumb ?? 0.2) * 0.8));
        finger.tip.rotation.x = -(hand.thumb ?? 0.2) * 0.7;
      } else {
        finger.base.rotation.set(-curl * 1.5, 0, (finger.index - 1.5) * (hand.spread ?? 0.1) * 0.22);
        finger.tip.rotation.x = -curl * 1.6;
      }
    }
  }
  rig.body.rotation.set(pose.groupRotX ?? 0, 0, pose.groupRotZ ?? 0);
  rig.body.scale.set(1, pose.scaleY ?? 1, 1);
  if (ground) {
    rig.body.position.y = 0;
    root.updateWorldMatrix(true, true);
    rig.inverse.copy(root.matrixWorld).invert();
    let min = Infinity;
    for (const contact of rig.contacts) {
      rig.point.copy(contact.point).applyMatrix4(contact.node.matrixWorld).applyMatrix4(rig.inverse);
      min = Math.min(min, rig.point.y - contact.radius * Math.max(1, pose.scaleY ?? 1));
    }
    rig.body.position.y = (Number.isFinite(min) ? -min : rig.body.userData.hipHeight) + Math.max(0, pose.groupY ?? 0);
  }
  rig.pose = pose;
  root.userData.appliedPose = pose;
  // Any direct application (IK drag, gizmo, slider preview) invalidates the scene's pose cache.
  delete root.userData.poseKey;
}

export function readPersonJointPose(root: Group, joint: PersonPoseJoint, base: BlueprintActionPose): BlueprintActionPose {
  const rig = getPersonRig(root); if (!rig) return base;
  const r = rig.joints[joint].rotation, bind = rig.bind[joint];
  const values: BlueprintPoseRotation = {};
  for (const [authored, local, sign] of mapping(joint)) {
    const index = local === 'x' ? 0 : local === 'y' ? 1 : 2;
    values[authored] = clampPersonJointValue(joint, authored, (r[local] - bind[index]) / sign);
  }
  return { ...base, [joint]: values };
}

export function getPersonPart(object: SceneObject | null): PersonPoseJoint | null {
  for (let node: SceneObject | null = object; node; node = node.parent) {
    const key = node.userData?.[PERSON_PART] as PersonPoseJoint | undefined;
    if (key && PERSON_JOINT_SPECS[key]) return key;
  }
  return null;
}

/** Analytic two-bone reach. Work in parent-local coordinates so item scale/rotation are respected. */
export function solvePersonLimbIK(root: Group, end: PersonLimbEnd, targetWorld: Vector, pose: BlueprintActionPose): BlueprintActionPose {
  const rig = getPersonRig(root); if (!rig) return pose;
  const chain = PERSON_LIMBS[end];
  const upper = rig.joints[chain.root], hinge = rig.joints[chain.hinge], wrist = rig.joints[chain.end];
  const parent = upper.parent!;
  root.updateWorldMatrix(true, true);
  const target = parent.worldToLocal(targetWorld.clone()).sub(upper.position);
  const a = hinge.position.length(), b = wrist.position.length();
  const distance = THREE.MathUtils.clamp(target.length(), Math.abs(a - b) + 0.001, a + b - 0.001);
  const direction = target.normalize();
  const isArm = end.endsWith('Hand');
  // Keep the existing bend plane when defined; otherwise elbows back, knees forward.
  const existing = hinge.position.clone().applyQuaternion(upper.quaternion);
  const pole = existing.addScaledVector(direction, -existing.dot(direction));
  if (pole.lengthSq() < 0.00001) pole.set(0, 0, isArm ? -1 : 1).addScaledVector(direction, -direction.z * (isArm ? -1 : 1));
  if (pole.lengthSq() < 0.00001) pole.set(1, 0, 0).addScaledVector(direction, -direction.x);
  pole.normalize();
  const along = (a * a + distance * distance - b * b) / (2 * distance);
  const elbow = direction.clone().multiplyScalar(along).addScaledVector(pole, Math.sqrt(Math.max(0, a * a - along * along)));
  const u = elbow.clone().normalize(), v = direction.clone().multiplyScalar(distance).sub(elbow).normalize();
  const axis = new THREE.Vector3().crossVectors(u, v).normalize().multiplyScalar(isArm ? -1 : 1);
  const y = u.clone().negate(), z = new THREE.Vector3().crossVectors(axis, y).normalize();
  upper.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(axis, y, z));
  let result = readPersonJointPose(root, chain.root, pose);
  const bend = Math.PI - Math.acos(THREE.MathUtils.clamp((a * a + b * b - distance * distance) / (2 * a * b), -1, 1));
  result = { ...result, [chain.hinge]: { x: clampPersonJointValue(chain.hinge, 'x', bend) } };
  applyPersonPose(root, result, false);
  return result;
}

/** Resolve external/legacy input once, not on every playback frame. */
export function sanitizePersonPose(pose: unknown): BlueprintActionPose { return normalizePersonPose(pose) ?? {}; }
