---- MODULE KridaRoom ----
\* One room from Play to picture: convex/lib/rooms.ts (startJob), convex/engine.ts (prepare), convex/rooms.ts
\* (setStep, setReady, setError, stop, advance), src/features/player/Watch.tsx and Preparing.tsx.
\* Job numbers go round two slots, so a newer job and one older job can run at once.
EXTENDS Naturals

Jobs == {1, 2}
Other(t) == IF t = "A" THEN "B" ELSE "A"

VARIABLES
  status,   \* picking, preparing, ready, stalled, error, closed
  title,    \* what the room is on
  step,     \* the step the room shows: none, finding, adding, starting
  job,      \* the room's newest job (rooms.jobId)
  writer,   \* the job that last changed what the room shows
  shown,    \* the title of the stream the room points at
  worker,   \* each job's engine.prepare: off, finding, adding, starting, died, late (an older job still running)
  jobTitle  \* the title each running job was started for

vars == <<status, title, step, job, writer, shown, worker, jobTitle>>

Init ==
  /\ status = "picking" /\ title = "none" /\ step = "none" /\ job = 1 /\ writer = 1 /\ shown = "none"
  /\ worker = [j \in Jobs |-> "off"]
  /\ jobTitle = [j \in Jobs |-> "none"]

NextJob == 3 - job
\* rooms.setStep, setReady and setError: `if (room.jobId !== jobId) return`, and a closed room shows nothing new.
RoomTakes(j) == j = job /\ status # "closed"
Running == {"finding", "adding", "starting"}
\* The job being replaced keeps running as a late job; the one before it has gone from the model.
Older == IF worker[job] \in Running THEN "late" ELSE "off"

\* startJob: a new job number, and the room shows "Finding sources…".
StartJob(t) ==
  /\ job' = NextJob
  /\ worker' = [j \in Jobs |-> IF j = NextJob THEN "finding" ELSE Older]
  /\ jobTitle' = [j \in Jobs |-> IF j = NextJob THEN t ELSE IF Older = "late" THEN jobTitle[j] ELSE "none"]
  /\ status' = "preparing" /\ step' = "finding" /\ title' = t /\ writer' = NextJob /\ shown' = "none"

YouPressPlay == status = "picking" /\ StartJob("A")
YouPlaySomethingElse == status \in {"preparing", "ready", "stalled", "error"} /\ StartJob(Other(title))
YouChooseASource == status \in {"preparing", "ready", "stalled", "error"} /\ StartJob(title)
YouRefreshSources == status = "error" /\ StartJob(title)

\* rooms.stop: back to picking, with a new job number so that nothing running can write.
YouGoBackToPicking ==
  /\ status \in {"preparing", "ready", "stalled", "error"}
  /\ job' = NextJob /\ status' = "picking" /\ title' = "none" /\ step' = "none" /\ writer' = NextJob /\ shown' = "none"
  /\ worker' = [j \in Jobs |-> IF j = NextJob THEN "off" ELSE Older]
  /\ jobTitle' = [j \in Jobs |-> IF j = NextJob \/ Older = "off" THEN "none" ELSE jobTitle[j]]

\* setStep: a step is written only by the room's newest job.
Report(from, to) ==
  /\ worker[job] = from
  /\ worker' = [worker EXCEPT ![job] = to] /\ step' = to /\ writer' = job
  /\ UNCHANGED <<status, title, job, shown, jobTitle>>

SourcesFound == Report("finding", "adding")
ACopyReachesTorBox == Report("adding", "starting")

\* setReady: the newest job's stream goes on the room.
Finish(from) ==
  /\ worker[job] = from
  /\ worker' = [worker EXCEPT ![job] = "off"]
  /\ jobTitle' = [jobTitle EXCEPT ![job] = "none"]
  /\ status' = "ready" /\ step' = "none" /\ shown' = jobTitle[job] /\ writer' = job
  /\ UNCHANGED <<title, job>>

TorBoxStartsTheStream == Finish("starting")
AStreamIsAlreadyPrepared == Finish("finding")

\* setError: the newest job's failure shows.
NoCopyWorks ==
  /\ worker[job] \in Running
  /\ worker' = [worker EXCEPT ![job] = "off"]
  /\ jobTitle' = [jobTitle EXCEPT ![job] = "none"]
  /\ status' = "error" /\ step' = "none" /\ writer' = job
  /\ UNCHANGED <<title, job, shown>>

\* An older job's setStep, setReady or setError carries the old job number. The room checks it, as setReady does.
\* Either way the older job is over: a refused setStep throws Superseded.
TheOldJobFinishesLate ==
  \E j \in Jobs :
    /\ worker[j] = "late"
    /\ worker' = [worker EXCEPT ![j] = "off"]
    /\ jobTitle' = [jobTitle EXCEPT ![j] = "none"]
    /\ IF RoomTakes(j)
         THEN status' = "ready" /\ step' = "none" /\ shown' = jobTitle[j] /\ writer' = j /\ UNCHANGED <<title, job>>
         ELSE UNCHANGED <<status, step, shown, writer, title, job>>

TheOldJobFailsLate ==
  \E j \in Jobs :
    /\ worker[j] = "late"
    /\ worker' = [worker EXCEPT ![j] = "off"]
    /\ jobTitle' = [jobTitle EXCEPT ![j] = "none"]
    /\ IF RoomTakes(j)
         THEN status' = "error" /\ step' = "none" /\ writer' = j /\ UNCHANGED <<shown, title, job>>
         ELSE UNCHANGED <<status, step, shown, writer, title, job>>

\* The action ends with no write at all: a crash, a deploy, or Convex's 10-minute limit.
TheJobDies ==
  /\ worker[job] \in Running
  /\ worker' = [worker EXCEPT ![job] = "died"]
  /\ UNCHANGED <<status, title, step, job, writer, shown, jobTitle>>

TheVideoStopsLoading == status = "ready" /\ status' = "stalled" /\ UNCHANGED <<title, step, job, writer, shown, worker, jobTitle>>
YouReload == status = "stalled" /\ status' = "ready" /\ UNCHANGED <<title, step, job, writer, shown, worker, jobTitle>>
\* closeRoom: what is still running can no longer change what anyone sees, so the model drops it.
EveryoneLeaves ==
  /\ status # "closed" /\ status' = "closed"
  /\ worker' = [j \in Jobs |-> "off"]
  /\ UNCHANGED <<title, step, job, writer, shown, jobTitle>>
Done == status = "closed" /\ UNCHANGED vars

Next ==
  \/ YouPressPlay \/ YouPlaySomethingElse \/ YouChooseASource \/ YouRefreshSources \/ YouGoBackToPicking
  \/ SourcesFound \/ ACopyReachesTorBox \/ TorBoxStartsTheStream \/ AStreamIsAlreadyPrepared \/ NoCopyWorks
  \/ TheOldJobFinishesLate \/ TheOldJobFailsLate \/ TheJobDies \/ TheVideoStopsLoading \/ YouReload \/ EveryoneLeaves \/ Done

\* What the room shows comes from its newest job, whatever an older job does late.
NewestJobOwnsTheScreen == status \in {"preparing", "ready", "stalled", "error"} => writer = job
\* The picture is always the title the room is on.
PictureIsTheRoomsTitle == status \in {"ready", "stalled"} => shown = title
\* A room that says it is preparing has a job working on it.
ASpinnerHasAJobBehindIt == status = "preparing" => worker[job] # "died"
====
