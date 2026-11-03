export const title = "A room, from Play to picture";
const STEP = { finding: "Finding sources", adding: "Adding to TorBox", starting: "Starting stream" };
export const state = (v) => {
  if (v.status === "preparing") return v.worker[v.job] === "died" ? "Spinning, nothing behind it" : STEP[v.step];
  return {
    picking: "Picking", ready: "Watching", stalled: "The stream stopped loading",
    error: "This stream couldn't start", closed: "Room closed",
  }[v.status];
};
export const group = (v) => ({ picking: "start", preparing: "prep", ready: "good", stalled: "bad", error: "bad", closed: "end" }[v.status]);
export const colors = { start: "tan", prep: "blue", good: "teal", bad: "orange", end: "purple" };
const LABEL = {
  YouPressPlay: "you press Play", YouChooseASource: "you choose a source", YouPlaySomethingElse: "something else goes on",
  YouRefreshSources: "you press Refresh sources", YouGoBackToPicking: "you go back to picking",
  SourcesFound: "sources found", ACopyReachesTorBox: "a copy reaches TorBox", TorBoxStartsTheStream: "TorBox starts the stream",
  AStreamIsAlreadyPrepared: "a stream is already prepared", NoCopyWorks: "no copy works", TheJobDies: "the job dies without a word",
  TheVideoStopsLoading: "the video stops loading", YouReload: "you reload", EveryoneLeaves: "everyone leaves",
  TheOldJobFinishesLate: "an old job finishes late", TheOldJobFailsLate: "an old job fails late", Done: "the room stays closed",
};
const OUT_OF_THE_SPINNER = "Spinning, nothing behind it";
export const step = (action, from, to) => {
  const f = state(from);
  // These are open from every room state. The chart draws them where the reader decides: from Watching, and from an
  // error or a stuck spinner when they are the way out.
  if (action === "EveryoneLeaves" && f !== "Watching") return null;
  if (action === "YouPlaySomethingElse" && f !== "Watching") return null;
  if (action === "YouGoBackToPicking" && f !== "Watching" && f !== "This stream couldn't start") return null;
  if (action === "YouChooseASource" && !["Watching", OUT_OF_THE_SPINNER, "This stream couldn't start", "The stream stopped loading"].includes(f)) return null;
  if (action === "Report") return to.step === "adding" ? "sources found" : "a copy reaches TorBox";
  if (action === "Finish") return from.worker[from.job] === "starting" ? "TorBox starts the stream" : "a stream is already prepared";
  return LABEL[action];
};
