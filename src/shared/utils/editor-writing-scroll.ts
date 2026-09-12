/** Match caret scrolling to the existing end-of-document spacer, even after resizing. */
export const getWritingBottomMargin = (
  container: HTMLElement | null,
  content: HTMLElement | null,
): number => {
  if (!container || !content) return 0
  const padding = Number.parseFloat(getComputedStyle(content).paddingBottom) || 0
  // Keep room for the current line in small panes.
  return Math.max(0, Math.min(padding, container.clientHeight / 2))
}
