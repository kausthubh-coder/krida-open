/** Back goes where you came from, or home when the page was opened directly. */
export function canGoBack() {
  return ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0;
}
