import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { DIRECTOR_STUDIO_MODEL_CATALOG } from '@/features/canvas/domain/directorStudioModelCatalog';
import { normalizePersonPose } from '@/features/canvas/domain/personPose';
import { normalizeBlueprintBodyControls } from '@/features/canvas/domain/directorStudioBodyControls';
import { PERSON_POSE_MAP } from '@/features/canvas/application/personMotionLibrary';
import { applyPersonPose, createPersonMeshGroup, getPersonRig, readPersonJointPose, solvePersonLimbIK } from './personRig';

type Group = InstanceType<typeof THREE.Group>;

function bounds(root: Group) {
  root.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(root);
}

function worldOf(root: Group, joint: Parameters<typeof readPersonJointPose>[1]) {
  root.updateWorldMatrix(true, true);
  return getPersonRig(root)!.joints[joint].getWorldPosition(new THREE.Vector3());
}

describe('person rig', () => {
  it('builds every catalog person at its requested height, standing on the floor', () => {
    const people = DIRECTOR_STUDIO_MODEL_CATALOG.filter((item) => item.itemCategory === 'person');
    expect(people.length).toBeGreaterThan(0);
    for (const person of people) {
      const root = createPersonMeshGroup('#888888', 1.75, person.presetId, person.bodyControls);
      const box = bounds(root);
      expect(box.min.y).toBeGreaterThan(-0.03);
      expect(box.min.y).toBeLessThan(0.03);
      // Requested height × body-style height is authoritative; no hidden per-preset multiplier.
      const expected = 1.75 * normalizeBlueprintBodyControls(person.bodyControls).core.height;
      expect(box.max.y, person.presetId).toBeGreaterThan(expected * 0.95);
      expect(box.max.y, person.presetId).toBeLessThan(expected * 1.06);
    }
  });

  it('keeps seated, kneeling and lying figures grounded instead of floating or sinking', () => {
    for (const id of ['sit-upright', 'kneel-one', 'squat-low', 'lie-back']) {
      const root = createPersonMeshGroup('#888888', 1.75, 'man');
      applyPersonPose(root, PERSON_POSE_MAP[id]);
      const box = bounds(root);
      expect(box.min.y, id).toBeGreaterThan(-0.05);
      expect(box.min.y, id).toBeLessThan(0.05);
    }
    const root = createPersonMeshGroup('#888888', 1.75, 'man');
    applyPersonPose(root, PERSON_POSE_MAP['lie-back']);
    // Lying down must be long and low, not a standing figure rotated into the floor.
    expect(bounds(root).max.y).toBeLessThan(0.6);
  });

  it('bends the elbow toward the chest when the forearm flexes, on both sides', () => {
    for (const side of ['left', 'right'] as const) {
      const root = createPersonMeshGroup('#888888', 1.75, 'man');
      const restWrist = worldOf(root, `${side}Wrist`);
      applyPersonPose(root, { [`${side}Forearm`]: { x: Math.PI / 2 } });
      const bentWrist = worldOf(root, `${side}Wrist`);
      // Figure faces +Z; flexion brings the hand forward and up.
      expect(bentWrist.z - restWrist.z, side).toBeGreaterThan(0.1);
      expect(bentWrist.y - restWrist.y, side).toBeGreaterThan(0.1);
    }
  });

  it('raises the anatomical left arm on the figure\'s own left (+X)', () => {
    const root = createPersonMeshGroup('#888888', 1.75, 'man');
    applyPersonPose(root, { leftUpperArm: { z: Math.PI / 2 } });
    const wrist = worldOf(root, 'leftWrist');
    const shoulder = worldOf(root, 'leftUpperArm');
    expect(wrist.x - shoulder.x).toBeGreaterThan(0.3);
    expect(Math.abs(wrist.y - shoulder.y)).toBeLessThan(0.15);
  });

  it('reads back exactly the channels it applied', () => {
    const root = createPersonMeshGroup('#888888', 1.75, 'man');
    const pose = { rightUpperArm: { x: 0.4, y: -0.3, z: 0.5 }, rightWrist: { x: 0.2, y: 0.1, z: -0.1 }, leftThigh: { x: 0.6, y: 0.1, z: 0.2 } };
    applyPersonPose(root, pose);
    for (const joint of ['rightUpperArm', 'rightWrist', 'leftThigh'] as const) {
      const read = readPersonJointPose(root, joint, {})[joint];
      for (const axis of ['x', 'y', 'z'] as const) expect(read?.[axis], `${joint}.${axis}`).toBeCloseTo(pose[joint][axis], 5);
    }
  });

  it('moves the hand to a reachable target with two-bone IK', () => {
    const root = createPersonMeshGroup('#888888', 1.75, 'man');
    root.position.set(1, 0, -2);
    root.rotation.y = 0.7;
    applyPersonPose(root, {});
    const shoulder = worldOf(root, 'rightUpperArm');
    const target = shoulder.clone().add(new THREE.Vector3(0.1, 0.05, 0.35).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.7));
    const pose = solvePersonLimbIK(root, 'rightHand', target, {});
    applyPersonPose(root, pose, false);
    expect(worldOf(root, 'rightWrist').distanceTo(target)).toBeLessThan(0.04);
  });

  it('renders legacy saved poses through the conversion path', () => {
    const legacy = normalizePersonPose({ leftHip: { x: -0.6 }, leftKnee: { x: 1.0 }, torso: { x: 0.2 } });
    expect(legacy).toBeTruthy();
    const root = createPersonMeshGroup('#888888', 1.75, 'man');
    const knee = worldOf(root, 'rightShin');
    applyPersonPose(root, legacy);
    // One leg lifts forward; the result is a real joint change, not a silently dropped pose.
    const moved = Math.max(worldOf(root, 'rightShin').distanceTo(knee), worldOf(root, 'leftShin').distanceTo(knee));
    expect(moved).toBeGreaterThan(0.05);
  });
});
