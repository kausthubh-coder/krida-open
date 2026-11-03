// Chart labels for Onboarding.tla, in the words of someone signing up.
const names = {
  landing: "Landing page",
  picker: "Profile picker",
  newProfile: "Make a profile",
  tmdbKey: "TMDB key step",
  debrid: "Debrid step",
  addons: "Addons step",
  settings: "Settings",
};
export const title = "Open Krida onboarding";
export const state = (v) => {
  if (v.screen !== "home") return names[v.screen];
  if (!v.debridValid || v.debrid === "none") return "Home, Play and parties unavailable";
  return v.debrid === "torbox" ? "Home, TorBox works" : "Home, Play works, parties unavailable";
};
export const group = (v) =>
  v.screen === "landing" ? "out" : v.screen === "home" ? "home" : v.screen === "settings" ? "settings" : "onboarding";
export const colors = { out: "tan", onboarding: "blue", home: "teal", settings: "purple" };
const labels = {
  SignIn: "you sign in",
  SignOut: "you sign out",
  AddProfile: "you add a profile",
  MakeProfile: "you make a profile",
  ChooseProfile: "you pick a profile",
  SwitchProfile: "you switch profile",
  PasteTmdb: "you give a TMDB key that works",
  KeepTmdb: "you give a TMDB key that works",
  ChooseDebrid: "you add a debrid key or skip",
  SkipDebrid: "you add a debrid key or skip",
  RemoveDebrid: "you remove the debrid key",
  InstallAddons: "you install or skip addons",
  SkipAddons: "you install or skip addons",
  Back: "you go back",
  OpenSettings: "you open Settings",
  CloseSettings: "you close Settings",
  TmdbStopsWorking: "the TMDB key stops working",
  DebridStopsWorking: "the debrid key stops working",
  PressPlay: "you press Play",
  PressParty: "you press Watch together",
};
const home = (v) => v.screen === "home";
// Sign-out works from every screen; the chart draws it only from Home to stay readable.
export const step = (action, from, to) => {
  if (action === "SignOut" && !home(from)) return null;
  if (action === "PasteTmdb" && from.screen === to.screen) return null;
  if (to.screen === "tmdbKey" && from.screen !== "tmdbKey" && !["Back", "TmdbStopsWorking", "MakeProfile", "ChooseProfile"].includes(action))
    return "it asks for a TMDB key again [the key stopped working]";
  return labels[action] ?? action;
};
