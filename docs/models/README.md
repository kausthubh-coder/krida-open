# Formal models of open Krida

Four TLA+ models of what `.agents/plans/open-krida-spec.md` asks for, each checked by TLC, and the convex-test tests
that hold the code to them. A change that touches accounts, profiles, parties, onboarding or who may play a stream must
keep its model passing and its tests below green. The owner's page is
`models.html`.

| Model | What it covers | Clean run |
| --- | --- | --- |
| `AccountIsolation.tla` | Clerk sign-in, profiles (max per account, optional PIN), profile sessions, per-account keys, room listings | 343,644 states, 2 s |
| `PartyInvites.tla` | One room across accounts: invite link, same-account join, guests (24 h), leave, kick, host leaves, end; liveness | 156,257 states, 12 s |
| `Onboarding.tla` | One account on one device: sign in, profile, TMDB key (or skip), debrid, per-profile stream addons or none, extras, Home with or without TMDB; back, skip, profile switches, keys removed or dying later | 7,600 states |
| `StreamAccess.tla` | Who may load a room's stream (the HLS playlist), warm a title with its host's keys, and get in by a party or guest link: leave, kick, sweep, hand-off, close | 1,404,928 states, 13 s |

The hand-off rule (the owner's choice): the host leaving hands the room to a member whose account has TorBox,
someone of the host's own account first; with none, the party ends. `allowed` records who was let in (link, the host's
account at the time, or back in), since after a hand-off to another account the first host's account no longer matches.
The cfg gives only `a1` TorBox so `today_handoff_any_account` stays caught; with `TorBox = {a1, a2}` it also passes
(854,337 states, 1 min 11 s).

Times are on the Mac mini, `-workers auto`. AccountIsolation with 2 rooms also passes (24,925,536 states, 3 min 25 s); PartyInvites with 2 rooms ran past 10 minutes because of the liveness check, so its cfg keeps 1 room.

## Run

```sh
docs/models/check.sh [outdir]
```

It checks each `<Model>.cfg` as written (must print `PASS`), then every seeded bug (must print `CAUGHT`), and exits
non-zero otherwise. TLC output lands in `outdir` (default: a new temp folder). It finds TLC and Java through mise,
as the `statechart` skill installs them (`tla2tools` 1.7.4, `java@temurin-25`), or through `TLA2TOOLS` and `JAVA`.
One model by hand, from `docs/models/`:

```sh
java -XX:+UseParallelGC -cp "$(mise where 'http:tla2tools[url=https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar,checksum=sha256:936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88]@1.7.4')/tla2tools.jar" \
  tlc2.TLC -workers auto -config PartyInvites.cfg PartyInvites.tla
```

