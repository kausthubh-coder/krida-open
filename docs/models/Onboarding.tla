------------------------------ MODULE Onboarding ------------------------------
(***************************************************************************)
(* Open Krida onboarding for one account on one device.                    *)
(*                                                                         *)
(* Signed out -> signed in with no profile -> profile made -> TMDB key      *)
(* (required, checked when pasted) -> debrid (TorBox, another service, or  *)
(* skip) -> addons (install or skip) -> Home. A person can go back a step, *)
(* switch profiles, change keys in Settings, and a stored key can stop     *)
(* working later (the provider refuses it on the next call). Keys are per *)
(* account; addons are per profile, so a second profile still sees the    *)
(* addons step.                                                            *)
(*                                                                         *)
(* `Bug` seeds one known mistake; "none" is the design.                    *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  MaxProfiles,  \* profiles in this model (8 in the product)
  Bug

VARIABLES
  signedIn,     \* Clerk session on this device
  profiles,     \* how many profiles the account has
  current,      \* the profile in use, 0 for none
  tmdb,         \* the account's TMDB key: "none", "valid", "invalid" (stopped working)
  debrid,       \* "none", "torbox", "other"
  debridValid,  \* the debrid key works
  debridAsked,  \* the account went through the debrid step (chose or skipped)
  addons,       \* addons[i]: "todo", "installed", "skipped" for profile i
  screen,       \* what the person sees
  playUI,       \* Home's Play (playing alone): "available" or "unavailable"
  partyUI,      \* Home's Watch together: "available" or "unavailable"
  outcome       \* what the last press on Home did: "none", "playing", "party", "told", "failed"

vars == <<signedIn, profiles, current, tmdb, debrid, debridValid, debridAsked, addons,
          screen, playUI, partyUI, outcome>>

Screens == {"landing", "picker", "newProfile", "tmdbKey", "debrid", "addons", "home", "settings"}
Ids == 1..MaxProfiles

TorBoxOK(d, ok) == d = "torbox" /\ ok
\* Playing alone needs any working debrid service: TorBox's files play everywhere; another service's play in the
\* browser when they're MP4 or WebM, and in the desktop app or an external player otherwise. Never a failed press.
PlayOK(d, ok) == d \in {"torbox", "other"} /\ ok
Gate(open) == IF open THEN "available" ELSE "unavailable"

\* Home's gates follow the account's debrid state in the same step (a live query): Play on any working service,
\* Watch together on TorBox (everyone watches the host's TorBox stream).
SetGates(d, ok) ==
  IF Bug = "torbox_hidden_always"
  THEN playUI' = "unavailable" /\ partyUI' = "unavailable"
  ELSE /\ playUI' = Gate(IF Bug = "play_needs_torbox" THEN TorBoxOK(d, ok) ELSE PlayOK(d, ok))
       /\ partyUI' = Gate(TorBoxOK(d, ok))

\* Where the app sends a signed-in profile: the first step it still needs, else Home.
Route(t, asked, ad) ==
  IF t # "valid" /\ Bug # "route_ignores_tmdb" THEN "tmdbKey"
  ELSE IF ~asked THEN "debrid"
  ELSE IF ad = "todo" THEN "addons"
  ELSE "home"

TypeOK ==
  /\ signedIn \in BOOLEAN
  /\ profiles \in 0..MaxProfiles
  /\ current \in 0..MaxProfiles
  /\ tmdb \in {"none", "valid", "invalid"}
  /\ debrid \in {"none", "torbox", "other"}
  /\ debridValid \in BOOLEAN
  /\ debridAsked \in BOOLEAN
  /\ addons \in [Ids -> {"todo", "installed", "skipped"}]
  /\ screen \in Screens
  /\ playUI \in {"available", "unavailable"}
  /\ partyUI \in {"available", "unavailable"}
  /\ outcome \in {"none", "playing", "party", "told", "failed"}

Init ==
  /\ signedIn = FALSE
  /\ profiles = 0
  /\ current = 0
  /\ tmdb = "none"
  /\ debrid = "none"
  /\ debridValid = FALSE
  /\ debridAsked = FALSE
  /\ addons = [i \in Ids |-> "todo"]
  /\ screen = "landing"
  /\ playUI = "unavailable"
  /\ partyUI = "unavailable"
  /\ outcome = "none"

Keys == <<tmdb, debrid, debridValid, debridAsked>>

-----------------------------------------------------------------------------
(* Signing in and profiles *)

SignIn ==
  /\ ~signedIn
  /\ signedIn' = TRUE
  /\ screen' = IF profiles = 0 THEN "newProfile" ELSE "picker"
  /\ UNCHANGED <<profiles, current, addons, playUI, partyUI, outcome>> /\ UNCHANGED Keys

SignOut ==
  /\ signedIn
  /\ signedIn' = FALSE
  /\ current' = 0
  /\ screen' = IF Bug = "signout_keeps_screen" THEN screen ELSE "landing"
  /\ outcome' = "none"
  /\ UNCHANGED <<profiles, addons, playUI, partyUI>> /\ UNCHANGED Keys

AddProfile ==
  /\ screen = "picker"
  /\ profiles < MaxProfiles
  /\ screen' = "newProfile"
  /\ UNCHANGED <<signedIn, profiles, current, addons, playUI, partyUI, outcome>> /\ UNCHANGED Keys

MakeProfile ==
  /\ screen = "newProfile"
  /\ profiles < MaxProfiles
  /\ profiles' = profiles + 1
  /\ current' = profiles + 1
  /\ screen' = Route(tmdb, debridAsked, addons[profiles + 1])
  /\ UNCHANGED <<signedIn, addons, playUI, partyUI, outcome>> /\ UNCHANGED Keys

ChooseProfile(i) ==
  /\ screen = "picker"
  /\ i <= profiles
  /\ current' = i
  /\ screen' = Route(tmdb, debridAsked, addons[i])
  /\ UNCHANGED <<signedIn, profiles, addons, playUI, partyUI, outcome>> /\ UNCHANGED Keys

SwitchProfile ==
  /\ screen = "home"
  /\ current' = 0
  /\ screen' = "picker"
  /\ outcome' = "none"
  /\ UNCHANGED <<signedIn, profiles, addons, playUI, partyUI>> /\ UNCHANGED Keys

-----------------------------------------------------------------------------
(* Keys: in onboarding and in Settings. A pasted key is checked first. *)

PasteTmdb(ok) ==
  /\ screen \in {"tmdbKey", "settings"}
  /\ IF ok
     THEN /\ tmdb' = "valid"
          /\ screen' = IF screen = "settings" THEN "settings" ELSE "debrid"
     ELSE UNCHANGED <<tmdb, screen>>   \* refused: the step says why and stays
  /\ UNCHANGED <<signedIn, profiles, current, debrid, debridValid, debridAsked, addons,
                 playUI, partyUI, outcome>>

\* The TMDB step with a key that already works: Continue.
KeepTmdb ==
  /\ screen = "tmdbKey"
  /\ tmdb = "valid"
  /\ screen' = "debrid"
  /\ UNCHANGED <<signedIn, profiles, current, addons, playUI, partyUI, outcome>> /\ UNCHANGED Keys

ChooseDebrid(d, ok) ==
  /\ screen \in {"debrid", "settings"}
  /\ IF ok
     THEN /\ debrid' = d
          /\ debridValid' = TRUE
          /\ debridAsked' = TRUE
          /\ IF Bug = "stale_torbox_gate" /\ screen = "settings"
             THEN UNCHANGED <<playUI, partyUI>> ELSE SetGates(d, TRUE)
          /\ screen' = IF screen = "settings" THEN "settings"
                       ELSE Route(tmdb, TRUE, addons[current])
     ELSE UNCHANGED <<debrid, debridValid, debridAsked, playUI, partyUI, screen>>
  /\ UNCHANGED <<signedIn, profiles, current, tmdb, addons, outcome>>

SkipDebrid ==
  /\ screen = "debrid"
  /\ debridAsked' = TRUE
  /\ SetGates(debrid, debridValid)
  /\ screen' = Route(tmdb, TRUE, addons[current])
  /\ UNCHANGED <<signedIn, profiles, current, tmdb, debrid, debridValid, addons, outcome>>

RemoveDebrid ==
  /\ screen = "settings"
  /\ debrid # "none"
  /\ debrid' = "none"
  /\ debridValid' = FALSE
  /\ IF Bug = "stale_torbox_gate" THEN UNCHANGED <<playUI, partyUI>> ELSE SetGates("none", FALSE)
  /\ UNCHANGED <<signedIn, profiles, current, tmdb, debridAsked, addons, screen, outcome>>

InstallAddons ==
  /\ screen = "addons"
  /\ addons' = [addons EXCEPT ![current] = "installed"]
  /\ screen' = Route(tmdb, debridAsked, "installed")
  /\ UNCHANGED <<signedIn, profiles, current, playUI, partyUI, outcome>> /\ UNCHANGED Keys

SkipAddons ==
  /\ screen = "addons"
  /\ addons' = [addons EXCEPT ![current] = "skipped"]
  /\ screen' = Route(tmdb, debridAsked, "skipped")
  /\ UNCHANGED <<signedIn, profiles, current, playUI, partyUI, outcome>> /\ UNCHANGED Keys

Back ==
  /\ screen \in {"debrid", "addons"}
  /\ screen' = IF screen = "debrid" THEN "tmdbKey" ELSE "debrid"
  /\ UNCHANGED <<signedIn, profiles, current, addons, playUI, partyUI, outcome>> /\ UNCHANGED Keys

OpenSettings ==
  /\ screen = "home"
  /\ screen' = "settings"
  /\ outcome' = "none"
  /\ UNCHANGED <<signedIn, profiles, current, addons, playUI, partyUI>> /\ UNCHANGED Keys

CloseSettings ==
  /\ screen = "settings"
  /\ screen' = Route(tmdb, debridAsked, addons[current])
  /\ UNCHANGED <<signedIn, profiles, current, addons, playUI, partyUI, outcome>> /\ UNCHANGED Keys

-----------------------------------------------------------------------------
(* Keys stop working later: the provider refuses the next call. *)

TmdbStopsWorking ==
  /\ tmdb = "valid"
  /\ tmdb' = "invalid"
  /\ screen' = IF screen = "home" /\ Bug # "home_ignores_dead_key" THEN "tmdbKey" ELSE screen
  /\ outcome' = IF screen' # screen THEN "none" ELSE outcome
  /\ UNCHANGED <<signedIn, profiles, current, debrid, debridValid, debridAsked, addons, playUI, partyUI>>

DebridStopsWorking ==
  /\ debrid # "none"
  /\ debridValid
  /\ debridValid' = FALSE
  /\ IF Bug = "stale_torbox_gate" THEN UNCHANGED <<playUI, partyUI>> ELSE SetGates(debrid, FALSE)
  /\ UNCHANGED <<signedIn, profiles, current, tmdb, debrid, debridAsked, addons, screen, outcome>>

-----------------------------------------------------------------------------
(* Pressing Play or Watch together on Home. "playing" includes a file the browser can't play: the room offers the
   desktop app and external players for it instead of failing. *)

PressPlay ==
  /\ screen = "home"
  /\ outcome' = IF playUI = "unavailable" /\ Bug # "play_ignores_gate" THEN "told"
                ELSE IF PlayOK(debrid, debridValid) THEN "playing" ELSE "failed"
  /\ UNCHANGED <<signedIn, profiles, current, addons, screen, playUI, partyUI>> /\ UNCHANGED Keys

PressParty ==
  /\ screen = "home"
  /\ outcome' = IF partyUI = "unavailable" THEN "told"
                ELSE IF TorBoxOK(debrid, debridValid) THEN "party" ELSE "failed"
  /\ UNCHANGED <<signedIn, profiles, current, addons, screen, playUI, partyUI>> /\ UNCHANGED Keys

Next ==
  \/ SignIn \/ SignOut \/ AddProfile \/ MakeProfile \/ SwitchProfile
  \/ \E i \in Ids : ChooseProfile(i)
  \/ \E ok \in BOOLEAN : PasteTmdb(ok)
  \/ KeepTmdb
  \/ \E d \in {"torbox", "other"}, ok \in BOOLEAN : ChooseDebrid(d, ok)
  \/ SkipDebrid \/ RemoveDebrid \/ InstallAddons \/ SkipAddons \/ Back
  \/ OpenSettings \/ CloseSettings
  \/ TmdbStopsWorking \/ DebridStopsWorking
  \/ PressPlay \/ PressParty

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The rules *)

\* Home is never shown without a profile and a valid TMDB key.
HomeNeedsProfileAndTmdb == screen = "home" => signedIn /\ current # 0 /\ tmdb = "valid"

\* Signed out, the landing page; no step of onboarding shows without a sign-in.
SignedOutSeesLanding == ~signedIn <=> screen = "landing"

\* Without a working debrid key Home shows Play as unavailable, and without a working TorBox key, parties.
NoTorBoxShownUnavailable ==
  screen = "home" =>
    /\ (~PlayOK(debrid, debridValid) => playUI = "unavailable")
    /\ (~TorBoxOK(debrid, debridValid) => partyUI = "unavailable")

\* ...and pressing them says so rather than failing.
NeverFailsForMissingTorBox == outcome # "failed"

\* With a working TorBox key, both are offered.
TorBoxShownAvailable ==
  screen = "home" /\ TorBoxOK(debrid, debridValid) =>
    playUI = "available" /\ partyUI = "available"

\* With another working service, Play is offered too: its files play, here or elsewhere.
DebridShownPlayable ==
  screen = "home" /\ PlayOK(debrid, debridValid) => playUI = "available"

=============================================================================
