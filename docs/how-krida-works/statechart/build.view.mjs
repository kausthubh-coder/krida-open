export const title = "A warm-up and a press of Play share one build";
export const state = (v) => {
  if (v.warm === "building" && v.play === "building") return "Two builds of one title";
  if (v.play === "done") return "Picture ready";
  if (v.play === "failed") return "Couldn't start";
  if (v.play === "waiting") return "Play waits on the warm-up";
  if (v.play === "building") return "Play builds";
  if (v.play === "claiming") return "Play pressed";
  if (v.warm === "claiming") return "Resting on Play";
  if (v.claim === "warm") return v.expired ? "The warm-up's claim is past 3 minutes" : "The warm-up holds the claim";
  return v.stream ? "Stream prepared, Play not pressed" : "Nothing started";
};
export const group = (v) => v.play === "done" ? "good" : v.play === "failed" ? "bad" : v.warm === "building" && v.play === "building" ? "bad" : "work";
export const colors = { good: "teal", bad: "orange", work: "blue" };
export const step = (action, from, to) => {
  if (action === "PlayClaims") {
    if (to.play === "done") return "Play finds a prepared stream";
    if (to.play === "waiting") return "Play finds a build running";
    return from.claim === "none" ? "Play takes the build" : "Play takes over the expired claim";
  }
  if (action === "WarmUpClaims" && to.warm === "building" && from.claim !== "none") return null;
  return LABEL[action];
};
const LABEL = {
  YouRestOnPlay: "you rest on Play", YouPressPlay: "you press Play",
  WarmUpClaims: "the warm-up starts",
  PlayAsksAgain: "the build is over, or its 3 minutes are up",
  WarmUpFinishes: "the warm-up finishes", WarmUpFails: "the warm-up fails", WarmUpDies: "the warm-up dies",
  PlayFinishes: "Play's build finishes", PlayFails: "Play's build fails", ThreeMinutesPass: "3 minutes pass", Done: null,
};
