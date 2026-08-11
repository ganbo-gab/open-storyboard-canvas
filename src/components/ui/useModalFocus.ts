import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isAvailableForFocus(element: HTMLElement): boolean {
  if (
    element.tabIndex < 0
    || element.matches(':disabled')
    || element.closest('[aria-hidden="true"], [inert]')
  ) {
    return false;
  }

  return element.getClientRects().length > 0;
}

function getFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(isAvailableForFocus);
}

interface UseModalFocusOptions {
  isOpen: boolean;
  onClose: () => void;
}

export function useModalFocus({ isOpen, onClose }: UseModalFocusOptions) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const dialog = dialogRef.current;
    const preferred = dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>('[data-autofocus="true"]'))
        .find(isAvailableForFocus)
      : null;
    const first = dialog ? getFocusableElements(dialog)[0] : null;
    (preferred ?? first ?? dialog)?.focus({ preventScroll: true });

    return () => {
      const previousFocus = previousFocusRef.current;
      if (previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
      previousFocusRef.current = null;
    };
  }, [isOpen]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (event.key === 'Escape') {
      const expandedSelect = dialog.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]');
      if (expandedSelect) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key !== 'Tab') {
      return;
    }

    const focusable = getFocusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!dialog.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [onClose]);

  return { dialogRef, onKeyDown };
}
