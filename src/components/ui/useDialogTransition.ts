import { useEffect, useState } from 'react';
import { UI_DIALOG_TRANSITION_MS } from './motion';

interface DialogTransitionState {
  shouldRender: boolean;
  isVisible: boolean;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useDialogTransition(
  isOpen: boolean,
  durationMs: number = UI_DIALOG_TRANSITION_MS
): DialogTransitionState {
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    let frameId1 = 0;
    let frameId2 = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reduceMotion = prefersReducedMotion();

    if (isOpen) {
      setShouldRender(true);
      setIsVisible(reduceMotion);
      if (reduceMotion) {
        return undefined;
      }
      frameId1 = requestAnimationFrame(() => {
        frameId2 = requestAnimationFrame(() => {
          setIsVisible(true);
        });
      });
      return () => {
        cancelAnimationFrame(frameId1);
        cancelAnimationFrame(frameId2);
        if (timer) {
          clearTimeout(timer);
        }
      };
    }

    setIsVisible(false);
    timer = setTimeout(() => {
      setShouldRender(false);
    }, reduceMotion ? 0 : durationMs);

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      cancelAnimationFrame(frameId1);
      cancelAnimationFrame(frameId2);
    };
  }, [durationMs, isOpen]);

  return { shouldRender, isVisible };
}
