/** A batch that adds fewer visible titles than this barely moves the page, so it counts as empty. */
export const FEW_TITLES = 4;
/** Empty batches in a row before scrolling stops loading on its own and the button takes over. */
export const EMPTY_BATCHES = 2;

/**
 * Whether reaching the end of the results should load the next batch by itself. Only while recent
 * batches add titles people can see: duplicates, titles the Movies/Shows filter hides and TMDB's
 * sparse late pages add nothing, and the end of the list would stay in view and keep asking (TMDB
 * allows 500 pages). Pass the batches loaded so far, newest last, and what the current filter shows.
 * Changing the filter re-reads the same batches, so switching back to All can resume.
 */
export function keepLoading<T>(batches: T[][], visible: (item: T) => boolean): boolean {
  let empty = 0;
  for (let i = batches.length - 1; i >= 0 && empty < EMPTY_BATCHES; i--) {
    if (batches[i].filter(visible).length >= FEW_TITLES) break;
    empty++;
  }
  return empty < EMPTY_BATCHES;
}
