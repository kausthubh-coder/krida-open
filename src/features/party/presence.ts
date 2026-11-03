export type PresenceStatus = "here" | "watching" | "browsing" | "buffering" | "away";
export type Presence = { id: string; name: string; isMe: boolean; status: PresenceStatus };

/** Names as a sentence says them: "Ben", "Ben and Ana", "Ben, Ana and Guest". */
export function names(list: string[]) {
  return list.length <= 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/**
 * Who joined since the last member list, by name. Members who left are already gone from the list, so
 * someone coming back arrives again; a heartbeat that lapsed (a locked phone, a background tab) doesn't
 * change the list. The first list is who was already here.
 */
export function arrivals(before: ReadonlySet<string> | null, members: { _id: string; name: string; isMe: boolean }[]) {
  return before === null ? [] : members.filter((m) => !m.isMe && !before.has(m._id)).map((m) => m.name);
}

/** Who's in the party and what they're doing, as one line: "You and Ben are watching". */
export function presenceLine(people: Presence[]) {
  const sorted = [...people].sort((a, b) => Number(b.isMe) - Number(a.isMe));
  if (sorted.length === 1 && sorted[0].isMe) return sorted[0].status === "away" ? "You’re away" : "Just you so far";
  const groups = new Map<PresenceStatus, Presence[]>();
  for (const p of sorted) groups.set(p.status, [...(groups.get(p.status) ?? []), p]);
  return [...groups]
    .map(([status, group]) => {
      if (group.length > 1) return `${names(group.map((p) => (p.isMe ? "You" : p.name)))} are ${status}`;
      return group[0].isMe ? `You’re ${status}` : `${group[0].name} is ${status}`;
    })
    .join(" · ");
}