Charts: each model has a smaller `<Model>.chart.cfg` (under the tool's 500-state budget) and a `<Model>.view.mjs`
with the labels. From `docs/models/`:

```sh
~/.claude/skills/statechart/scripts/statechart Onboarding.tla --config Onboarding.chart.cfg --view Onboarding.view.mjs --out /tmp/chart-onboarding
```

## Seeded bugs

Every model has a `Bug` constant. `"none"` is the design. `check.sh` sets each other value and checks only the
rule it must break, with one worker so the trace is a shortest one. A name starting `today_` is what `convex/` does
right now; the others are mistakes an implementation could make. If you change a model, keep every bug caught; if a
bug stops being caught, the model lost the rule, so fix the model, not the list.

## Invariants and the tests that enforce them in code

Write these tests with convex-test (`tests/*.test.ts`) as the steps land. Assert exact values (AGENTS.md).

### AccountIsolation (`tests/accounts.test.ts`)

| Invariant | Seeded bug | Test to add | It asserts |
| --- | --- | --- | --- |
| `SessionInOwnAccount` | `today_choose_any_profile` | `choosing another account's profile is refused` | As account A (`t.withIdentity`), choosing B's profile throws `FORBIDDEN`; `sessions` has 0 rows for it |
| `SignOutEndsSessions` | `signout_keeps_sessions` | `signing out of the account ends its profile sessions` | After the sign-out mutation, `profiles.me({ token })` is `null` and the account has 0 sessions; a token used under another Clerk identity throws `UNAUTHENTICATED` |
| `PinRespected` | `skip_pin`, `pin_keeps_sessions` | `a PIN profile needs its PIN`, `setting a PIN ends the profile's other sessions` | A wrong or missing PIN returns `{ ok: false }` and makes no session; after setting a PIN, the other device's token gives `me` = `null`, the setter's still works |
| `KeysIsolated` | `keys_by_argument` | `keys are read only from the caller's account` | Account A's keys query returns A's key; B's profile gets B's (or `null`), never A's; no public function takes an account id (`tests/apiSnapshot.test.ts`) |
| `ProfileListIsolated` | `today_list_all_profiles` | `the picker lists only my account's profiles` | `profiles.list` equals exactly A's names in order, with B's profiles present in the table |
| `RoomListIsolated` | `today_live_lists_all_rooms` | `rooms.live lists only my account's rooms and rooms I'm invited to` | With rooms hosted by A, by B (invite sent to A's profile) and by B (no invite), A's profile sees exactly the first two |
| `MemberListIsolated` | `live_shows_all_members`, `today_get_any_room` | `another account's members show only in a room I'm in`, `room reads refuse non-members` | `rooms.live` for a room A was invited to lists only A's members; `rooms.get`, `messages.list`, `invites.forRoom` throw `FORBIDDEN` for a non-member |
| `MembersInvitedOrSameAccount` | `today_join_without_invite` | `joining another account's room needs its link` | `rooms.join` by B's profile without the link throws `FORBIDDEN`; with the link it joins; A's other profile joins without it |
| `DeletedLeavesNothing` | `delete_keeps_sessions`, `today_delete_keeps_rooms` | `deleting a profile ends its sessions, memberships and hosted rooms` | After delete: its token gives `me` = `null`, `roomMembers` by_profile is empty, a room it hosted has `closedAt` set |

### PartyInvites (`tests/partyInvites.test.ts`)

| Invariant | Seeded bug | Test to add | It asserts |
| --- | --- | --- | --- |
| `MembersInvitedOrSameAccount` | `today_join_without_invite` | `join needs the link or the host's account`, `a guest joins only its own room` | As in AccountIsolation; a guest token joining another room throws `FORBIDDEN` |
| `EndedRoomIsEmpty` | `end_keeps_link`, `today_end_keeps_guest_links` | `an ended party has no members and no working invite` | After it ends: every member row `left: true`, joining by the link throws `NOT_FOUND`, `profiles.temporaryInvite({ code })` of an unused guest link is `null`, also after `rooms.join` reopens it |
| `ExpiredGuestNotMember` | `today_lists_expired_guests` | `an expired guest is out before expireTemporary runs` | With fake timers at `expiresAt + 1` and the scheduled job not yet run, `rooms.get` members exclude the guest and the guest's calls throw `UNAUTHENTICATED` |
| `OneHostPresent` | `today_keep_absent_host` | `the host leaving hands off within the account first`, `with only guests and accounts without TorBox left, the party ends` | Host leaves with a same-account member and another account's: `hostId` is the same-account one; with only guests or accounts without TorBox left: `closedAt` is set and every row `left: true` |
| `KickedStayOut` | `kick_not_enforced` | `a kicked profile can't come back` | After a kick, `rooms.join` with the link throws `FORBIDDEN`, a heartbeat doesn't bring the row back, a kicked guest's token gives `me` = `null` |
| `HostHasTorBox` | `party_without_torbox`, `today_handoff_any_account` | `a party needs the host's TorBox`, `with nobody of the host's account, it goes to someone whose account has TorBox` | `createParty` without a TorBox key throws `NEEDS_TORBOX`; host leaving with only other accounts left hands to one with TorBox, and ends the party when none has it |
| `SeesCurrentTitle` (liveness) | `guests_miss_updates` | `every member's room read shows the new title` | After `changeMedia`, `rooms.get` for the host, a friend of another account and a guest all return the new `media.name`. convex-test can't check "eventually"; the party e2e script checks the screens |

### Onboarding (`tests/onboarding.test.ts`)

Keep the routing in one pure function (say `src/features/onboarding/route.ts`, the model's `Route`) fed by one
account-status query, so both are testable.

| Invariant | Seeded bug | Test to add | It asserts |
| --- | --- | --- | --- |
| `HomeNeedsProfile` | `signin_skips_picker` | `route sends to the first step still needed` | `route({ profile: false })` is `picker` whatever the status says |
| `TmdbAskedBeforeHome` | `route_ignores_tmdb`, `home_ignores_dead_key` | `route sends to the first step still needed`, `the TMDB step can be skipped, and Home comes without a key`, `a refused TMDB key is marked invalid`, `a key that stops working asks once more, and can be skipped then too`, `a TMDB key removed in Settings leaves the account at Home` | `route()` gives `tmdbKey` for no key or an invalid one until `tmdbAsked`; `onboarding.skipTmdb` sets it on the account (both profiles); a refusal after the skip clears it (`tmdb: "invalid", tmdbAsked: false`); a key cleared in Settings keeps it |
| `HomeNeverErrsForTmdb` | `home_needs_tmdb`, `key_saved_counts` | `addonRowsOf` and `useNeedsTmdbKey` (`src/data/keys.ts`, from the status's `tmdb`, so a refused key counts as none), checked on screen | Without a working key Home has Cinemeta's popular rows and the addons' (`CINEMETA_ROWS`), asks `/api/rows` and `/api/recs` nothing, and shows one "Add a TMDB key for more" link (`TmdbForMore`), never an error. No browser test covers it yet: look at Home, Search, a title page and a person link with a QA profile whose TMDB key is cleared |
| `SignedOutSeesLanding` | `signout_keeps_screen` | `signed out, the route is the landing page` | `route({ signedIn: false, ... })` is `landing` for every other input |
| `NoTorBoxShownUnavailable` | `stale_torbox_gate`, `play_without_either` | `TorBox gates follow the account's debrid`; `tests/plainStreams.test.ts` | `play` is false only when there is neither a working debrid key nor an enabled stream addon on this profile; `torbox` is false without a working TorBox key, regardless of addons. Gates follow key changes and profile switches |
| `NeverFailsForMissingTorBox` | `play_ignores_gate` | `Play without a debrid service and parties without TorBox refuse up front`; `tests/plainStreams.test.ts` | `rooms.create` throws `NEEDS_DEBRID` before scheduling only with neither a working debrid key nor an enabled stream addon; `createParty` without TorBox throws `NEEDS_TORBOX`. Room admission does not promise playable sources: plain HTTP files and .m3u8 play without debrid, but torrent-only results say "These sources need a debrid service" |
| `TorBoxShownAvailable` | `torbox_hidden_always` | `a working TorBox key opens both` | With a TorBox key TorBox accepts, the status query's `torbox` and `play` are `true` |
| `DebridShownPlayable` | `play_needs_torbox` | `another debrid service plays alone, but hosts no party`, `follows the steps, and resumes from the account and profile on any device`; `tests/plainStreams.test.ts` | `play` is true with any working debrid key or the current profile's enabled stream addon. An addon without the stream resource does not qualify. The model's `addons = "stream"` means an enabled stream addon; `"installed"` means only other addons, and `"skipped"` means none |

## Where today's code breaks the design

Each `today_` bug is a path TLC found in the code copied from private Krida. The accounts step fixed all of them; the
list stays as the record of what each seeded bug stands for, and the tests above keep them fixed.

- `rooms.join` checks no invite or account: any profile with a room id joins (`today_join_without_invite`).
- `rooms.live` lists every open room and all its members (`today_live_lists_all_rooms`). The spec's own rule
  ("hosted in your account or invited to") still shows another account's members of a room you aren't in
  (`live_shows_all_members`); the spec should say only your account's members show there.
- `rooms.get`, `messages.list` and `invites.forRoom` check only the token, not membership (`today_get_any_room`).
- `profiles.list` lists every profile with no auth (`today_list_all_profiles`); `profiles.signIn` takes any profile
  id and its password (`today_choose_any_profile`).
- `passHost` (`convex/lib/rooms.ts`) hands the room to the earliest permanent member of any account, who may have no
  TorBox (`today_handoff_any_account`); the spec says the room plays the host's TorBox but not what a hand-off does.
- With only guests or nobody left, `passHost` changes nothing: `hostId` stays on the profile who left and the room
  plays on, and a profile joining during the 30 s close grace is in a room without its host (`today_keep_absent_host`).
- `removeProfile` deletes memberships and sessions but leaves rooms it hosts open with a dangling `hostId`
  (`today_delete_keeps_rooms`).
- `closeRoom` cancels `invites` but leaves unused `temporaryInvites` live; only `joinTemporary`'s `closedAt` check
  stops them, and `rooms.join` reopens a closed room for 60 s (`today_end_keeps_guest_links`).
- `rooms.get` and `rooms.mine` list member rows by `left` only, so an expired guest shows until `expireTemporary`
  runs (`today_lists_expired_guests`).
- Sessions carry no account and no Clerk session: signing out must delete them (`SignOutEndsSessions`), and
  `requireProfile` should check the Clerk identity owns the session.
- There is no kick. A kick must set `swept: false` (a heartbeat revives swept rows) and `join` must refuse kicked
  profiles even with the link.

## What the models leave out

Exact timers (10 min sweep, 30 min idle, 60 s reopen: folded into single steps), `leaveOtherParties` across two
rooms, knocks and per-person `invites`, playback sync, PIN lockout, the 8-profile and 8-guest-link limits (2 and 1
here), more than one Clerk session per account per device, Stremio import and addon order, and keys other than TMDB
and debrid (MDBList and Simkl are the extras step, which gates nothing). Onboarding's Home is one screen: Search,
title pages and person pages follow the same `useNeedsTmdbKey` rule but aren't modeled.

### StreamAccess (`tests/streamAccess.test.ts`, `tests/partyRooms.test.ts`, `tests/partyInvites.test.ts`)

Its seeded bugs are what the code did before 4 Nov 2026, when Sol's review of the code against these models found them.

| Invariant | Seeded bug | Test | It asserts |
| --- | --- | --- | --- |
| `OnlyAllowedReads` | `hls_token_only` | `the host's account and the room's members, nobody else` | `/hls/playlist.m3u8` answers 200 to the host, a profile of the host's account and a member from another account; 403 to a stranger with a valid token; 401 without one |
| `OnlyAllowedReads` | `left_keeps_access` | `a member who was kicked or left stops getting it…`, `stays out after pressing Leave on another device` | A swept member still gets 200, one who pressed Leave or was kicked 403; after Leave, `rooms.get` and `messages.list` throw `You left this party`; once the room moves to another stream or closes, a friend's old stream id answers 403 |
| `OnlyMembersWarm` | `warm_any_room` | `spends the host's keys only for someone in that room` | `rooms.warm` with a room id throws for a stranger and for someone who left, scheduling nothing; the host's call schedules one warm-up |
| `NoGuestWithoutHost` | `guest_after_host_left` | `a guest link used while the host has just left alone finds the party over too` | `joinTemporary` throws `This party has ended` while the host's row is left, and `closeIfEmpty` then closes the room |
| `OthersNeedTorBox` | `link_without_torbox` | `watching alone on another debrid service, no party or guest link can be made` | `rooms.shareLink` and `profiles.inviteTemporary` throw `NEEDS_TORBOX` for a host without TorBox, and the room stays solo |

Not modeled: a host leaving mid-title leaves the current stream on the departed host's TorBox until the next title
(rebuilding it would stop everyone's picture); playlist segment links TorBox already handed out keep working until
they expire, which no check here can recall.
