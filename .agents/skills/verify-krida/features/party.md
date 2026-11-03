# Watch party

Watch together: start a party, invite the others, suggest titles and vote, a countdown sends everyone to the player,
with synced playback, a shared queue, chat and reactions in the Party panel.

## Sub-features

- `party-offer` opens the Party panel from the dock. It starts nothing until you press Invite (or Start without inviting anyone).
- `party-start` starts a party with a title from its page, in the `Start a watch party` sheet.
- `party-join` accepts an invite from the notification.
- `party-knock` asks to join a friend watching alone (the party button says "Ask to join"); they answer Let in or Not now.
- `party-suggest` suggests a title from its page or a poster; `I'm in` votes; all in starts a countdown.
- `party-chat` sends messages and reactions.
- `party-leave` leaves, or goes back to picking, from `More party options`.

## How to get to it (user POV)

- The Party icon in the dock or tab bar; the party button on a title page.

## Driving it with Playwright

Preconditions: QA app up. Two browser contexts: A signed in as `Regress-QA-one`, B as `Regress-QA-two`.

- **Start.** In A, click `getByRole("button", { name: /^Watch (together|with)/ })`: the panel (`getByRole("complementary",
  { name: "Party" })`) opens with no party yet. Click its `Invite Regress-QA-two`.
- **Join.** In B, `getByText("invited you to a party")` shows; click `Join` in
  `getByRole("region", { name: /Notifications/ })`. A shows "You and Regress-QA-two are here".
- **Chat.** In A, fill `getByRole("textbox", { name: "Message" })`, click `Send`. B sees the message.
- **Ask to join.** With B playing a film alone, A's party button is named `<B> is watching <title>. Ask to join`. B's
  notification has `Let in` and `Not now`; after Let in, A lands on `/watch/`. `scripts/e2e-party-join.mjs` drives it.
- **Leave.** `More party options`, then `Leave party`. `Back to picking` asks `Stop for everyone?` while someone else
  watches.
- **Proof.** Screenshots of both browsers after joining and after the message arrives.

## Gotchas

- The countdown starts the player with the stand-ins' test video. Synced playback between two real files is checked
  on the dev backend (`scripts/e2e-party-flow.mjs`, `e2e-party-panel.mjs` with `*-QA-*` profiles).
- `scripts/e2e-party*.mjs` launch two browsers; close both contexts at the end or the party stays open until the sweep.
