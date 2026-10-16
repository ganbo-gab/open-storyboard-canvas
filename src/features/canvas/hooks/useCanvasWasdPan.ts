import { useEffect, type RefObject } from 'react';
import type { ReactFlowInstance, Viewport } from '@xyflow/react';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  const element = target as HTMLElement;
  return Boolean(
    element.isContentEditable ||
    element.closest([
      'input',
      'textarea',
      'select',
      'button',
      '[contenteditable]',
      'dialog',
      '[role="dialog"]',
      '.director-studio-shell',
      '[data-canvas-shortcuts-disabled="true"]',
    ].join(','))
  );
}

function canvasHasKeyboardFocus(wrapperElement: HTMLElement): boolean {
  const activeElement = document.activeElement;
  return activeElement === wrapperElement || Boolean(activeElement && wrapperElement.contains(activeElement));
}

function hasBlockingCanvasKeyboardSurface(): boolean {
  return Boolean(document.querySelector([
    'dialog',
    '[role="dialog"]',
    '.director-studio-shell',
    '[data-canvas-shortcuts-disabled="true"]',
  ].join(',')));
}

interface UseCanvasWasdPanOptions {
  wrapperRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  sensitivity: number;
  reactFlowInstance: ReactFlowInstance;
  onPanStart: () => void;
  onViewportChange: (viewport: Viewport) => void;
  onPanEnd: (viewport: Viewport) => void;
}

export function useCanvasWasdPan({
  wrapperRef,
  enabled,
  sensitivity,
  reactFlowInstance,
  onPanStart,
  onViewportChange,
  onPanEnd,
}: UseCanvasWasdPanOptions): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const pressedKeys = new Set<string>();
    let frameId: number | null = null;
    let lastFrameTime = 0;
    let hasMoved = false;

    const stopLoop = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      lastFrameTime = 0;
    };

    const finishMovement = () => {
      stopLoop();
      if (!hasMoved) {
        return;
      }
      hasMoved = false;
      onPanEnd(reactFlowInstance.getViewport());
    };

    const step = (timestamp: number) => {
      const wrapperElement = wrapperRef.current;
      if (!wrapperElement || !canvasHasKeyboardFocus(wrapperElement) || hasBlockingCanvasKeyboardSurface()) {
        pressedKeys.clear();
        finishMovement();
        return;
      }

      const deltaSeconds = lastFrameTime ? Math.min(0.05, (timestamp - lastFrameTime) / 1000) : 0;
      lastFrameTime = timestamp;

      let directionX = 0;
      let directionY = 0;
      if (pressedKeys.has('a')) directionX -= 1;
      if (pressedKeys.has('d')) directionX += 1;
      if (pressedKeys.has('w')) directionY -= 1;
      if (pressedKeys.has('s')) directionY += 1;

      if (directionX === 0 && directionY === 0) {
        finishMovement();
        return;
      }

      if (deltaSeconds > 0) {
        const speed = sensitivity * (pressedKeys.has('shift') ? 2 : 1);
        const viewport = reactFlowInstance.getViewport();
        const nextViewport = {
          x: viewport.x - directionX * speed * deltaSeconds,
          y: viewport.y - directionY * speed * deltaSeconds,
          zoom: viewport.zoom,
        };
        reactFlowInstance.setViewport(nextViewport, { duration: 0 });
        onViewportChange(nextViewport);
        hasMoved = true;
      }

      frameId = window.requestAnimationFrame(step);
    };

    const ensureLoop = () => {
      if (frameId === null) {
        onPanStart();
        frameId = window.requestAnimationFrame(step);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || isEditableTarget(event.target)) {
        return;
      }
      const wrapperElement = wrapperRef.current;
      if (!wrapperElement || !canvasHasKeyboardFocus(wrapperElement) || hasBlockingCanvasKeyboardSurface()) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key !== 'w' && key !== 'a' && key !== 's' && key !== 'd' && key !== 'shift') {
        return;
      }
      event.preventDefault();
      pressedKeys.add(key);
      ensureLoop();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key !== 'w' && key !== 'a' && key !== 's' && key !== 'd' && key !== 'shift') {
        return;
      }
      pressedKeys.delete(key);
      if (!pressedKeys.has('w') && !pressedKeys.has('a') && !pressedKeys.has('s') && !pressedKeys.has('d')) {
        finishMovement();
      }
    };

    const clearKeys = () => {
      pressedKeys.clear();
      finishMovement();
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', clearKeys);
    document.addEventListener('visibilitychange', clearKeys);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', clearKeys);
      document.removeEventListener('visibilitychange', clearKeys);
      stopLoop();
    };
  }, [
    enabled,
    onPanEnd,
    onPanStart,
    onViewportChange,
    reactFlowInstance,
    sensitivity,
    wrapperRef,
  ]);
}
