import { describe, expect, it } from 'vitest';

import type { BlueprintActionPose } from './canvasNodes';
import {
  applyPersonPosePatch,
  diffPersonPose,
  normalizePersonPose,
  overlayPersonPose,
  writePersonJoint,
} from './personPose';

const walk: BlueprintActionPose = {
  leftUpperArm: { x: 0.4 },
  rightUpperArm: { x: -0.4 },
  leftShin: { x: 0.3 },
  rightFingers: { curl: 0.5 },
};

describe('person pose layering', () => {
  it('diff produces a patch that reproduces the edited pose, including removals', () => {
    const edited: BlueprintActionPose = {
      leftUpperArm: { x: 1.2, z: 0.3 },
      rightUpperArm: { x: -0.4 },
      head: { y: 0.5 },
      rightFingers: { curl: 0.5 },
    };
    const patch = diffPersonPose(walk, edited);
    expect(patch).toEqual({ leftUpperArm: { x: 1.2, z: 0.3 }, head: { y: 0.5 }, leftShin: null });
    expect(applyPersonPosePatch(walk, patch)).toEqual(edited);
    expect(diffPersonPose(walk, { ...walk })).toEqual({});
  });

  it('an explicit rest joint in an overlay holds that joint over the base, after persistence', () => {
    const overlay = normalizePersonPose(JSON.parse(JSON.stringify({ leftUpperArm: {} })));
    expect(overlay).toEqual({ leftUpperArm: {} });
    expect(overlayPersonPose(walk, overlay)?.leftUpperArm).toEqual({});
  });

  it('zeroing the last channel of an edited joint keeps it as an override', () => {
    const edited = writePersonJoint({ leftUpperArm: { x: 0.4 } }, 'leftUpperArm', 'x', 0);
    expect(edited).toEqual({ leftUpperArm: {} });
    expect(overlayPersonPose(walk, edited)?.leftUpperArm).toEqual({});
    // Handing the joint back to the layer below is an explicit `null` patch.
    expect(applyPersonPosePatch(edited, { leftUpperArm: null })).toEqual({});
  });

  it('legacy custom poses only override the joints they stored', () => {
    const legacy = normalizePersonPose({ leftElbow: { x: 1 } });
    expect(Object.keys(legacy ?? {})).toEqual(['rightForearm']);
    expect(overlayPersonPose(walk, legacy)?.leftShin).toEqual({ x: 0.3 });
  });
});
