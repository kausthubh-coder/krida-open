--------------------------- MODULE AccountIsolation ---------------------------
(***************************************************************************)
(* Open Krida: accounts, profiles, profile sessions, per-account keys and  *)
(* rooms, as the spec (.agents/plans/open-krida-spec.md) asks for them.    *)
(*                                                                         *)
(* An account is one Clerk sign-in. A device signs in to an account, then  *)
(* picks a profile of that account (PIN checked) and gets a profile        *)
(* session: the `sessions` row and token `requireProfile` reads today.     *)
(* Every Convex query is a pure function of the stored state (Convex       *)
(* re-runs it on every change), so each listing below is an operator and   *)
(* the invariants check it in every reachable state.                       *)
(*                                                                         *)
(* `Bug` seeds one known mistake; "none" is the design. The bugs named     *)
(* "today_*" are what convex/ does right now (see README.md).              *)
(***************************************************************************)
EXTENDS FiniteSets, Naturals

CONSTANTS
  Accounts,     \* Clerk users
  Devices,      \* browsers or apps; each holds at most one profile session
  Profiles,     \* profile slots; a slot is made once and may be deleted
  Rooms,        \* room slots; a room is created once and ends once
  MaxProfiles,  \* profiles per account (8 in the product, small here)
  NoOne,        \* "nobody": no account on a device, no host yet
  Bug           \* "none" or the name of one seeded bug

VARIABLES
  clerk,     \* clerk[d]: the account signed in on device d, or NoOne
  owner,     \* owner[p]: "free" (not made), the account that made it, or "deleted"
  pin,       \* pin[p]: the profile has a PIN
  sessions,  \* profile sessions: [dev, prof, acct, enteredPin]
  host,      \* host[r]: the profile that created room r, or NoOne before it exists
  open,      \* open[r]: room r is going on
  members,   \* members[r]: profiles in room r now
  invited    \* invited[r]: profiles that opened room r's invite link

vars == <<clerk, owner, pin, sessions, host, open, members, invited>>

Made == {p \in Profiles : owner[p] \in Accounts}
ProfilesOf(a) == {p \in Profiles : owner[p] = a}
SessionOf(d) == {s \in sessions : s.dev = d}
HasSession(d) == SessionOf(d) # {}
Me(d) == (CHOOSE s \in SessionOf(d) : TRUE).prof
MyAcct(d) == (CHOOSE s \in SessionOf(d) : TRUE).acct
AcctOfHost(r) == IF host[r] = NoOne THEN NoOne ELSE owner[host[r]]

Session(d, p, a, entered) == [dev |-> d, prof |-> p, acct |-> a, enteredPin |-> entered]

TypeOK ==
  /\ clerk \in [Devices -> Accounts \cup {NoOne}]
  /\ owner \in [Profiles -> Accounts \cup {"free", "deleted"}]
  /\ pin \in [Profiles -> BOOLEAN]
  /\ sessions \subseteq [dev : Devices, prof : Profiles, acct : Accounts, enteredPin : BOOLEAN]
  /\ \A d \in Devices : Cardinality(SessionOf(d)) <= 1
  /\ host \in [Rooms -> Profiles \cup {NoOne}]
  /\ open \in [Rooms -> BOOLEAN]
  /\ members \in [Rooms -> SUBSET Profiles]
  /\ invited \in [Rooms -> SUBSET Profiles]

Init ==
  /\ clerk = [d \in Devices |-> NoOne]
  /\ owner = [p \in Profiles |-> "free"]
  /\ pin = [p \in Profiles |-> FALSE]
  /\ sessions = {}
  /\ host = [r \in Rooms |-> NoOne]
  /\ open = [r \in Rooms |-> FALSE]
  /\ members = [r \in Rooms |-> {}]
  /\ invited = [r \in Rooms |-> {}]

-----------------------------------------------------------------------------
(* Account sign-in (Clerk) *)

SignIn(d, a) ==
  /\ clerk[d] = NoOne
  /\ clerk' = [clerk EXCEPT ![d] = a]
  /\ UNCHANGED <<owner, pin, sessions, host, open, members, invited>>

