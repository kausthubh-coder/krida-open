---------------------------- MODULE StreamAccess ----------------------------
(*
 * Who may use a room's stream and its host's keys (convex/http.ts /hls/playlist.m3u8 with engine.mayPlay,
 * rooms.warm, rooms.shareLink, profiles.inviteTemporary and joinTemporary, lib/rooms.ts requireMember).
 *
 * A stream plays from the TorBox of the account that made it. Its playlist goes to a profile of that account, or to
 * someone in an open room playing it now: in, or counted out by the sweep (a phone asleep), but not one who pressed
 * Leave or was kicked. Warming a title for a room spends its host's keys, so only someone in the room may ask. A party
 * or guest link lets in other accounts, who can play only TorBox's stream, so only a host with TorBox makes one; and
 * nobody comes in through a link while the host has just left alone.
 *
 * Reads and warms are events: each records whether the rule at that moment allowed it (lastRead, lastWarm), so a kick
 * after a read doesn't make that read wrong. A host leaving mid-title hands the room on but leaves the current stream
 * on the departed host's TorBox until the next title (as the code does today: rebuilding mid-title would stop everyone's picture).
 *
 * Bug = "none" is the code. The others are what it did before 4 Nov 2026, each caught by check.sh:
 *   hls_token_only   the playlist checked only that the token was valid
 *   warm_any_room    rooms.warm took any room id and spent its host's keys
 *   left_keeps_access requireMember let someone who pressed Leave keep reading and acting
 *   guest_after_host_left  joinTemporary let a guest into a room whose host had just left alone
 *   link_without_torbox    shareLink and inviteTemporary made links for a host without TorBox
 *)
EXTENDS Naturals, FiniteSets, TLC

\* The cast, as model values: account A (h, k), account B (f, x), a guest g; h opens r1 and f opens r2; stream sA is
\* in A's TorBox and sB in B's. TorBox says which accounts have it (the cfg gives only B, so A's room can't take others).
CONSTANTS A, B, h, k, f, x, g, r1, r2, sA, sB, NoAccount, NoStream, TorBox, Bug

Accounts == {A, B}
Account == h :> A @@ k :> A @@ f :> B @@ x :> B @@ g :> NoAccount
Rooms == {r1, r2}
InitialHost == r1 :> h @@ r2 :> f
Streams == {sA, sB}
StreamOwner == sA :> A @@ sB :> B

Profiles == DOMAIN Account
Guests == {p \in Profiles : Account[p] = NoAccount}
States == {"out", "in", "swept", "left", "kicked"}

VARIABLES open, host, state, link, current, lastRead, lastWarm
vars == <<open, host, state, link, current, lastRead, lastWarm>>

