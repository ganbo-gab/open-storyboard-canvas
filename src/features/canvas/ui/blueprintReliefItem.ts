import * as THREE from 'three';
import type { DepthRelief } from '@/features/stage/domain/depthRelief';
import { loadDepthReliefSources } from '@/features/stage/application/depthRelief';
import { createDepthReliefMesh, disposeDepthReliefMesh } from './blueprintReliefMesh';

type Group = InstanceType<typeof THREE.Group>;
const pending = new WeakMap<Group, AbortController>();

/** Each item owns its load and GPU handles; removed/rebuilt items cannot attach late results. */
export function createReliefItemMesh(relief: DepthRelief, onReady: () => void, onError: (error: unknown) => void): Group {
  const group = new THREE.Group();
  const controller = new AbortController();
  pending.set(group, controller);
  void loadDepthReliefSources(relief, controller.signal).then(({ image, depth }) => {
    if (controller.signal.aborted) return;
    group.add(createDepthReliefMesh(image, depth, relief));
    onReady();
  }).catch((error: unknown) => { if (!controller.signal.aborted) onError(error); });
  return group;
}

/** Returns true only for groups created here; callers dispose other item kinds normally. */
export function disposeReliefItemMesh(group: Group): boolean {
  const controller = pending.get(group);
  if (!controller) return false;
  controller.abort();
  disposeDepthReliefMesh(group);
  return true;
}
