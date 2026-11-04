# Trakt sync (both ways)

The registered functions live in `convex/trakt.ts`. The helpers are in `convex/lib/`. `traktApi.ts` holds requests,
the device-code login and token refresh. `traktPull.ts` is the import. `traktOutbox.ts` sends Krida's changes to Trakt
and is the only place that builds a Trakt write. `scripts/check-boundaries.ts` keeps `/sync/history/remove` there and in
Simkl's outbox. The design copies Simkl's (`docs/simkl.md`), with the differences below.

## Turning it on

The server reads `TRAKT_CLIENT_ID` and `TRAKT_CLIENT_SECRET` from the Convex environment. Register an app at
https://trakt.tv/oauth/applications with the redirect URI `urn:ietf:wg:oauth:2.0:oob` (device codes need no other).
Without both variables, `trakt.enabled` is false and Settings → Connections shows Trakt as not set up on this server.
Nothing else changes.

## Connecting with a device code

A profile connects with Trakt's device code, not a redirect:

1. `trakt.start` asks Trakt for a code and keeps the device code on the server (`traktLogins`). The browser gets only
   the short code, the activation URL and when the code expires.
2. The person enters the code at trakt.tv/activate on any device.
3. `trakt.poll` asks Trakt every `interval` seconds, as Trakt sets it. It stops when Trakt approves, when the person
   says no (418), when the code expires (about ten minutes), or when they press Cancel. Each check books the next one,
   so the checks never outlive the code. This is the only repeated request, and only during a login someone started.
4. On approval, `trakt.saveConnection` stores the tokens in `traktConnections` and starts the import.

Why not a redirect: Trakt would have to send the browser back to a registered URL. The Android app's WebView, Krida for
Windows, an installed PWA and every preview deployment would each need their own return URL, and a sign-in that
leaves the app (a Google login on trakt.tv) often can't come back to it. A code works on all of them and on a TV with
no keyboard. The server keeps asking even while a phone's browser is in the background on trakt.tv.

Tokens never leave the server. `trakt.status` and `trakt.login` return no token or device code, and a test checks that.

## Trakt to Krida

The first sync brings in everything. Later syncs read `/sync/last_activities` and fetch only the lists whose times
moved.

| Trakt | Krida |
| --- | --- |
| `/sync/watched/movies`, `/sync/watched/shows` | finished `progress` rows, one per movie or episode, at its last watch time |
| `/sync/playback` (`extended=full`) | unfinished `progress` rows, positioned at Trakt's percentage of the runtime |
| `/sync/watchlist/movies`, `/shows` | Plan to watch (`library`, with `trakt: true`) |
| `/sync/ratings/movies`, `/shows` | Your ratings (`feedback`, 1 to 10 like Trakt) |

- A later sync of watched shows refetches the list, which costs Convex nothing, and writes only shows whose
  `last_updated_at` is at or after the last sync. Plays Trakt adds with an old date still come in.
- Titles without an IMDb id are skipped. Krida opens titles by IMDb or Kitsu id, and Trakt has no Kitsu ids.
- Newer wins. A play under way in Krida that is newer than Trakt's stays. A score set in Krida after Trakt's stays.
  A change waiting in the outbox wins over what Trakt says.
- A title that leaves the Trakt watchlist leaves Plan to watch only if it came from there (`trakt: true`).
- Plays removed on Trakt stay in Krida, and so do ratings removed there. Krida never deletes history because a
  list got shorter.
- Season and episode ratings, collections and Trakt's own lists aren't imported.

It runs while someone uses Krida. `trakt.touch` runs when the app opens or comes back to the front, at most every ten
minutes. Sync now also starts it. No cron or timer calls Trakt; `tests/trakt.test.ts` checks the crons.

## Krida to Trakt

`enqueueTrakt` sits beside each place that queues a Simkl change:

| In Krida | Sent to Trakt |
| --- | --- |
| finishing a movie or episode (`progress.save`), a rewatch's included | `/sync/history`, with the time it finished |
| marking episodes watched, or Watched in the status menu (a show: every episode) | `/sync/history` |
| unmarking episodes, "I didn't watch this" | `/sync/history/remove` |
| adding to Plan to watch | `/sync/watchlist` |
| leaving Plan to watch (removed, or a status that takes it off) | `/sync/watchlist/remove` |
| a score or a thumb (thumbs go as 9, 7 or 3), or clearing one | `/sync/ratings`, `/sync/ratings/remove` |

- A finished play goes through `/sync/history` with `watched_at`, not `/scrobble/stop`. The outbox sends it about 45
  seconds later and may retry it, and a scrobble stamps the play with the time Trakt receives it. Trakt doesn't show
  "watching now" for Krida yet.
- An anime played by Kitsu id goes as the IMDb episode it stands for (`media.ref`). Anything else under a Kitsu id
  stays in Krida.
- Changes wait 45 seconds and go as one request per kind, 1.1 seconds apart (Trakt allows one write a second).
  Opposite changes made before sending cancel out: plan and unplan, or marking and unmarking an episode.
- A 429 pauses everything until Trakt's Retry-After. A change Trakt rejects (4xx, or 420 for a free account's list
  limit) or lists in `not_found` is dropped. Anything else retries with backoff and is dropped after 8 tries.
- Turning off "Keep Trakt up to date" stops new changes from queueing and pauses the ones waiting.

## Disconnecting

`trakt.disconnect` deletes the tokens, the waiting changes and any login at once, then revokes the grant on Trakt.
What the import brought in stays, because it's the profile's history now. Plan to watch rows stop following the
Trakt watchlist. Connecting another account starts over with a full import. Removing a profile deletes its Trakt rows
(`convex/lib/profiles.ts`).
