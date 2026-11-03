// Chart labels for AccountIsolation.tla: one device, as the person holding it sees it.
export const title = "Signing in and picking a profile";
export const state = (v) => {
  if (v.clerk.d1 === "NoOne") return "Signed out";
  const s = v.sessions.find((x) => x.dev === "d1");
  if (!s) return Object.values(v.owner).some((o) => o === v.clerk.d1) ? "Signed in, picking a profile" : "Signed in, no profiles yet";
  return v.members.r1.includes(s.prof) ? "Using a profile, in a party" : "Using a profile";
};
export const group = (v) => (v.clerk.d1 === "NoOne" ? "out" : v.sessions.length ? "profile" : "account");
export const colors = { out: "tan", account: "blue", profile: "teal" };
const labels = {
  SignIn: "you sign in",
  SignOut: "you sign out: its profile sessions end",
  MakeProfile: "you make a profile",
  ChooseProfile: "you pick a profile [PIN right, if it has one]",
  DeleteProfile: "you delete a profile",
  CreateRoom: "you start a party",
  Join: "you join a party",
  Leave: "you leave the party",
};
export const step = (action, from, to) => {
  if (action === "DeleteProfile" && from.sessions.length && !to.sessions.length) return "you delete the profile you're using";
  return labels[action] ?? null;
};
