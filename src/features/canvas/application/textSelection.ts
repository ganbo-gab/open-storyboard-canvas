export function clearBrowserTextSelection(): void {
  const activeElement = document.activeElement;
  if (
    activeElement instanceof HTMLTextAreaElement
    || activeElement instanceof HTMLInputElement
    || (activeElement instanceof HTMLElement && activeElement.isContentEditable)
  ) {
    activeElement.blur();
  }

  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0) {
    selection.removeAllRanges();
  }
}
