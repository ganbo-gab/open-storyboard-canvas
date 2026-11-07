/** Ambient declarations for Three.js example modules used by the stage runtime. */
declare module 'three/examples/jsm/controls/TransformControls.js' {
  import type { Camera, Object3D, Raycaster } from 'three';

  export class TransformControls {
    constructor(camera: Camera, domElement?: HTMLElement | null);
    axis: string | null;
    dragging: boolean;
    enabled: boolean;
    mode: 'translate' | 'rotate' | 'scale';
    showX: boolean;
    showY: boolean;
    showZ: boolean;
    object?: Object3D;
    attach(object: Object3D): this;
    detach(): this;
    dispose(): void;
    getHelper(): Object3D;
    getRaycaster(): Raycaster;
    pointerHover(pointer: { x: number; y: number; button?: number } | null): void;
    setMode(mode: 'translate' | 'rotate' | 'scale'): void;
    setSize(size: number): void;
    setSpace(space: 'world' | 'local'): void;
    setTranslationSnap(snap: number | null): void;
    setRotationSnap(snap: number | null): void;
    addEventListener(type: string, listener: (event: any) => void): void;
    removeEventListener(type: string, listener: (event: any) => void): void;
  }
}

declare module 'three/examples/jsm/loaders/GLTFLoader.js' {
  import type { Object3D } from 'three';
  export interface GLTF { scene: Object3D; animations: unknown[] }
  export class GLTFLoader {
    constructor(manager?: unknown);
    load(url: string, onLoad: (result: GLTF) => void, onProgress?: (event: ProgressEvent) => void, onError?: (error: unknown) => void): void;
    loadAsync(url: string): Promise<GLTF>;
    parseAsync(data: ArrayBuffer | string, path: string): Promise<GLTF>;
  }
}

declare module 'three/examples/jsm/utils/SkeletonUtils.js' {
  import type { Object3D } from 'three';
  export function clone(source: Object3D): Object3D;
}

declare module 'three/examples/jsm/postprocessing/OutputPass.js' {
  import type { WebGLRenderer, WebGLRenderTarget } from 'three';
  export class OutputPass {
    renderToScreen: boolean;
    render(renderer: InstanceType<typeof WebGLRenderer>, writeBuffer: InstanceType<typeof WebGLRenderTarget>, readBuffer: InstanceType<typeof WebGLRenderTarget>): void;
    dispose(): void;
  }
}
