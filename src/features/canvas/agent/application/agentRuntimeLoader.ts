export type CanvasAgentSdkRuntimeModule = typeof import('../infrastructure/sdkRuntime');

let runtimePromise: Promise<CanvasAgentSdkRuntimeModule> | null = null;

export function loadCanvasAgentSdkRuntime(): Promise<CanvasAgentSdkRuntimeModule> {
  runtimePromise ??= import('../infrastructure/sdkRuntime');
  return runtimePromise;
}

export function resetCanvasAgentSdkRuntimeForTests(): void {
  runtimePromise = null;
}
