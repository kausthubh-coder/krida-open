// The browser imports this file too; it must stay free of server-only imports.

/** "1:1-3;2:2" → ["1:1", "1:2", "1:3", "2:2"]. */
export function expandEpisodes(compact: string | undefined): string[] {
  if (!compact) return [];
  const out: string[] = [];
  for (const part of compact.split(";")) {
    const [season, ranges] = part.split(":");
    for (const range of (ranges ?? "").split(",")) {
      const [a, b] = range.split("-").map(Number);
      for (let e = a; e <= (b || a) && e - a < 5000; e++) out.push(`${season}:${e}`);
    }
  }
  return out;
}
