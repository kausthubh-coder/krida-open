/** A part of a video that skips itself (IntroDB or chapter times, in seconds). */
export type Part<P extends string = string> = { part: P; start: number; end: number };

/** Parts closer than this play as one: the second or so of black between a recap and an intro isn't worth a stop. */
const GAP = 2;

/** Inside a part, short of its last second, where playback runs out of it on its own. */
export const inside = (seg: { start: number; end: number }, t: number) => t >= seg.start && t < seg.end - 1;

/**
 * Where a skip to `to` lands. Crowd-sourced times often overlap (a recap that ends a few seconds into the intro) or
 * nearly touch, so landing inside or just before another part that skips itself carries on past it in the same seek.
 */
export function landing(parts: Part[], to: number) {
  let target = to;
  for (let moved = true; moved; ) {
    moved = false;
    for (const p of parts) {
      if (target >= p.start - GAP && target < p.end - 1) {
        target = p.end;
        moved = true;
      }
    }
  }
  return target;
}

/** What a skip that landed at `position` passed over, in order: the part ending there and any that led into it. */
export function skippedAt<P extends string>(parts: Part<P>[], position: number): P[] {
  const hit = parts.find((p) => Math.abs(p.end - position) < 1.5);
  if (!hit) return [];
  const before = parts.filter((p) => p !== hit && p.start < hit.start && p.end >= hit.start - GAP && p.end <= hit.end);
  return [...before.sort((a, b) => a.start - b.start).map((p) => p.part), hit.part];
}
