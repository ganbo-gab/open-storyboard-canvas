import { expect, it } from 'vitest';
import * as THREE from 'three';
import { StageCameraGuide } from './stageCameraGuide';

it('uses the real camera orientation including roll and moves the sightline with free rotation', () => {
  const guide = new StageCameraGuide();
  guide.update({ position: { x: 2, y: 3, z: 4 }, target: { x: 0, y: 1, z: 0 }, fov: 45, freeRotation: { x: 0.2, y: 0.4, z: 0.8 } });
  expect(guide.camera.rotation.z).toBeCloseTo(0.8);
  guide.rotateTarget(5);
  const expected = new THREE.Vector3(0, 0, -5).applyEuler(new THREE.Euler(0.2, 0.4, 0.8, 'XYZ')).add(guide.camera.position);
  expect(guide.endpoint.position.distanceTo(expected)).toBeLessThan(0.00001);
  const scene = new THREE.Scene(); scene.add(guide.group);
  guide.dispose(); expect(scene.children).toHaveLength(0);
});
