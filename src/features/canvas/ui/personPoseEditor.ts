import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

import type { BlueprintActionPose } from '@/features/canvas/domain/canvasNodes';
import {
  PERSON_JOINTS,
  PERSON_LIMBS,
  diffPersonPose,
  type PersonLimbEnd,
  type PersonPoseJoint,
  type PersonPosePatch,
} from '@/features/canvas/domain/personPose';
import { BLUEPRINT_PRESERVE_MATERIAL_COLOR } from './blueprintMeshFactory';
import {
  applyPersonPose,
  getAppliedPersonPose,
  getPersonJointNode,
  getPersonLimbEndWorld,
  getPersonPart,
  getPersonRig,
  personJointLocalAxes,
  readPersonJointPose,
  solvePersonLimbIK,
} from './personRig';

type Group = InstanceType<typeof THREE.Group>;
type Mesh = InstanceType<typeof THREE.Mesh>;
type Camera = InstanceType<typeof THREE.PerspectiveCamera>;
type Vector = InstanceType<typeof THREE.Vector3>;
type SceneObject = InstanceType<typeof THREE.Object3D>;

export interface PersonPoseEdit {
  /** Only the joints this gesture changed (full joint values). */
  patch: PersonPosePatch;
  /** Complete pose shown after the gesture. */
  pose: BlueprintActionPose;
}

export interface PersonPoseEditorCallbacks {
  requestRender: () => void;
  onJointChange: (joint: PersonPoseJoint | null) => void;
  onCommit: (edit: PersonPoseEdit) => void;
}

type Handle = { type: 'joint'; joint: PersonPoseJoint } | { type: 'limb'; end: PersonLimbEnd };

const HANDLE = 'personPoseHandle';
/** Ends are dragged (IK) instead of rotated from a dot; rotate them by clicking the hand/foot itself. */
const LIMB_END_JOINTS = new Set<PersonPoseJoint>(Object.values(PERSON_LIMBS).map((chain) => chain.end));
const DOT_JOINTS = PERSON_JOINTS.map((spec) => spec.key).filter((key) => !LIMB_END_JOINTS.has(key) && !key.endsWith('Toes'));
const PICK_RADIUS_PX = 14;
const COLORS = { joint: 0xfbbf24, selected: 0x38bdf8, limb: 0xf472b6 };

function handleMaterial(color: number) {
  const material = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.92 });
  material.userData[BLUEPRINT_PRESERVE_MATERIAL_COLOR] = true;
  return material;
}

/**
 * Direct manipulation of one person's skeleton in the stage viewport:
 * dots select joints (rotate gizmo limited to the joint's axes), pink
 * handles on hands/feet drag the limb by two-bone IK. Nothing reaches the
 * store while dragging; one gesture yields one `onCommit`.
 */
export class PersonPoseEditor {
  readonly helper: SceneObject;
  private readonly controls: TransformControls;
  private readonly dotGeometry = new THREE.SphereGeometry(0.03, 12, 8);
  private readonly limbGeometry = new THREE.SphereGeometry(0.055, 16, 10);
  private readonly materials = {
    joint: handleMaterial(COLORS.joint),
    selected: handleMaterial(COLORS.selected),
    limb: handleMaterial(COLORS.limb),
  };
  private handles: Mesh[] = [];
  private root: Group | null = null;
  private joint: PersonPoseJoint | null = null;
  private visible = true;
  private gestureStart: BlueprintActionPose | null = null;
  private live: BlueprintActionPose = {};
  private ik: { end: PersonLimbEnd; plane: InstanceType<typeof THREE.Plane> } | null = null;
  private readonly scratch = new THREE.Vector3();

  constructor(camera: Camera, dom: HTMLElement, private readonly callbacks: PersonPoseEditorCallbacks) {
    this.controls = new TransformControls(camera, dom);
    this.controls.enabled = false;
    this.controls.setMode('rotate');
    this.controls.setSpace('local');
    this.controls.setSize(0.55);
    this.helper = this.controls.getHelper();
    this.helper.visible = false;
    this.controls.addEventListener('change', () => this.callbacks.requestRender());
    this.controls.addEventListener('objectChange', () => this.onGizmoChange());
    this.controls.addEventListener('dragging-changed', (event: { value?: boolean }) => {
      if (event.value) this.beginGesture();
      else this.endGesture();
    });
  }

