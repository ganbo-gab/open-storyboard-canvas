import * as THREE from 'three';
import type { SampledDirectorMotionFrame } from '@/features/canvas/application/directorMotion';
import type { DirectorMotionVector3 } from '@/features/canvas/domain/canvasNodes';

/** Transient editing helpers. Never part of saved scene data or captured output. */
export class StageCameraGuide {
  readonly group = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera();
  readonly endpoint = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), new THREE.MeshBasicMaterial({ color: 0x67e8f9, depthTest: false }));
  private readonly line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x67e8f9, dashSize: 0.14, gapSize: 0.1, depthTest: false, transparent: true, opacity: 0.8 }));
  private readonly body = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.35, 0.25, 0.45)), new THREE.LineBasicMaterial({ color: 0x67e8f9 }));
  private readonly frustum = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(), new THREE.Vector3(-0.35, 0.2, -0.8), new THREE.Vector3(), new THREE.Vector3(0.35, 0.2, -0.8),
    new THREE.Vector3(), new THREE.Vector3(-0.35, -0.2, -0.8), new THREE.Vector3(), new THREE.Vector3(0.35, -0.2, -0.8),
  ]), new THREE.LineBasicMaterial({ color: 0x67e8f9 }));
  constructor() {
    this.group.name = 'stage-camera-guide';
    this.camera.add(this.body, this.frustum);
    this.group.add(this.camera, this.endpoint, this.line);
    this.endpoint.renderOrder = 10; this.line.renderOrder = 9;
  }
  update(frame: NonNullable<SampledDirectorMotionFrame['camera']>) {
    this.camera.position.set(frame.position.x, frame.position.y, frame.position.z);
    this.camera.lookAt(frame.target.x, frame.target.y, frame.target.z);
    if (frame.freeRotation) this.camera.rotation.set(frame.freeRotation.x, frame.freeRotation.y, frame.freeRotation.z, 'XYZ');
    this.setTarget(frame.target);
  }
  setTarget(point: DirectorMotionVector3) {
    this.endpoint.position.set(point.x, point.y, point.z);
    this.line.geometry.dispose();
    this.line.geometry = new THREE.BufferGeometry().setFromPoints([this.camera.position.clone(), this.endpoint.position.clone()]);
    this.line.computeLineDistances();
  }
  rotateTarget(distance: number) {
    const point = new THREE.Vector3(0, 0, -Math.max(1, distance)).applyQuaternion(this.camera.quaternion).add(this.camera.position);
    this.setTarget(point);
  }
  dispose() {
    this.group.removeFromParent();
    for (const object of [this.endpoint, this.line, this.body, this.frustum]) { object.geometry.dispose(); object.material.dispose(); }
  }
}
