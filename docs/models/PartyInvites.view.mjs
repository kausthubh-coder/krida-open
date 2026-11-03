// Chart labels for PartyInvites.tla: one room, as the people in it see it.
const isGuest = (m) => typeof m === "string";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const title = "A party across accounts";
export const state = (v) => {
  const status = v.status.r1;
  if (status === "none") return "No party";
  if (status === "ended") return "Party over";
  const present = v.members.r1.filter((m) => !(isGuest(m) && v.expired[m]));
  if (present.length === 0) return "Empty, closing";
  const host = v.host.r1;
  if (!present.some((m) => same(m, host))) return "Host gone, others still in";
  const others = present.filter((m) => !same(m, host));
  const friend = others.some((m) => !isGuest(m));
  const guest = others.some(isGuest);
  if (friend && guest) return "Host with a friend and a guest";
  if (friend) return "Host with a friend";
  if (guest) return "Host with a guest";
  return "Host alone";
};
export const group = (v) => (v.status.r1 === "open" ? "on" : "off");
export const colors = { off: "tan", on: "teal" };
const labels = {
  CreateRoom: "the host starts a party",
  Join: "a friend opens the link",
  Leave: "someone leaves or is kicked",
  Kick: "someone leaves or is kicked",
  GuestLeaves: "someone leaves or is kicked",
  HostLeaves: "the party ends",
  EndParty: "the party ends",
  CloseIfEmpty: "the party ends",
  GuestJoins: "the guest opens their link",
  DayPasses: "the guest's 24 h run out",
  ExpireJob: "the guest's profile is removed",
  Done: "nothing more happens",
};
// Hidden: sharing the link, making a guest link, title changes and screens catching up (none leave a state).
export const step = (action, from, to) => {
  if (action === "HostLeaves" && to.status.r1 === "open") return "the host leaves: a profile of the same account hosts";
  return labels[action] ?? null;
};