  get attachedRoot(): Group | null { return this.root; }
  get selectedJoint(): PersonPoseJoint | null { return this.joint; }

  /** Attach to a person mesh (or detach with null). Re-attaching the same mesh is a no-op. */
  attach(root: Group | null): void {
    const next = root && getPersonRig(root) ? root : null;
    if (next === this.root) return;
    this.cancelGesture();
    this.removeHandles();
    this.root = next;
    if (next) this.addHandles(next);
    this.syncGizmo();
    this.callbacks.requestRender();
  }

  setJoint(joint: PersonPoseJoint | null): void {
    if (joint === this.joint) return;
    this.joint = joint;
    for (const mesh of this.handles) {
      const handle = mesh.userData[HANDLE] as Handle;
      if (handle.type === 'joint') mesh.material = handle.joint === joint ? this.materials.selected : this.materials.joint;
    }
    this.syncGizmo();
    this.callbacks.requestRender();
  }

  /** Export/screenshot mode hides every editing affordance. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const mesh of this.handles) mesh.visible = visible;
    this.syncGizmo();
  }

  isDragging(): boolean { return this.controls.dragging || this.ik !== null; }

  /** True when the pointer is over a gizmo ring (the gizmo handles that press itself). */
  hoversGizmo(ndc: { x: number; y: number }, button: number): boolean {
    if (!this.controls.enabled || !this.controls.object) return false;
    if (this.controls.dragging) return true;
    this.controls.pointerHover({ x: ndc.x, y: ndc.y, button });
    return Boolean(this.controls.axis);
  }