Present(r, p) == state[r][p] \in {"in", "swept"}
\* What requireMember lets through (the bug: anyone who ever joined and wasn't kicked).
Member(r, p) ==
  IF Bug = "left_keeps_access" THEN state[r][p] \in {"in", "swept", "left"} ELSE Present(r, p)
HostAway(r) == state[r][host[r]] = "left"

\* The rule for a playlist (engine.mayPlay), and what the endpoint actually checks.
MayPlay(p, s) ==
  \/ Account[p] # NoAccount /\ Account[p] = StreamOwner[s]
  \/ \E r \in Rooms : open[r] /\ current[r] = s /\ Present(r, p)
Checked(p, s) ==
  IF Bug = "hls_token_only" THEN TRUE
  ELSE \/ Account[p] # NoAccount /\ Account[p] = StreamOwner[s]
       \/ \E r \in Rooms : open[r] /\ current[r] = s /\ Member(r, p)

TypeOK ==
  /\ open \in [Rooms -> BOOLEAN]
  /\ host \in [Rooms -> Profiles]
  /\ state \in [Rooms -> [Profiles -> States]]
  /\ link \in [Rooms -> BOOLEAN]
  /\ current \in [Rooms -> Streams \cup {NoStream}]
  /\ lastRead \in {TRUE, FALSE}
  /\ lastWarm \in {TRUE, FALSE}

Init ==
  /\ open = [r \in Rooms |-> TRUE]
  /\ host = InitialHost
  /\ state = [r \in Rooms |-> [p \in Profiles |-> IF p = InitialHost[r] THEN "in" ELSE "out"]]
  /\ link = [r \in Rooms |-> FALSE]
  /\ current = [r \in Rooms |-> NoStream]
  /\ lastRead = TRUE
  /\ lastWarm = TRUE

Set(r, p, s) == state' = [state EXCEPT ![r][p] = s]

\* The host starts a title: the stream is made in the host's account's TorBox.
Start(r, s) ==
  /\ open[r] /\ Present(r, host[r]) /\ StreamOwner[s] = Account[host[r]]
  /\ current' = [current EXCEPT ![r] = s]
  /\ UNCHANGED <<open, host, state, link, lastRead, lastWarm>>

\* A party or guest link (rooms.shareLink, profiles.inviteTemporary).
ShareLink(r) ==
  /\ open[r] /\ Present(r, host[r]) /\ ~link[r]
  /\ Bug = "link_without_torbox" \/ Account[host[r]] \in TorBox
  /\ link' = [link EXCEPT ![r] = TRUE]
  /\ UNCHANGED <<open, host, state, current, lastRead, lastWarm>>

\* rooms.join (an account's profile) and joinTemporary (a guest), refused while the host has just left alone.
Join(r, p) ==
  /\ open[r] /\ state[r][p] \in {"out", "left"}
  /\ \/ Account[p] # NoAccount /\ Account[p] = Account[host[r]]
     \/ link[r]
     \/ state[r][p] = "left"
  /\ IF Account[p] = NoAccount /\ Bug = "guest_after_host_left" THEN TRUE ELSE ~HostAway(r) \/ p = host[r]
  /\ Set(r, p, "in")
  /\ UNCHANGED <<open, host, link, current, lastRead, lastWarm>>

Sweep(r, p) == /\ state[r][p] = "in" /\ Set(r, p, "swept") /\ UNCHANGED <<open, host, link, current, lastRead, lastWarm>>
Heartbeat(r, p) == /\ open[r] /\ state[r][p] = "swept" /\ Set(r, p, "in") /\ UNCHANGED <<open, host, link, current, lastRead, lastWarm>>
Kick(r, p) ==
  /\ open[r] /\ p # host[r] /\ state[r][p] # "kicked" /\ Set(r, p, "kicked")
  /\ UNCHANGED <<open, host, link, current, lastRead, lastWarm>>

\* Leaving hands the room to someone present whose account has TorBox (lib/rooms.ts handOff); with only others left
\* who can't host, the party ends now; alone, it ends once the grace period runs out (Close). The stream stays on the
\* departed host's TorBox until the next Start.
EndNow(r) ==
  /\ open' = [open EXCEPT ![r] = FALSE]
  /\ state' = [state EXCEPT ![r] = [q \in Profiles |-> IF state[r][q] = "kicked" THEN "kicked" ELSE IF state[r][q] = "out" THEN "out" ELSE "left"]]

Leave(r, p) ==
  /\ open[r] /\ Present(r, p)
  /\ LET others == {q \in Profiles \ {p} : Present(r, q)}
         heirs == {q \in others : Account[q] \in TorBox} IN
       IF p = host[r] /\ heirs # {} THEN
         /\ \E q \in heirs : host' = [host EXCEPT ![r] = q]
         /\ Set(r, p, "left") /\ UNCHANGED open
       ELSE IF p = host[r] /\ others # {} THEN EndNow(r) /\ UNCHANGED host
       ELSE Set(r, p, "left") /\ UNCHANGED <<open, host>>
  /\ UNCHANGED <<link, current, lastRead, lastWarm>>

Close(r) ==
  /\ open[r] /\ \A q \in Profiles : ~Present(r, q)
  /\ EndNow(r)
  /\ UNCHANGED <<host, link, current, lastRead, lastWarm>>

\* Anyone signed in asks for a stream's playlist; it's served when the endpoint's check passes.
Read(p, s) ==
  /\ Checked(p, s)
  /\ lastRead' = MayPlay(p, s)
  /\ UNCHANGED <<open, host, state, link, current, lastWarm>>

\* Anyone signed in asks to warm a title for a room (rooms.warm).
Warm(r, p) ==
  /\ IF Bug = "warm_any_room" THEN TRUE ELSE open[r] /\ Member(r, p)
  /\ lastWarm' = (open[r] /\ Present(r, p))
  /\ UNCHANGED <<open, host, state, link, current, lastRead>>

Next ==
  \/ \E r \in Rooms, s \in Streams : Start(r, s)
  \/ \E r \in Rooms : ShareLink(r) \/ Close(r)
  \/ \E r \in Rooms, p \in Profiles : Join(r, p) \/ Sweep(r, p) \/ Heartbeat(r, p) \/ Kick(r, p) \/ Leave(r, p) \/ Warm(r, p)
  \/ \E p \in Profiles, s \in Streams : Read(p, s)

Spec == Init /\ [][Next]_vars

\* Every playlist served was one the rule allows: nobody outside the owner's account, the room, or after Leave or kick.
OnlyAllowedReads == lastRead
\* A room's host's keys are spent only for someone in that open room.
OnlyMembersWarm == lastWarm
\* Another account's profile or a guest is in a room only when its host's account has TorBox.
OthersNeedTorBox ==
  \A r \in Rooms, p \in Profiles :
    (Present(r, p) /\ Account[p] # Account[host[r]]) => Account[host[r]] \in TorBox
\* Nobody joins an open room through a link while its host has just left alone.
NoGuestWithoutHost ==
  \A r \in Rooms, q \in Guests : (open[r] /\ Present(r, q)) => ~HostAway(r)
=============================================================================
