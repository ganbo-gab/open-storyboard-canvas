import { describe, expect, it } from 'vitest';

import { DIRECTOR_STUDIO_MODEL_CATALOG } from '@/features/canvas/domain/directorStudioModelCatalog';
import { applyPersonActionTransform, createPersonMeshGroup } from './blueprintMeshFactory';

describe('Director Studio character presets', () => {
  it('keeps every new silhouette compatible with the procedural skeleton and custom poses', () => {
    const newIds = [
      'person-construction-worker',
      'person-medical-worker',
      'person-security-officer',
      'person-stage-performer',
      'person-raincoat',
    ];
    const catalogIds = new Set(DIRECTOR_STUDIO_MODEL_CATALOG.map((item) => item.presetId));
    for (const presetId of newIds) {
      expect(catalogIds.has(presetId)).toBe(true);
      const person = createPersonMeshGroup('#f59e0b', 1.75, presetId);
      const bones = person.userData.bones;
      for (const joint of ['leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'headGroup', 'torsoMesh']) {
        expect(bones[joint]).toBeTruthy();
      }
      const bindHip = bones.leftHip.rotation.x;
      applyPersonActionTransform(person, 'custom-test-pose', { customPoses: { 'custom-test-pose': { leftHip: { x: 0.6 } } } });
      expect(bones.leftHip.rotation.x - bindHip).toBeCloseTo(0.6);
    }
  });
});