  /**
   * Primary-button press inside the viewport. Returns true when the press
   * belongs to the pose editor (handle, body part of the edited person).
   */
  pointerDown(ndc: { x: number; y: number }, viewport: { width: number; height: number }, camera: Camera, raycaster: InstanceType<typeof THREE.Raycaster>): boolean {
    const root = this.root;
    if (!root || !this.visible) return false;
    const handle = this.pickHandle(ndc, viewport, camera);
    if (handle?.type === 'limb') {
      const point = getPersonLimbEndWorld(root, handle.end, new THREE.Vector3());
      if (!point) return false;
      const normal = camera.getWorldDirection(new THREE.Vector3()).negate();
      this.ik = { end: handle.end, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point) };
      this.beginGesture();
      return true;
    }
    if (handle?.type === 'joint') {
      this.selectJoint(handle.joint);
      return true;
    }
    const hit = raycaster.intersectObject(root, true).find((candidate: { object: SceneObject }) => !candidate.object.userData[HANDLE]);
    const part = hit ? getPersonPart(hit.object) : null;
    if (part) {
      this.selectJoint(part);
      return true;
    }
    return false;
  }

  /** Returns true while an IK drag consumes pointer movement. */
  pointerMove(raycaster: InstanceType<typeof THREE.Raycaster>): boolean {
    if (!this.ik || !this.root) return false;
    const target: Vector | null = raycaster.ray.intersectPlane(this.ik.plane, this.scratch);
    if (target) {
      this.live = solvePersonLimbIK(this.root, this.ik.end, target, this.live);
      this.callbacks.requestRender();
    }
    return true;
  }

  pointerUp(): boolean {
    if (!this.ik) return false;
    this.ik = null;
    this.endGesture();
    return true;
  }

  /** Show a pose without committing (inspector slider drag). */
  preview(pose: BlueprintActionPose): void {
    if (!this.root) return;
    applyPersonPose(this.root, pose);
    this.callbacks.requestRender();
  }

  dispose(): void {
    this.cancelGesture();
    this.removeHandles();
    this.controls.detach();
    this.controls.dispose();
    this.helper.parent?.remove(this.helper);
    this.dotGeometry.dispose();
    this.limbGeometry.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
  }

  private selectJoint(joint: PersonPoseJoint) {
    this.setJoint(joint);
    this.callbacks.onJointChange(joint);
  }

  private beginGesture() {
    if (!this.root) return;
    this.gestureStart = getAppliedPersonPose(this.root);
    this.live = this.gestureStart;
  }

  private endGesture() {
    const root = this.root;
    const start = this.gestureStart;
    this.gestureStart = null;
    if (!root || !start) return;
    const pose = this.live;
    // Re-ground once the limb is released; dragging stays ungrounded so the body does not jump under the cursor.
    applyPersonPose(root, pose);
    this.callbacks.requestRender();
    const patch = diffPersonPose(start, pose);
    if (Object.keys(patch).length > 0) this.callbacks.onCommit({ patch, pose });
  }

  private cancelGesture() {
    if (this.root && this.gestureStart) applyPersonPose(this.root, this.gestureStart);
    this.gestureStart = null;
    this.ik = null;
  }

  private onGizmoChange() {
    if (!this.root || !this.joint || !this.gestureStart) return;
    this.live = readPersonJointPose(this.root, this.joint, this.live);
    // Re-apply so the joint snaps to its anatomical limits while dragging.
    applyPersonPose(this.root, this.live, false);
  }

  private syncGizmo() {
    const node = this.root && this.joint ? getPersonJointNode(this.root, this.joint) : undefined;
    if (!node || !this.visible || !this.joint) {
      this.controls.detach();
      this.controls.enabled = false;
      this.helper.visible = false;
      return;
    }
    const axes = personJointLocalAxes(this.joint);
    this.controls.showX = axes.has('x');
    this.controls.showY = axes.has('y');
    this.controls.showZ = axes.has('z');
    this.controls.enabled = true;
    if (this.controls.object !== node) this.controls.attach(node);
    this.helper.visible = true;
  }

  private pickHandle(ndc: { x: number; y: number }, viewport: { width: number; height: number }, camera: Camera): Handle | null {
    let best: Handle | null = null;
    let bestDistance = PICK_RADIUS_PX;
    for (const mesh of this.handles) {
      mesh.getWorldPosition(this.scratch).project(camera);
      if (this.scratch.z > 1) continue;
      const dx = ((this.scratch.x - ndc.x) / 2) * viewport.width;
      const dy = ((this.scratch.y - ndc.y) / 2) * viewport.height;
      const handle = mesh.userData[HANDLE] as Handle;
      // Limb handles win ties: they are the larger, primary affordance.
      const distance = Math.hypot(dx, dy) - (handle.type === 'limb' ? 4 : 0);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = handle;
      }
    }
    return best;
  }

  private addHandles(root: Group) {
    for (const joint of DOT_JOINTS) {
      const node = getPersonJointNode(root, joint);
      if (node) this.addHandle(node, this.dotGeometry, joint === this.joint ? this.materials.selected : this.materials.joint, { type: 'joint', joint });
    }
    for (const end of Object.keys(PERSON_LIMBS) as PersonLimbEnd[]) {
      const node = getPersonJointNode(root, PERSON_LIMBS[end].end);
      if (node) this.addHandle(node, this.limbGeometry, this.materials.limb, { type: 'limb', end });
    }
  }

  private addHandle(node: Group, geometry: InstanceType<typeof THREE.BufferGeometry>, material: InstanceType<typeof THREE.Material>, handle: Handle) {
    const mesh: Mesh = new THREE.Mesh(geometry, material);
    mesh.userData[HANDLE] = handle;
    // Shared resources: owned and disposed by the editor, not by mesh teardown.
    mesh.userData.sharedResources = true;
    mesh.renderOrder = 1000;
    mesh.visible = this.visible;
    mesh.raycast = () => undefined;
    node.add(mesh);
    this.handles.push(mesh);
  }

  private removeHandles() {
    for (const mesh of this.handles) mesh.parent?.remove(mesh);
    this.handles = [];
  }
}
