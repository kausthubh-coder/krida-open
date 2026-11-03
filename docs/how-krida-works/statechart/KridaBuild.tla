---- MODULE KridaBuild ----
\* A warm-up from resting on Play and the press of Play sharing one build:
\* sharedStream, claimBuild and releaseBuild in convex/engine.ts. BUILD_TTL_MS is the 3 minutes.
VARIABLES
  warm,     \* the warm-up: idle, claiming, building, gone
  play,     \* Play: idle, claiming, waiting, building, done, failed
  claim,    \* who holds the streamBuilds row: none, warm, play
  expired,  \* the row is more than 3 minutes old
  stream    \* a stream prepared under 3 hours ago exists

vars == <<warm, play, claim, expired, stream>>

Init == warm = "idle" /\ play = "idle" /\ claim = "none" /\ expired = FALSE /\ stream = FALSE

YouRestOnPlay == warm = "idle" /\ play = "idle" /\ warm' = "claiming" /\ UNCHANGED <<play, claim, expired, stream>>
YouPressPlay == play = "idle" /\ play' = "claiming" /\ UNCHANGED <<warm, claim, expired, stream>>

Free == claim = "none" \/ expired

WarmUpClaims ==
  /\ warm = "claiming"
  /\ IF ~stream /\ Free
       THEN warm' = "building" /\ claim' = "warm" /\ expired' = FALSE
       ELSE warm' = "gone" /\ UNCHANGED <<claim, expired>>
  /\ UNCHANGED <<play, stream>>

PlayClaims ==
  /\ play = "claiming"
  /\ IF stream THEN play' = "done" /\ UNCHANGED <<claim, expired>>
     ELSE IF Free THEN play' = "building" /\ claim' = "play" /\ expired' = FALSE
     ELSE play' = "waiting" /\ UNCHANGED <<claim, expired>>
  /\ UNCHANGED <<warm, stream>>

\* Every 500 ms a waiting Play asks claimBuild again.
PlayAsksAgain ==
  /\ play = "waiting" /\ (stream \/ Free)
  /\ play' = "claiming"
  /\ UNCHANGED <<warm, claim, expired, stream>>

\* releaseBuild deletes only the row this build holds.
Release(who) == IF claim = who THEN claim' = "none" /\ expired' = FALSE ELSE UNCHANGED <<claim, expired>>

WarmUpFinishes == warm = "building" /\ warm' = "gone" /\ stream' = TRUE /\ Release("warm") /\ UNCHANGED play
WarmUpFails == warm = "building" /\ warm' = "gone" /\ Release("warm") /\ UNCHANGED <<play, stream>>
PlayFinishes == play = "building" /\ play' = "done" /\ stream' = TRUE /\ Release("play") /\ UNCHANGED warm
PlayFails == play = "building" /\ play' = "failed" /\ Release("play") /\ UNCHANGED <<warm, stream>>

\* The action ends without its finally block, so the row stays until it expires.
WarmUpDies == warm = "building" /\ warm' = "gone" /\ UNCHANGED <<play, claim, expired, stream>>

\* The last copy tried has no time limit, so a build can run past BUILD_TTL_MS.
ThreeMinutesPass == claim # "none" /\ ~expired /\ expired' = TRUE /\ UNCHANGED <<warm, play, claim, stream>>

Done == play \in {"done", "failed"} /\ warm \in {"idle", "gone"} /\ UNCHANGED vars

Next ==
  \/ YouRestOnPlay \/ YouPressPlay \/ WarmUpClaims \/ PlayClaims \/ PlayAsksAgain
  \/ WarmUpFinishes \/ WarmUpFails \/ PlayFinishes \/ PlayFails \/ WarmUpDies \/ ThreeMinutesPass \/ Done

Spec == Init /\ [][Next]_vars /\ WF_vars(WarmUpClaims \/ PlayClaims \/ PlayAsksAgain \/ PlayFinishes \/ PlayFails \/ ThreeMinutesPass)

\* TorBox never gets Krida's pick for one title from two builds at once.
OneBuildAtATime == ~(warm = "building" /\ play = "building")
\* A press of Play never waits forever, even when the warm-up it waits on died.
PlayNeverWaitsForever == [](play = "waiting" => <>(play # "waiting"))
====
