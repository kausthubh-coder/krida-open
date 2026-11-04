------------------------------ MODULE Onboarding ------------------------------
(***************************************************************************)
(* Open Krida onboarding for one account on one device.                    *)
(*                                                                         *)
(* Signed out -> signed in with no profile -> profile made -> TMDB key      *)
(* (checked when pasted, or skip) -> debrid (TorBox, another service, or   *)
(* skip) -> addons (install or skip) -> extras (MDBList, Simkl: optional)  *)
(* -> Home. A person can go back a step, switch profiles, change keys in   *)
(* Settings, and a stored key can stop working later (the provider refuses *)
(* it on the next call). Keys are per account; addons are per profile, so  *)
(* a second profile still sees the addons step.                            *)
(*                                                                         *)
(* Without a TMDB key that works, Home runs on the addons and Cinemeta, as *)
(* Stremio's does, and leaves out what only TMDB has (trending rows,       *)
(* picks, people) behind one quiet link to Settings.                       *)
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
  tmdbAsked,    \* the account went past the TMDB step (a key, or skip) since its key last stopped working
  debrid,       \* "none", "torbox", "other"
  debridValid,  \* the debrid key works
  debridAsked,  \* the account went through the debrid step (chose or skipped)
  addons,       \* per profile: "todo", "installed" (no enabled stream addon), "stream", or "skipped"
  extrasAsked,  \* the account went past the optional keys step
  screen,       \* what the person sees
  playUI,       \* Home's Play (playing alone): "available" or "unavailable"
  partyUI,      \* Home's Watch together: "available" or "unavailable"
  outcome       \* what the last press on Home did: "none", "playing", "party", "told", "failed"

vars == <<signedIn, profiles, current, tmdb, tmdbAsked, debrid, debridValid, debridAsked, addons, extrasAsked,
          screen, playUI, partyUI, outcome>>

Screens == {"landing", "picker", "newProfile", "tmdbKey", "debrid", "addons", "extras", "home", "settings"}
Ids == 1..MaxProfiles

TorBoxOK(d, ok) == d = "torbox" /\ ok
\* Play may start with a working debrid key or an enabled stream addon. Plain HTTP files and HLS need no debrid;
\* torrents still do. This models room admission, not whether an addon finds a playable copy for a title.
PlayOK(d, ok, ad) == (d \in {"torbox", "other"} /\ ok) \/ ad = "stream"
CurrentAddons == IF current = 0 THEN "todo" ELSE addons[current]
Gate(open) == IF open THEN "available" ELSE "unavailable"

\* The live query follows both the account's keys and the current profile's enabled stream addons.
\* Parties still need TorBox, even when the title happens to play from a plain link.
SetGates(d, ok, ad) ==
  IF Bug = "torbox_hidden_always"
  THEN playUI' = "unavailable" /\ partyUI' = "unavailable"
  ELSE /\ playUI' = Gate(IF Bug = "play_without_either" THEN TRUE
                         ELSE IF Bug = "play_needs_torbox" THEN TorBoxOK(d, ok) ELSE PlayOK(d, ok, ad))
       /\ partyUI' = Gate(TorBoxOK(d, ok))

