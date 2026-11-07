import { useCallback, useEffect, useId, useState } from 'react';

/** One visible tooltip for the dense Director and Previsualization toolbars. */
export function useDirectorTooltips() {
  // Callback refs also cover a portal or toolbar that mounts after the hook.
  // Hover updates the tooltip DOM directly, without rerendering the scene.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<HTMLDivElement | null>(null);
  const rootRef = useCallback((node: HTMLDivElement | null) => setRoot(node), []);
  const tooltipRef = useCallback((node: HTMLDivElement | null) => setTip(node), []);
  const tooltipId = useId();

  useEffect(() => {
    if (!root || !tip) return;
    let activeControl: HTMLElement | null = null;
    let dismissedControl: HTMLElement | null = null;
    tip.id ||= `director-tooltip-${tooltipId}`;
    tip.setAttribute('role', 'tooltip');
    tip.removeAttribute('aria-hidden');
    tip.hidden = true;

    const findControl = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null;
      const control = target.closest('[data-director-tooltip]')
        ?? target.closest('button[title], button[aria-label]');
      return control instanceof HTMLElement && root.contains(control) ? control : null;
    };
    const getLabel = (control: HTMLElement) => (
      control.dataset.directorTooltip
      ?? control.getAttribute('title')
      ?? control.getAttribute('aria-label')
      ?? ''
    ).trim();
    const removeDescription = () => {
      if (!activeControl) return;
      const remainingIds = (activeControl.getAttribute('aria-describedby') ?? '')
        .split(/\s+/).filter((id) => id && id !== tip.id);
      if (remainingIds.length) activeControl.setAttribute('aria-describedby', remainingIds.join(' '));
      else activeControl.removeAttribute('aria-describedby');
    };
    const hide = () => {
      observer.disconnect();
      removeDescription();
      tip.hidden = true;
      activeControl = null;
    };
    const position = () => {
      if (!activeControl) return;
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const x = viewport?.offsetLeft ?? 0;
      const y = viewport?.offsetTop ?? 0;
      const margin = 8;
      tip.style.maxWidth = `${Math.max(0, Math.min(320, width - margin * 2))}px`;
      tip.style.overflowWrap = 'anywhere';
      const rect = activeControl.getBoundingClientRect();
      const tipWidth = tip.offsetWidth;
      const tipHeight = tip.offsetHeight;
      // Vertical rails ask for a side tooltip so it never covers the neighbouring tools.
      if (activeControl.dataset.directorTooltipSide === 'right' && rect.right + tipWidth + margin * 2 <= x + width) {
        tip.style.left = `${rect.right + margin}px`;
        tip.style.top = `${Math.max(y + margin, Math.min(y + height - tipHeight - margin, rect.top + rect.height / 2 - tipHeight / 2))}px`;
        return;
      }
      const left = Math.max(x + margin, Math.min(x + width - tipWidth - margin, rect.left + rect.width / 2 - tipWidth / 2));
      const below = rect.bottom + tipHeight + margin * 2 <= y + height;
      const preferredTop = below ? rect.bottom + margin : rect.top - tipHeight - margin;
      const top = Math.max(y + margin, Math.min(y + height - tipHeight - margin, preferredTop));
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    };
    const show = (target: EventTarget | null) => {
      const control = findControl(target);
      if (control !== dismissedControl) dismissedControl = null;
      // An open menu/listbox already shows the choices; its trigger's tooltip would cover them.
      if (!control || control === dismissedControl || control.getAttribute('aria-expanded') === 'true') return hide();
      const label = getLabel(control);
      if (!label) return hide();
      const keys = control.dataset.directorTooltipKeys?.trim() ?? '';
      const signature = `${label}\u0000${keys}`;
      if (activeControl === control && !tip.hidden && tip.dataset.signature === signature) return;
      hide();
      activeControl = control;
      tip.dataset.signature = signature;
      tip.replaceChildren(document.createTextNode(label));
      if (keys) {
        const kbd = document.createElement('kbd');
        kbd.className = 'stage-kbd ml-2 align-middle';
        kbd.textContent = keys;
        tip.append(kbd);
      }
      tip.hidden = false;
      const describedBy = new Set((control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
      describedBy.add(tip.id);
      control.setAttribute('aria-describedby', [...describedBy].join(' '));
      position();
      // Only observe while a tooltip is open. This updates labels such as
      // Play/Pause or a disabled reason even when the pointer is stationary.
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-director-tooltip', 'data-director-tooltip-keys', 'title', 'aria-label', 'disabled', 'aria-expanded'],
      });
    };
    const observer = new MutationObserver(() => {
      if (activeControl) show(activeControl);
    });
    const onHover = (event: MouseEvent | PointerEvent) => {
      if ('pointerType' in event && event.pointerType === 'touch') return;
      if (event.buttons) return;
      show(event.target);
    };
    const onFocusIn = (event: FocusEvent) => {
      dismissedControl = null;
      show(event.target);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (findControl(event.relatedTarget) === activeControl && activeControl) return;
      hide();
    };
    const onLeave = () => {
      dismissedControl = null;
      hide();
    };
    const dismiss = () => {
      dismissedControl = activeControl;
      hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };

    // Capture handles descendants that stop propagation. Mouse events also
    // cover WebKit's differing pointer behavior around disabled controls.
    root.addEventListener('pointerover', onHover, true);
    root.addEventListener('mouseover', onHover, true);
    root.addEventListener('mousemove', onHover, true);
    root.addEventListener('pointerleave', onLeave);
    root.addEventListener('mouseleave', onLeave);
    root.addEventListener('pointerdown', dismiss, true);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', position);
    window.addEventListener('blur', onLeave);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', dismiss);
    if (root.contains(document.activeElement)) show(document.activeElement);

    return () => {
      hide();
      root.removeEventListener('pointerover', onHover, true);
      root.removeEventListener('mouseover', onHover, true);
      root.removeEventListener('mousemove', onHover, true);
      root.removeEventListener('pointerleave', onLeave);
      root.removeEventListener('mouseleave', onLeave);
      root.removeEventListener('pointerdown', dismiss, true);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', position);
      window.removeEventListener('blur', onLeave);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', dismiss);
    };
  }, [root, tip, tooltipId]);

  return { rootRef, tooltipRef };
}
