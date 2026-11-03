// When each party's chat was last seen on this device, kept outside any component: between episodes the
// player's party button is swapped for a new one, and messages you haven't read must stay unread.
const seen = new Map<string, number>();

/** When chat in this room was last seen. A room seen for the first time counts from `now`: what came before isn't news. */
export function seenAt(roomId: string, now: number) {
  if (!seen.has(roomId)) seen.set(roomId, now);
  return seen.get(roomId)!;
}

/** Chat in this room is read up to `at`. Never backwards: a clock measured again mustn't bring read messages back. */
export function markSeen(roomId: string, at: number) {
  seen.set(roomId, Math.max(seen.get(roomId) ?? at, at));
}