\* Signing out of the account ends the profile sessions it minted on this device.
SignOut(d) ==
  /\ clerk[d] # NoOne
  /\ clerk' = [clerk EXCEPT ![d] = NoOne]
  /\ sessions' = IF Bug = "signout_keeps_sessions" THEN sessions
                 ELSE {s \in sessions : s.dev # d}
  /\ UNCHANGED <<owner, pin, host, open, members, invited>>

-----------------------------------------------------------------------------
(* Profiles *)

MakeProfile(d, p) ==
  /\ clerk[d] # NoOne
  /\ owner[p] = "free"
  /\ Cardinality(ProfilesOf(clerk[d])) < MaxProfiles
  /\ owner' = [owner EXCEPT ![p] = clerk[d]]
  /\ UNCHANGED <<clerk, pin, sessions, host, open, members, invited>>

\* The picker: Clerk-authenticated, the profile is the account's, the PIN matches.
ChooseProfile(d, p, rightPin) ==
  /\ clerk[d] # NoOne
  /\ IF Bug = "today_choose_any_profile" THEN owner[p] \in Accounts
     ELSE owner[p] = clerk[d]
  /\ IF Bug = "skip_pin" THEN TRUE ELSE (pin[p] => rightPin)
  /\ sessions' = {s \in sessions : s.dev # d}
                 \cup {Session(d, p, clerk[d], pin[p] /\ rightPin)}
  /\ UNCHANGED <<clerk, owner, pin, host, open, members, invited>>

\* Setting a PIN ends the profile's other sessions, as changePassword does today.
SetPin(d) ==
  /\ HasSession(d)
  /\ ~pin[Me(d)]
  /\ pin' = [pin EXCEPT ![Me(d)] = TRUE]
  /\ sessions' = LET mine == CHOOSE s \in SessionOf(d) : TRUE IN
       IF Bug = "pin_keeps_sessions"
       THEN (sessions \ {mine}) \cup {[mine EXCEPT !.enteredPin = TRUE]}
       ELSE {s \in sessions : s.prof # Me(d)} \cup {[mine EXCEPT !.enteredPin = TRUE]}
  /\ UNCHANGED <<clerk, owner, host, open, members, invited>>

RemovePin(d) ==
  /\ HasSession(d)
  /\ pin[Me(d)]
  /\ pin' = [pin EXCEPT ![Me(d)] = FALSE]
  /\ UNCHANGED <<clerk, owner, sessions, host, open, members, invited>>

\* Deleting a profile ends its sessions and room memberships, and ends the rooms it hosts.
DeleteProfile(d, p) ==
  /\ clerk[d] # NoOne
  /\ owner[p] = clerk[d]
  /\ owner' = [owner EXCEPT ![p] = "deleted"]
  /\ pin' = [pin EXCEPT ![p] = FALSE]
  /\ sessions' = IF Bug = "delete_keeps_sessions" THEN sessions
                 ELSE {s \in sessions : s.prof # p}
  /\ LET ends == {r \in Rooms : open[r] /\ host[r] = p} IN
       IF Bug = "today_delete_keeps_rooms"
       THEN UNCHANGED <<open, members, invited>>
       ELSE /\ open' = [r \in Rooms |-> IF r \in ends THEN FALSE ELSE open[r]]
            /\ members' = [r \in Rooms |-> IF r \in ends THEN {} ELSE members[r] \ {p}]
            /\ invited' = [r \in Rooms |-> invited[r] \ {p}]
  /\ UNCHANGED <<clerk, host>>

-----------------------------------------------------------------------------
(* Rooms. PartyInvites.tla models hand-off, guests and kicks; here a room *)
(* only needs to exist, take members and end.                              *)

CreateRoom(d, r) ==
  /\ HasSession(d)
  /\ host[r] = NoOne
  /\ host' = [host EXCEPT ![r] = Me(d)]
  /\ open' = [open EXCEPT ![r] = TRUE]
  /\ members' = [members EXCEPT ![r] = {Me(d)}]
  /\ UNCHANGED <<clerk, owner, pin, sessions, invited>>

\* A member sends the invite link to any profile of any account.
ShareLink(d, r, q) ==
  /\ HasSession(d)
  /\ open[r]
  /\ Me(d) \in members[r]
  /\ q \in Made
  /\ q \notin invited[r]
  /\ invited' = [invited EXCEPT ![r] = @ \cup {q}]
  /\ UNCHANGED <<clerk, owner, pin, sessions, host, open, members>>

MayJoin(p, r) ==
  IF Bug = "today_join_without_invite" THEN TRUE
  ELSE p \in invited[r] \/ owner[p] = AcctOfHost(r)

Join(d, r) ==
  /\ HasSession(d)
  /\ open[r]
  /\ Me(d) \notin members[r]
  /\ MayJoin(Me(d), r)
  /\ members' = [members EXCEPT ![r] = @ \cup {Me(d)}]
  /\ UNCHANGED <<clerk, owner, pin, sessions, host, open, invited>>

Leave(d, r) ==
  /\ HasSession(d)
  /\ Me(d) \in members[r]
  /\ IF Me(d) = host[r]
     THEN /\ open' = [open EXCEPT ![r] = FALSE]
          /\ members' = [members EXCEPT ![r] = {}]
     ELSE /\ members' = [members EXCEPT ![r] = @ \ {Me(d)}]
          /\ UNCHANGED open
  /\ UNCHANGED <<clerk, owner, pin, sessions, host, invited>>

-----------------------------------------------------------------------------
(* What the queries return (Convex re-runs them on every change) *)

\* The picker (by Clerk identity) and "who's watching" (by profile session).
ProfilesListed(d) ==
  IF Bug = "today_list_all_profiles" THEN Made
  ELSE (IF clerk[d] = NoOne THEN {} ELSE ProfilesOf(clerk[d]))
       \cup (IF HasSession(d) THEN ProfilesOf(MyAcct(d)) ELSE {})

\* Account settings, "Connections": whose keys a device can read.
KeysReadable(d) ==
  (IF clerk[d] = NoOne THEN {} ELSE {clerk[d]})
  \cup (IF ~HasSession(d) THEN {}
        ELSE IF Bug = "keys_by_argument" THEN Accounts ELSE {MyAcct(d)})

\* rooms.live: open rooms hosted in my account or that I was invited to (and the ones I'm in).
RoomsListed(d) ==
  IF ~HasSession(d) THEN {}
  ELSE {r \in Rooms : open[r] /\
          (Bug = "today_live_lists_all_rooms"
           \/ AcctOfHost(r) = owner[Me(d)] \/ Me(d) \in invited[r] \/ Me(d) \in members[r])}

\* Members shown next to each listed room (rooms.live): all of them for a room I'm in, otherwise
\* only my account's. And a room's own page (rooms.get, messages.list): only for its members.
MembersShown(d) ==
  IF ~HasSession(d) THEN {}
  ELSE UNION {IF Me(d) \in members[r] \/ Bug = "live_shows_all_members"
              THEN members[r]
              ELSE members[r] \cap ProfilesOf(owner[Me(d)]) : r \in RoomsListed(d)}
       \cup (IF Bug = "today_get_any_room" THEN UNION {members[r] : r \in Rooms} ELSE {})

-----------------------------------------------------------------------------
(* The rules *)

\* A session never belongs to a profile of another account.
SessionInOwnAccount == \A s \in sessions : owner[s.prof] = s.acct

\* Signing out of the account ends its profile sessions.
SignOutEndsSessions == \A s \in sessions : clerk[s.dev] = s.acct

\* A profile with a PIN has no session that didn't enter it (setting it counts as entering it).
PinRespected == \A s \in sessions : pin[s.prof] => s.enteredPin

\* No profile reads another account's keys.
KeysIsolated ==
  \A d \in Devices :
    /\ KeysReadable(d) \subseteq {clerk[d]}
    /\ HasSession(d) => KeysReadable(d) \subseteq {owner[Me(d)]}

\* Listing profiles never shows another account's.
ProfileListIsolated ==
  \A d \in Devices : \A q \in ProfilesListed(d) : owner[q] = clerk[d]

\* Listing rooms never shows another account's, unless you were invited or are in it.
RoomListIsolated ==
  \A d \in Devices : \A r \in RoomsListed(d) :
    AcctOfHost(r) = owner[Me(d)] \/ Me(d) \in invited[r] \/ Me(d) \in members[r]

\* Another account's profile shows only as a member of a room you're in.
MemberListIsolated ==
  \A d \in Devices : \A q \in MembersShown(d) :
    owner[q] = owner[Me(d)] \/ \E r \in Rooms : Me(d) \in members[r] /\ q \in members[r]

\* Only invited or same-account profiles are members.
MembersInvitedOrSameAccount ==
  \A r \in Rooms : \A q \in members[r] : q \in invited[r] \/ owner[q] = AcctOfHost(r)

\* Deleting a profile ends its sessions and room memberships, and the rooms it hosts.
DeletedLeavesNothing ==
  \A p \in Profiles : owner[p] = "deleted" =>
    /\ \A s \in sessions : s.prof # p
    /\ \A r \in Rooms : p \notin members[r] /\ (open[r] => host[r] # p)

-----------------------------------------------------------------------------

\* Every slot used and nothing left to do but sign in and out: the end of a run.
Next ==
  \/ \E d \in Devices, a \in Accounts : SignIn(d, a)
  \/ \E d \in Devices : SignOut(d)
  \/ \E d \in Devices, p \in Profiles : MakeProfile(d, p)
  \/ \E d \in Devices, p \in Profiles, ok \in BOOLEAN : ChooseProfile(d, p, ok)
  \/ \E d \in Devices : SetPin(d) \/ RemovePin(d)
  \/ \E d \in Devices, p \in Profiles : DeleteProfile(d, p)
  \/ \E d \in Devices, r \in Rooms : CreateRoom(d, r) \/ Join(d, r) \/ Leave(d, r)
  \/ \E d \in Devices, r \in Rooms, q \in Profiles : ShareLink(d, r, q)

Spec == Init /\ [][Next]_vars

=============================================================================