\* What Home shows of TMDB, from the live onboarding status: "full" with a key that works; "basic" (the addons' and
\* Cinemeta's rows, one quiet "Add a TMDB key for more" link) without; "error" when it asks TMDB for something it
\* can't have. Asking with a key TMDB refuses fails too, so it's the key working that counts, not one being saved.
UsesTmdb(t) == IF Bug = "key_saved_counts" THEN t # "none" ELSE t = "valid"
HomeTmdb(t) ==
  IF UsesTmdb(t) THEN (IF t = "valid" THEN "full" ELSE "error")
  ELSE IF Bug = "home_needs_tmdb" THEN "error" ELSE "basic"

\* Where the app sends a signed-in profile: the first step it still needs, else Home.
Route(t, ta, asked, ad, ex) ==
  IF t # "valid" /\ ~ta /\ Bug # "route_ignores_tmdb" THEN "tmdbKey"
  ELSE IF ~asked THEN "debrid"
  ELSE IF ad = "todo" THEN "addons"
  ELSE IF ~ex THEN "extras"
  ELSE "home"

\* The route for profile i with the account as it is now.
RouteNow(i) == Route(tmdb, tmdbAsked, debridAsked, addons[i], extrasAsked)

TypeOK ==
  /\ signedIn \in BOOLEAN
  /\ profiles \in 0..MaxProfiles
  /\ current \in 0..MaxProfiles
  /\ tmdb \in {"none", "valid", "invalid"}
  /\ tmdbAsked \in BOOLEAN
  /\ debrid \in {"none", "torbox", "other"}
  /\ debridValid \in BOOLEAN
  /\ debridAsked \in BOOLEAN
  /\ addons \in [Ids -> {"todo", "installed", "stream", "skipped"}]
  /\ extrasAsked \in BOOLEAN
  /\ screen \in Screens
  /\ playUI \in {"available", "unavailable"}
  /\ partyUI \in {"available", "unavailable"}
  /\ outcome \in {"none", "playing", "party", "told", "failed"}

Init ==
  /\ signedIn = FALSE
  /\ profiles = 0
  /\ current = 0
  /\ tmdb = "none"
  /\ tmdbAsked = FALSE
  /\ debrid = "none"
  /\ debridValid = FALSE
  /\ debridAsked = FALSE
  /\ addons = [i \in Ids |-> "todo"]
  /\ extrasAsked = FALSE
  /\ screen = "landing"
  /\ playUI = "unavailable"
  /\ partyUI = "unavailable"
  /\ outcome = "none"

Keys == <<tmdb, tmdbAsked, debrid, debridValid, debridAsked, extrasAsked>>

-----------------------------------------------------------------------------
(* Signing in and profiles *)

SignIn ==
  /\ ~signedIn
  /\ signedIn' = TRUE
  \* The bug: signing in again reopens Home as it was left, before a profile is chosen.
  /\ screen' = IF profiles = 0 THEN "newProfile"
               ELSE IF Bug = "signin_skips_picker" /\ RouteNow(1) = "home" THEN "home" ELSE "picker"
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
  /\ screen' = RouteNow(profiles + 1)
  /\ SetGates(debrid, debridValid, addons[profiles + 1])
  /\ UNCHANGED <<signedIn, addons, outcome>> /\ UNCHANGED Keys

ChooseProfile(i) ==
  /\ screen = "picker"
  /\ i <= profiles
  /\ current' = i
  /\ screen' = RouteNow(i)
  /\ SetGates(debrid, debridValid, addons[i])
  /\ UNCHANGED <<signedIn, profiles, addons, outcome>> /\ UNCHANGED Keys

SwitchProfile ==
  /\ screen = "home"
  /\ current' = 0
  /\ screen' = "picker"
  /\ outcome' = "none"
  /\ UNCHANGED <<signedIn, profiles, addons, playUI, partyUI>> /\ UNCHANGED Keys

-----------------------------------------------------------------------------
(* Keys: in onboarding and in Settings. A pasted key is checked first. Each step's button goes on to the first
   step still needed (the server's route), so fixing a key that stopped working comes back where it left off. *)

PasteTmdb(ok) ==
  /\ screen \in {"tmdbKey", "settings"}
  /\ IF ok
     THEN /\ tmdb' = "valid"
          /\ tmdbAsked' = TRUE
          /\ screen' = IF screen = "settings" THEN "settings"
                       ELSE Route("valid", TRUE, debridAsked, addons[current], extrasAsked)
     ELSE UNCHANGED <<tmdb, tmdbAsked, screen>>   \* refused: the step says why and stays
  /\ UNCHANGED <<signedIn, profiles, current, debrid, debridValid, debridAsked, addons, extrasAsked,
                 playUI, partyUI, outcome>>

\* The TMDB step with a key that already works: Continue.
KeepTmdb ==
  /\ screen = "tmdbKey"
  /\ tmdb = "valid"
  /\ screen' = RouteNow(current)
  /\ UNCHANGED <<signedIn, profiles, current, addons, playUI, partyUI, outcome>> /\ UNCHANGED Keys

\* "Skip for now", with no key or one TMDB refuses: Home works without TMDB.
SkipTmdb ==
  /\ screen = "tmdbKey"
  /\ tmdb # "valid"
  /\ tmdbAsked' = TRUE
  /\ screen' = Route(tmdb, TRUE, debridAsked, addons[current], extrasAsked)
  /\ UNCHANGED <<signedIn, profiles, current, tmdb, debrid, debridValid, debridAsked, addons, extrasAsked,
                 playUI, partyUI, outcome>>

\* Settings → Connections: the account keeps going without TMDB.
RemoveTmdb ==
  /\ screen = "settings"
  /\ tmdb # "none"
  /\ tmdb' = "none"
  /\ UNCHANGED <<signedIn, profiles, current, tmdbAsked, debrid, debridValid, debridAsked, addons, extrasAsked,
                 screen, playUI, partyUI, outcome>>

ChooseDebrid(d, ok) ==
  /\ screen \in {"debrid", "settings"}
  /\ IF ok
     THEN /\ debrid' = d
          /\ debridValid' = TRUE
          /\ debridAsked' = TRUE
          /\ IF Bug = "stale_torbox_gate" /\ screen = "settings"
             THEN UNCHANGED <<playUI, partyUI>> ELSE SetGates(d, TRUE, CurrentAddons)
          /\ screen' = IF screen = "settings" THEN "settings"
                       ELSE Route(tmdb, tmdbAsked, TRUE, addons[current], extrasAsked)
     ELSE UNCHANGED <<debrid, debridValid, debridAsked, playUI, partyUI, screen>>
  /\ UNCHANGED <<signedIn, profiles, current, tmdb, tmdbAsked, addons, extrasAsked, outcome>>

SkipDebrid ==
  /\ screen = "debrid"
  /\ debridAsked' = TRUE
  /\ SetGates(debrid, debridValid, CurrentAddons)
  /\ screen' = Route(tmdb, tmdbAsked, TRUE, addons[current], extrasAsked)
  /\ UNCHANGED <<signedIn, profiles, current, tmdb, tmdbAsked, debrid, debridValid, addons, extrasAsked, outcome>>

RemoveDebrid ==
  /\ screen = "settings"
  /\ debrid # "none"
  /\ debrid' = "none"
  /\ debridValid' = FALSE
  /\ IF Bug = "stale_torbox_gate" THEN UNCHANGED <<playUI, partyUI>> ELSE SetGates("none", FALSE, CurrentAddons)
  /\ UNCHANGED <<signedIn, profiles, current, tmdb, tmdbAsked, debridAsked, addons, extrasAsked, screen, outcome>>

\* Installing addons may include an enabled stream addon, or only catalogs/subtitles.
InstallAddons(stream) ==
  /\ screen = "addons"
  /\ addons' = [addons EXCEPT ![current] = IF stream THEN "stream" ELSE "installed"]
  /\ SetGates(debrid, debridValid, addons'[current])
  /\ screen' = Route(tmdb, tmdbAsked, debridAsked, addons'[current], extrasAsked)
  /\ UNCHANGED <<signedIn, profiles, current, outcome>> /\ UNCHANGED Keys

SkipAddons ==
  /\ screen = "addons"
  /\ addons' = [addons EXCEPT ![current] = "skipped"]
  /\ SetGates(debrid, debridValid, "skipped")
  /\ screen' = Route(tmdb, tmdbAsked, debridAsked, "skipped", extrasAsked)
  /\ UNCHANGED <<signedIn, profiles, current, outcome>> /\ UNCHANGED Keys

\* The optional keys (MDBList, Simkl): "Go to Home", with or without them.
PassExtras ==
  /\ screen = "extras"
  /\ extrasAsked' = TRUE
  /\ screen' = Route(tmdb, tmdbAsked, debridAsked, addons[current], TRUE)
  /\ UNCHANGED <<signedIn, profiles, current, tmdb, tmdbAsked, debrid, debridValid, debridAsked, addons,
                 playUI, partyUI, outcome>>

Back ==
  /\ screen \in {"debrid", "addons", "extras"}
  /\ screen' = CASE screen = "debrid" -> "tmdbKey"
                 [] screen = "addons" -> "debrid"
                 [] OTHER -> "addons"
  /\ UNCHANGED <<signedIn, profiles, current, addons, playUI, partyUI, outcome>> /\ UNCHANGED Keys

OpenSettings ==
  /\ screen = "home"
  /\ screen' = "settings"
  /\ outcome' = "none"
  /\ UNCHANGED <<signedIn, profiles, current, addons, playUI, partyUI>> /\ UNCHANGED Keys

CloseSettings ==
  /\ screen = "settings"
  /\ screen' = RouteNow(current)
  /\ UNCHANGED <<signedIn, profiles, current, addons, playUI, partyUI, outcome>> /\ UNCHANGED Keys

-----------------------------------------------------------------------------
(* Keys stop working later: the provider refuses the next call. A TMDB key that stops working asks once more: the
   step, to paste a new one or skip it. *)

TmdbStopsWorking ==
  /\ tmdb = "valid"
  /\ tmdb' = "invalid"
  /\ tmdbAsked' = FALSE
  /\ screen' = IF screen = "home" /\ Bug # "home_ignores_dead_key" THEN "tmdbKey" ELSE screen
  /\ outcome' = IF screen' # screen THEN "none" ELSE outcome
  /\ UNCHANGED <<signedIn, profiles, current, debrid, debridValid, debridAsked, addons, extrasAsked, playUI, partyUI>>

DebridStopsWorking ==
  /\ debrid # "none"
  /\ debridValid
  /\ debridValid' = FALSE
  /\ IF Bug = "stale_torbox_gate" THEN UNCHANGED <<playUI, partyUI>> ELSE SetGates(debrid, FALSE, CurrentAddons)
  /\ UNCHANGED <<signedIn, profiles, current, tmdb, tmdbAsked, debrid, debridAsked, addons, extrasAsked, screen, outcome>>

-----------------------------------------------------------------------------
(* Pressing Play or Watch together on Home. "playing" means admission to a solo room, whose source search can still
   find only torrents needing debrid, or no sources. A file the browser can't play offers the app/external players. *)

PressPlay ==
  /\ screen = "home"
  /\ outcome' = IF playUI = "unavailable" /\ Bug # "play_ignores_gate" THEN "told"
                ELSE IF PlayOK(debrid, debridValid, CurrentAddons) THEN "playing" ELSE "failed"
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
  \/ KeepTmdb \/ SkipTmdb \/ RemoveTmdb
  \/ \E d \in {"torbox", "other"}, ok \in BOOLEAN : ChooseDebrid(d, ok)
  \/ SkipDebrid \/ RemoveDebrid \/ (\E stream \in BOOLEAN : InstallAddons(stream)) \/ SkipAddons \/ PassExtras \/ Back
  \/ OpenSettings \/ CloseSettings
  \/ TmdbStopsWorking \/ DebridStopsWorking
  \/ PressPlay \/ PressParty

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The rules *)

\* Home is never shown without a profile.
HomeNeedsProfile == screen = "home" => signedIn /\ current # 0

\* Home comes after the TMDB step was offered: a key that works, or skipped since the saved key last stopped working.
TmdbAskedBeforeHome == screen = "home" => tmdb = "valid" \/ tmdbAsked

\* A missing TMDB key (or one TMDB refuses) never shows an error on Home: it runs on the addons and Cinemeta.
HomeNeverErrsForTmdb == screen = "home" => HomeTmdb(tmdb) # "error"

\* Signed out, the landing page; no step of onboarding shows without a sign-in.
SignedOutSeesLanding == ~signedIn <=> screen = "landing"

\* Play is unavailable with neither a working debrid key nor an enabled stream addon on this profile.
\* Parties are unavailable without a working TorBox key, regardless of addons.
NoTorBoxShownUnavailable ==
  screen = "home" =>
    /\ (~PlayOK(debrid, debridValid, CurrentAddons) => playUI = "unavailable")
    /\ (~TorBoxOK(debrid, debridValid) => partyUI = "unavailable")

\* A press lacking those prerequisites is refused before a room/job starts, rather than failing inside the job.
\* This does not promise that a stream addon supplies a playable source for every title.
NeverFailsForMissingTorBox == outcome # "failed"

\* With a working TorBox key, both are offered.
TorBoxShownAvailable ==
  screen = "home" /\ TorBoxOK(debrid, debridValid) =>
    playUI = "available" /\ partyUI = "available"

\* Play is offered with any working debrid key or this profile's enabled stream addon (canPlayAlone/status.play).
DebridShownPlayable ==
  screen = "home" /\ PlayOK(debrid, debridValid, CurrentAddons) => playUI = "available"

=============================================================================
