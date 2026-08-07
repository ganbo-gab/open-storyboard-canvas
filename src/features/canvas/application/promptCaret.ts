export interface PromptCaretScrollInput {
  caretContentTop: number;
  caretHeight: number;
  previousScrollTop: number;
  viewportHeight: number;
  scrollHeight: number;
  padding?: number;
}

export function resolvePromptCaretScrollTop(input: PromptCaretScrollInput): number {
  const padding = Math.max(0, input.padding ?? 4);
  const maximumScrollTop = Math.max(0, input.scrollHeight - input.viewportHeight);
  const previousScrollTop = Math.max(0, Math.min(maximumScrollTop, input.previousScrollTop));
  const visibleTop = previousScrollTop + padding;
  const visibleBottom = previousScrollTop + input.viewportHeight - padding;
  const caretBottom = input.caretContentTop + Math.max(1, input.caretHeight);

  if (input.caretContentTop < visibleTop) {
    return Math.max(0, Math.min(maximumScrollTop, input.caretContentTop - padding));
  }
  if (caretBottom > visibleBottom) {
    return Math.max(0, Math.min(
      maximumScrollTop,
      caretBottom - input.viewportHeight + padding,
    ));
  }
  return previousScrollTop;
}
