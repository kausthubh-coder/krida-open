# Landing, sign-in, the profile picker and onboarding

Signed out, `/` is the landing page (a browser that never signed in gets it alone, without the app's code;
`src/main.tsx`), and every other address shows Clerk's sign-in (Google, or a code by email); `/sign-in` is the one
the landing links to. Inside the Android or desktop app there is no landing page. Signed in to the account, it shows "Who's
watching?": the account's profiles (up to 8), Add profile, Manage profiles (rename, colour, delete) and Sign out.
Choosing a profile opens Home; a profile with a PIN asks for its 4 digits first. Scripts that only need to be signed
in as a QA profile skip all this with QA sign-in (`/qa`, `signIn` in `scripts/lib/qa.ts`).

## Sub-features

- `landing` at `/` signed out: heading "Press play on anything", links `Get started` and `Sign in` to `/sign-in`.
- `sign-in` signs in with Clerk; a first sign-in makes the account and opens "Make your profile", whose Continue
  opens that profile and goes on to onboarding.
- `onboarding` (`docs/models/Onboarding.tla`): headings "Connect TMDB" (required; a key TMDB refuses stays here),
  "Pick your debrid service" (radios, TorBox first; `Skip for now`), "Add where streams come from" (this profile's
  addons; `Skip for now` or `Continue`), "A few extras" (MDBList, Simkl when enabled; `Go to Home`). Key fields are
  labelled `<Service> API key` with a `Check key` button and check on paste. Each step is saved, so another device
  resumes at the first step still needed; a new profile in a set-up account gets only the addons step.
- `needs-torbox`: without a working TorBox key, Play on a title and the Home banner is dimmed with "Playing in the
  browser needs TorBox. Add a TorBox key", and pressing it says so instead of starting; parties say "Parties need TorBox".
- `picker` lists only this account's profiles, with a lock beside those with a PIN.
- `pin` asks for a PIN profile's PIN; a wrong one says "Wrong PIN. Try again." and five lock it for 5 minutes.
- `manage` renames, recolours and deletes profiles (a PIN profile asks for its PIN first).
- `switch` goes back to the picker with `Switch profile` in the profile menu; `Sign out` there signs the account out.
- `settings-pin` sets, changes or removes the PIN in Settings → Account.

## How to get to it (user POV)

- Open the site in a fresh browser: the landing page; `/sign-in` or any other address: the sign-in screen.
- Profile menu in the dock → Switch profile (the picker) or Sign out.

## Driving it with Playwright

Preconditions: QA app up (`npm run qa -- up`) with `VITE_CLERK_PUBLISHABLE_KEY` in `.env.local`; Clerk test users,
made with `npx -y clerk@latest users create --email <name>+clerk_test@example.com` (their code is always 424242).

- `node scripts/e2e-accounts.ts <a>+clerk_test@example.com <b>+clerk_test@example.com` drives sign-in, the picker and
  PINs, two accounts and a party between them, with screenshots in `.artifacts/accounts/`. It needs `TMDB_API_KEY` in
  `.env.test.local` for onboarding.
- `node scripts/e2e-onboarding.ts <a> <b>` (on `npm run qa -- up --real`) drives the landing page, every onboarding
  step with real keys, playback and the needs-TorBox states, at 1440 and 390, in `.artifacts/onboarding/`.
- Both scripts need test users with no account on this backend: a fresh `npm run qa -- up` forgets every account, so
  the same Clerk test users work again after `down` and `up`.
- Sign-in by hand: `getByLabel("Email address")`, button `Continue`, wait for "Check your email", click the first
  textbox and type `424242`.
- Picker: buttons named after each profile (`Kid, locked with a PIN` for a PIN profile), `Add profile`,
  `Manage profiles` (then `Edit <name>`), `Sign out`. PIN: `getByLabel("PIN", { exact: true })`, sent at the 4th digit.

## Gotchas

- Clerk shows the code boxes a moment before the code is sent; a code typed in that moment is refused ("You need to
  send a verification code…"). Wait a second, or press Resend and type it again (the script does).
- Five wrong PINs lock the profile for 5 minutes (`failedAttempts`, `lockedUntil`). Don't loop on wrong PINs.
- The profile session lives in `localStorage` under `krida.session`; a new browser context starts signed out of both.
- `npm run regress` builds the app without Clerk (its widget talks to Clerk's servers), so its `gate` step shows the
  "no sign-in set up" text, not Clerk's widget.
