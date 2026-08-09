export interface CanvasNavigationBridge {
  focusNodeIds: (
    nodeIds: string[],
    options: { padding: number; select: boolean },
  ) => Promise<boolean> | boolean;
}

export class CanvasNavigationFacade {
  private bridge: CanvasNavigationBridge | null = null;

  registerBridge(bridge: CanvasNavigationBridge): () => void {
    this.bridge = bridge;
    return () => {
      if (this.bridge === bridge) {
        this.bridge = null;
      }
    };
  }

  isAvailable(): boolean {
    return this.bridge !== null;
  }

  async focusNodeIds(
    nodeIds: string[],
    options: { padding?: number; select?: boolean } = {},
  ): Promise<boolean> {
    if (!this.bridge) {
      return false;
    }
    return this.bridge.focusNodeIds(nodeIds, {
      padding: Math.min(1, Math.max(0, options.padding ?? 0.2)),
      select: options.select ?? false,
    });
  }
}

export const canvasNavigationFacade = new CanvasNavigationFacade();
