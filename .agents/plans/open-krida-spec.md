# Open Krida: the spec every build step follows

Open Krida is the public, open-source Krida: anyone signs up, brings their own keys and Stremio addons, and streams.
It started as a copy of the owner's private Krida (`~/dev/krida` on the owner's machine). **Never touch private Krida:
its checkout, repo, Convex deployments or Vercel project** (its own `AGENTS.md` names them). Everything here runs on
open Krida's own services:

| Service | Open Krida's |
| --- | --- |
| GitHub | `kausthubh-coder/krida-open` (private until the secrets scan; then public) |
| Convex | project `krida-open`: dev `fastidious-oyster-35`, prod `industrious-axolotl-949` |
| Vercel | project `krida-open`, default domain until the owner buys one (e.g. krida.app) |
| Clerk | app "Krida" (development instance until a custom domain exists: Clerk production can't use `*.vercel.app`) |

## Accounts and profiles

- **Account** = one Clerk user (Google sign-in; email code as the fallback). One account holds up to 8 **profiles**,
  Netflix style: a picker after sign-in, name and avatar per profile, optional 4-digit PIN.
- Keep the existing session shape so most functions don't change: choosing a profile (Clerk-authenticated, profile
  must belong to the caller's account, PIN checked) mints the same `sessions` row and token that `requireProfile(ctx,
  token)` in `convex/lib/auth.ts` already reads. Password sign-in goes away.
- **No friend system.** Profiles in one account see each other (Home's "For you and X" rows, who's watching). Nothing
  ever lists profiles or rooms of another account, except the members of a party you are in.
- **Parties** work between profiles of one account and across accounts: the host shares an invite link; any signed-in
  profile of any account that opens it joins. The temporary-guest invite (no account) stays. `rooms.live` shows only
  rooms hosted in your account or rooms you were invited to. Parties need TorBox for now (the room plays the host's
  TorBox stream for everyone); say so in the party UI when the host has no TorBox key.

## Keys (per account) and addons (per profile)

- Account settings, "Connections": **TMDB key (required)**, MDBList key (optional), **debrid service + key**
  (TorBox, Real-Debrid, AllDebrid, Premiumize, Debrid-Link, Offcloud, EasyDebrid; any one, TorBox recommended). Keys
  are checked against the provider when pasted. They live in Convex; only that account's sessions can read them.
- What needs TorBox, said plainly in onboarding and where it bites: playing in the browser and the PWA (TorBox turns
  files into HLS a browser plays), watch parties, and the timeline's preview pictures. Other debrid services play in
  the desktop app (mpv) and through an external player; in the browser only when the file is a format it plays.
- TorBox referral: a sign-up link built from `VITE_TORBOX_REFERRAL` (empty means a plain link).
- **Addons per profile**: Stremio manifest URLs, ordered, each on or off. Install by pasting a link, by importing from
  a Stremio account (`api.strem.io/api/login` then `addonCollectionGet`, called from the browser; never store the
  Stremio password), or from suggestions configured with the account's debrid key (TorBox's own Stremio addon,
  Torrentio with that debrid, Comet). Cinemeta and Kitsu metadata are built in.
- **Catalogs per profile**: every catalog of every installed addon can be renamed, hidden, reordered, pinned to the
  top, or used for the Home hero. Built-in rows (TMDB trending, Netflix Top 10, Continue watching, Plan to watch,
  recommendations) sit in the same list. This replaces the AIOStreams-specific ordering in `src/features/home/homeRows.ts`.
- Streams come from the profile's installed stream addons, queried in parallel, merged and ranked as today.
  An addon without CORS is reached through one `/api` proxy (the `api/` folder must stay at 12 endpoints or fewer).

## What changes from private Krida

- Every hard-coded owner thing becomes per account: `TORBOX_API_KEY`, `AIOSTREAMS_*`, `TMDB_API_KEY`,
  `MDBLIST_API_KEY` (`shared/tmdb.ts`, `shared/mdblist.ts`, `convex/lib/providers.ts`, `server/torbox.ts`, the frames
  Worker). `/api` endpoints get the caller's keys from the session; caches stay shared (TMDB data isn't personal).
- Recommendations work as before (taste from synced tables, `/api/recs` scoring) on the account's keys. The Claude
  picks job (`scripts/picks/`) is removed.
- Private Krida's hard-coded URLs and deployment names become open Krida's, from one place where possible.
- Personal things go: the owner's and friends' names, the PostHog project key (telemetry only when its env is set), the
  owner's Simkl client (Simkl connect shows only when `SIMKL_CLIENT_ID` is set).
- Signed out, `/` is the landing page. Signed in without a profile or keys, onboarding.

## Platforms

Web, the PWA (Android and iPhone), the Android app (`android/`), the Mac app and the Windows app (`desktop/`), each
pointing at open Krida's URL with its own releases repo `kausthubh-coder/krida-open-releases`. TV later.
Test order: web, iPhone PWA in the iOS Simulator, Android in the emulator, Mac app; Windows last, on the laptop.

## Proof

- Formal models (TLA+, `docs/models/`, checked with TLC through the `statechart` skill) for: account and profile
  isolation, party invites across accounts, and onboarding. Each invariant also gets a convex-test test.
- convex-test tests for every new function, including the refusals (another account's profile, another account's
  keys, a room you weren't invited to).
- Drive each feature in a real browser against a local or dev backend with a Clerk test user
  (`+clerk_test@example.com`, code 424242) and keep screenshots.
