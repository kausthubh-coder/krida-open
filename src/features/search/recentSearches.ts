import { useSyncExternalStore } from "react";

const KEY = "krida.recentSearches";
const listeners = new Set<() => void>();
let recent: string[] = read();

function read(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((q): q is string => typeof q === "string") : [];
  } catch {
    return [];
  }
}

function write(next: string[]) {
  recent = next;
  localStorage.setItem(KEY, JSON.stringify(next));
  for (const listener of listeners) listener();
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Searching the latest query again (Back, a refresh) leaves the list as it is. */
export function addRecent(q: string) {
  if (recent[0] && same(recent[0], q)) return;
  write([q, ...recent.filter((r) => !same(r, q))].slice(0, 8));
}
export const removeRecent = (q: string) => write(recent.filter((r) => !same(r, q)));
export const clearRecent = () => write([]);

/** The same list in the nav and on the Search page, so a change in one shows in the other. */
export function useRecentSearches() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => recent,
  );
}
