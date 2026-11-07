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
const activeDialogs: HTMLDivElement[] = [];
type ModalKeyEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'defaultPrevented' | 'preventDefault' | 'stopPropagation'>;

function handleModalKey(event: ModalKeyEvent, dialog: HTMLDivElement, onClose: () => void) {
  if (event.defaultPrevented) return;
  if (event.key === 'Escape') {
    if (dialog.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
    return;
  }
  if (event.key !== 'Tab') return;
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
}


export function useModalFocus({ isOpen, onClose }: UseModalFocusOptions) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const dialog = dialogRef.current;
    if (!dialog) return;
    activeDialogs.push(dialog);
    const preferred = Array.from(dialog.querySelectorAll<HTMLElement>('[data-autofocus="true"]'))
      .find(isAvailableForFocus);
    const first = getFocusableElements(dialog)[0];
    (preferred ?? first ?? dialog).focus({ preventScroll: true });
    // Disabling a focused submit button can move focus to body. Keep Escape/Tab owned by the
    // top modal even then; menus that consumed the key keep priority via defaultPrevented.
    const outsideKey = (event: KeyboardEvent) => {
      if (activeDialogs.at(-1) !== dialog || (event.target instanceof Node && dialog.contains(event.target))) return;
      handleModalKey(event, dialog, () => closeRef.current());
    };
    document.addEventListener('keydown', outsideKey);

    return () => {
      document.removeEventListener('keydown', outsideKey);
      const index = activeDialogs.indexOf(dialog);
      if (index >= 0) activeDialogs.splice(index, 1);
      const previousFocus = previousFocusRef.current;
      if (previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
      previousFocusRef.current = null;
    };
  }, [isOpen]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const dialog = dialogRef.current;
    if (dialog && activeDialogs.at(-1) === dialog) handleModalKey(event, dialog, () => closeRef.current());
  }, []);

  return { dialogRef, onKeyDown };
}
