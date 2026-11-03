----------------------------- MODULE PartyInvites -----------------------------
(***************************************************************************)
(* Open Krida parties across accounts.                                     *)
(*                                                                         *)
(* A host (a profile of an account with TorBox) creates a room and shares  *)
(* its invite link. A profile of any account that opens the link joins;   *)
(* profiles of the host's own account join without it (rooms.live shows   *)
(* them the room). The host mints one-use guest links (inviteTemporary): a *)
(* guest has no account, joins only that room and expires after 24 h.     *)
(* Members leave, the host kicks, the host leaves, the party ends. When   *)
(* the host leaves, the room goes to a member whose account has TorBox,   *)
(* the host's own account first; with none, the party ends.               *)
(*                                                                         *)
(* Time is coarse: DayPasses(g) is the moment a guest's 24 h run out, and  *)
(* ExpireJob(g) is the scheduled expireTemporary that removes the guest    *)
(* afterwards. Today's 30 s close grace and 60 s reopen window are folded  *)
(* into CloseIfEmpty. "Earliest joined" in the hand-off is a free choice:  *)
(* the rules must hold whoever is picked.                                  *)
(*                                                                         *)
(* `Bug` seeds one known mistake; "none" is the design. The bugs named     *)
(* "today_*" are what convex/rooms.ts and convex/profiles.ts do now.        *)
(***************************************************************************)
EXTENDS FiniteSets, Naturals

CONSTANTS
  Accounts,     \* Clerk users
  PerAccount,   \* profiles per account in this model
  TorBox,       \* the accounts with a TorBox key (parties need it)
  Guests,       \* guest-link slots (temporary profiles)
  Rooms,
  NoOne,
  Bug

Profiles == Accounts \X (1..PerAccount)
Owner(p) == p[1]
People == Profiles \cup Guests

VARIABLES
  status,   \* status[r]: "none" (not created), "open", "ended"
  host,     \* host[r]: a profile, or NoOne before the room exists
  members,  \* members[r]: roomMembers rows not marked left (profiles and guests)
  link,     \* link[r]: the room's invite link: "none", "live", "revoked"
  hasLink,  \* hasLink[r]: profiles the link was sent to
  kicked,   \* kicked[r]: who the host kicked out
  allowed,  \* allowed[r]: profiles that were let in (link, host's account then, or back in): they may rejoin
  guest,    \* guest[g]: "none", "invited" (link minted), "joined", "gone" (profile removed)
  guestRoom,\* guestRoom[g]: the room guest g's link is for
  expired,  \* expired[g]: guest g's 24 h are over
  synced    \* synced[q]: q's screen shows the room's current title

vars == <<status, host, members, link, hasLink, kicked, allowed, guest, guestRoom, expired, synced>>

\* Who counts as in the room: every read (rooms.get, requireMember, the hand-off) leaves out expired guests.
Present(r) ==
  IF Bug = "today_lists_expired_guests" THEN members[r]
  ELSE {q \in members[r] : q \in Guests => ~expired[q]}

InNoRoom(q) == \A r \in Rooms : q \notin members[r]

TypeOK ==
  /\ status \in [Rooms -> {"none", "open", "ended"}]
  /\ host \in [Rooms -> Profiles \cup {NoOne}]
  /\ members \in [Rooms -> SUBSET People]
  /\ link \in [Rooms -> {"none", "live", "revoked"}]
  /\ hasLink \in [Rooms -> SUBSET Profiles]
  /\ kicked \in [Rooms -> SUBSET People]
  /\ allowed \in [Rooms -> SUBSET Profiles]
  /\ guest \in [Guests -> {"none", "invited", "joined", "gone"}]
  /\ guestRoom \in [Guests -> Rooms \cup {NoOne}]
  /\ expired \in [Guests -> BOOLEAN]
  /\ synced \in [People -> BOOLEAN]

Init ==
  /\ status = [r \in Rooms |-> "none"]
  /\ host = [r \in Rooms |-> NoOne]
  /\ members = [r \in Rooms |-> {}]
  /\ link = [r \in Rooms |-> "none"]
  /\ hasLink = [r \in Rooms |-> {}]
  /\ kicked = [r \in Rooms |-> {}]
  /\ allowed = [r \in Rooms |-> {}]
  /\ guest = [g \in Guests |-> "none"]
  /\ guestRoom = [g \in Guests |-> NoOne]
  /\ expired = [g \in Guests |-> FALSE]
  /\ synced = [q \in People |-> FALSE]

\* The party ends: everyone out, the link and unused guest links stop working.
EndRoom(r) ==
  /\ status' = [status EXCEPT ![r] = "ended"]
  /\ members' = [members EXCEPT ![r] = {}]
  /\ link' = [link EXCEPT ![r] = IF @ = "live" /\ Bug # "end_keeps_link" THEN "revoked" ELSE @]
  /\ guest' = [g \in Guests |->
                 IF guestRoom[g] = r /\ guest[g] = "invited" /\ Bug # "today_end_keeps_guest_links"
                 THEN "gone" ELSE guest[g]]

-----------------------------------------------------------------------------
(* Permanent profiles *)

CreateRoom(p, r) ==
  /\ status[r] = "none"
  /\ Bug = "party_without_torbox" \/ Owner(p) \in TorBox
  /\ InNoRoom(p)
  /\ status' = [status EXCEPT ![r] = "open"]
  /\ host' = [host EXCEPT ![r] = p]
  /\ members' = [members EXCEPT ![r] = {p}]
  /\ allowed' = [allowed EXCEPT ![r] = {p}]
  /\ synced' = [synced EXCEPT ![p] = TRUE]
  /\ UNCHANGED <<link, hasLink, kicked, guest, guestRoom, expired>>

\* Any member sends the room's link (made on first share) to a profile of any account.
ShareLink(r, q) ==
  /\ status[r] = "open"
  /\ Present(r) \cap Profiles # {}
  /\ q \notin hasLink[r]
  /\ link' = [link EXCEPT ![r] = "live"]
  /\ hasLink' = [hasLink EXCEPT ![r] = @ \cup {q}]
  /\ UNCHANGED <<status, host, members, kicked, allowed, guest, guestRoom, expired, synced>>

\* rooms.join (requireMayJoin): the link, the host's account, or having been let in before; never once kicked.
Admitted(p, r) ==
  \/ p \in hasLink[r] /\ link[r] = "live"
  \/ Owner(p) = Owner(host[r])
  \/ p \in allowed[r]

MayJoin(p, r) ==
  /\ Bug = "kick_not_enforced" \/ p \notin kicked[r]
  /\ Bug = "today_join_without_invite" \/ Admitted(p, r)

Join(p, r) ==
  /\ status[r] = "open"
  /\ InNoRoom(p)
  /\ MayJoin(p, r)
  /\ members' = [members EXCEPT ![r] = @ \cup {p}]
  /\ allowed' = [allowed EXCEPT ![r] = IF Admitted(p, r) THEN @ \cup {p} ELSE @]
  /\ synced' = [synced EXCEPT ![p] = FALSE]
  /\ UNCHANGED <<status, host, link, hasLink, kicked, guest, guestRoom, expired>>

\* Leaving on purpose, or the sweep counting someone out after 10 min away.
Leave(q, r) ==
  /\ q \in Present(r)
  /\ q # host[r]
  /\ members' = [members EXCEPT ![r] = @ \ {q}]
  /\ UNCHANGED <<status, host, link, hasLink, kicked, allowed, guest, guestRoom, expired, synced>>

(***************************************************************************)
(* The host leaves (or is swept out).                                      *)
(* Design: the room plays the host's TorBox stream, so it passes to a     *)
(* profile whose account has TorBox, one of the host's own account first; *)
(* with none left, the party ends for everyone.                           *)
(* Today (lib/rooms.ts passHost): the earliest-joined permanent profile of *)
(* any account; with only guests or nobody left, hostId stays on the      *)
(* profile that left and the room carries on.                             *)
(***************************************************************************)
HostLeaves(r) ==
  LET h == host[r]
      others == Present(r) \ {h}
      withTorBox == {q \in others \cap Profiles : Owner(q) \in TorBox}
      sameAcct == {q \in withTorBox : Owner(q) = Owner(h)}
      anyPerm == others \cap Profiles
  IN
  /\ status[r] = "open"
  /\ h \in Present(r)
  /\ UNCHANGED <<hasLink, kicked, allowed, guestRoom, expired, synced>>
  /\ IF withTorBox # {} THEN
       \E n \in (IF sameAcct # {} THEN sameAcct ELSE withTorBox) :
         /\ host' = [host EXCEPT ![r] = n]
         /\ members' = [members EXCEPT ![r] = @ \ {h}]
         /\ UNCHANGED <<status, link, guest>>
     ELSE IF Bug = "today_handoff_any_account" /\ anyPerm # {} THEN
       \E n \in anyPerm :
         /\ host' = [host EXCEPT ![r] = n]
         /\ members' = [members EXCEPT ![r] = @ \ {h}]
         /\ UNCHANGED <<status, link, guest>>
     ELSE IF Bug = "today_keep_absent_host" /\ anyPerm = {} THEN
       /\ members' = [members EXCEPT ![r] = @ \ {h}]
       /\ UNCHANGED <<status, host, link, guest>>
     ELSE
       /\ EndRoom(r)
       /\ UNCHANGED host

Kick(r, q) ==
  /\ status[r] = "open"
  /\ host[r] \in Present(r)
  /\ q \in members[r]
  /\ q # host[r]
  /\ members' = [members EXCEPT ![r] = @ \ {q}]
  /\ kicked' = [kicked EXCEPT ![r] = @ \cup {q}]
  /\ guest' = IF q \in Guests THEN [guest EXCEPT ![q] = "gone"] ELSE guest
  /\ UNCHANGED <<status, host, link, hasLink, allowed, guestRoom, expired, synced>>

\* The host presses End party, or nobody has watched for 30 min.
EndParty(r) ==
  /\ status[r] = "open"
  /\ EndRoom(r)
  /\ UNCHANGED <<host, hasLink, kicked, allowed, guestRoom, expired, synced>>

\* closeIfEmpty, after the grace period, with nobody back.
CloseIfEmpty(r) ==
  /\ status[r] = "open"
  /\ Present(r) = {}
  /\ EndRoom(r)
  /\ UNCHANGED <<host, hasLink, kicked, allowed, guestRoom, expired, synced>>

-----------------------------------------------------------------------------
(* Temporary guests *)

InviteGuest(r, g) ==
  /\ status[r] = "open"
  /\ host[r] \in Present(r)
  /\ guest[g] = "none"
  /\ guest' = [guest EXCEPT ![g] = "invited"]
  /\ guestRoom' = [guestRoom EXCEPT ![g] = r]
  /\ UNCHANGED <<status, host, members, link, hasLink, kicked, allowed, expired, synced>>

\* joinTemporary: first use of the link, or rooms.join again later (requireGuestRoom).
GuestJoins(g) ==
  LET r == guestRoom[g] IN
  /\ guest[g] \in {"invited", "joined"}
  /\ ~expired[g]
  /\ status[r] = "open"
  /\ g \notin members[r]
  /\ g \notin kicked[r]
  /\ guest' = [guest EXCEPT ![g] = "joined"]
  /\ members' = [members EXCEPT ![r] = @ \cup {g}]
  /\ synced' = [synced EXCEPT ![g] = FALSE]
  /\ UNCHANGED <<status, host, link, hasLink, kicked, allowed, guestRoom, expired>>

GuestLeaves(g) ==
  /\ guest[g] = "joined"
  /\ g \in Present(guestRoom[g])
  /\ members' = [members EXCEPT ![guestRoom[g]] = @ \ {g}]
  /\ UNCHANGED <<status, host, link, hasLink, kicked, allowed, guest, guestRoom, expired, synced>>

\* The guest's 24 h run out; profileFromToken refuses the token from now on.
DayPasses(g) ==
  /\ guest[g] \in {"invited", "joined"}
  /\ ~expired[g]
  /\ expired' = [expired EXCEPT ![g] = TRUE]
  /\ UNCHANGED <<status, host, members, link, hasLink, kicked, allowed, guest, guestRoom, synced>>

\* expireTemporary: removes the guest's profile, session and membership.
ExpireJob(g) ==
  /\ expired[g]
  /\ guest[g] \in {"invited", "joined"}
  /\ guest' = [guest EXCEPT ![g] = "gone"]
  /\ members' = [r \in Rooms |-> members[r] \ {g}]
  /\ UNCHANGED <<status, host, link, hasLink, kicked, allowed, guestRoom, expired, synced>>

-----------------------------------------------------------------------------
(* The room's title changes and each screen catches up *)

ChangeTitle(q, r) ==
  /\ status[r] = "open"
  /\ q \in Present(r)
  /\ synced' = [x \in People |-> IF x \in Present(r) /\ x # q THEN FALSE ELSE synced[x]]
  /\ UNCHANGED <<status, host, members, link, hasLink, kicked, allowed, guest, guestRoom, expired>>

\* Convex pushes the room to a member's live query.
Sync(q) ==
  /\ Bug # "guests_miss_updates" \/ q \in Profiles
  /\ \E r \in Rooms : q \in Present(r)
  /\ ~synced[q]
  /\ synced' = [synced EXCEPT ![q] = TRUE]
  /\ UNCHANGED <<status, host, members, link, hasLink, kicked, allowed, guest, guestRoom, expired>>

\* Every room ended and every guest link used up: nothing more happens.
Done ==
  /\ \A r \in Rooms : status[r] = "ended"
  /\ \A g \in Guests : guest[g] \in {"none", "gone"}
  /\ UNCHANGED vars

Next ==
  \/ \E p \in Profiles, r \in Rooms : CreateRoom(p, r) \/ Join(p, r) \/ ShareLink(r, p)
  \/ \E q \in People, r \in Rooms : Leave(q, r) \/ Kick(r, q) \/ ChangeTitle(q, r)
  \/ \E r \in Rooms : HostLeaves(r) \/ EndParty(r) \/ CloseIfEmpty(r)
  \/ \E r \in Rooms, g \in Guests : InviteGuest(r, g)
  \/ \E g \in Guests : GuestJoins(g) \/ GuestLeaves(g) \/ DayPasses(g) \/ ExpireJob(g)
  \/ \E q \in People : Sync(q)
  \/ Done

Spec == Init /\ [][Next]_vars /\ \A q \in People : WF_vars(Sync(q))

\* For PartyInvites.chart.cfg only: states that differ only in whose screen has caught up count as one.
ChartView == <<status, host, members, link, hasLink, kicked, allowed, guest, guestRoom, expired>>

-----------------------------------------------------------------------------
(* The rules *)

\* Only profiles let in by the link or as the host's account (then) are members; a guest only of its own room.
MembersInvitedOrSameAccount ==
  \A r \in Rooms : \A q \in members[r] :
    IF q \in Guests THEN guestRoom[q] = r
    ELSE q \in allowed[r]

\* An ended room has no members and no live invite.
EndedRoomIsEmpty ==
  \A r \in Rooms : status[r] = "ended" =>
    /\ members[r] = {}
    /\ link[r] # "live"
    /\ \A g \in Guests : guestRoom[g] = r => guest[g] # "invited"

\* A guest past expiry is not a member.
ExpiredGuestNotMember ==
  \A g \in Guests : expired[g] => \A r \in Rooms : g \notin Present(r)

\* At most one host (one hostId field), and while anyone is in an open room, that host is
\* there and is a permanent profile.
OneHostPresent ==
  \A r \in Rooms : status[r] = "open" /\ Present(r) # {} => host[r] \in Present(r) \cap Profiles

\* Someone the host kicked out stays out.
KickedStayOut == \A r \in Rooms : kicked[r] \cap members[r] = {}

\* An open room's host account has TorBox (the room plays the host's TorBox stream).
HostHasTorBox == \A r \in Rooms : status[r] = "open" => Owner(host[r]) \in TorBox

\* A joined member eventually sees the room's current title (or is no longer in the room).
SeesCurrentTitle ==
  \A q \in People, r \in Rooms :
    (q \in Present(r) /\ ~synced[q]) ~> (synced[q] \/ q \notin Present(r))

=============================================================================
