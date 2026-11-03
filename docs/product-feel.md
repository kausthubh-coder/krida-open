# Krida — product feel

**Who:** people who bring their own TMDB and debrid keys and watch alone or with friends. An account holds a household's profiles. They know the app well after a week.

**How often:** a few evenings a week, one long session at a time (an episode or a film, 30–180 min). Most time is spent in
the player; browsing is short and goal-directed ("put on Dune", "next episode").

**State of mind:** relaxed, social, a little impatient between "I want to watch X" and the picture starting.

**Three words:** cinematic, calm, together.

## Dials

- **Density: comfortable.** Big artwork, generous gaps, 44px touch targets. Lists of sources are the one dense place
  (people scan them), so rows there are compact but still 48px tall.
- **Pace: instant for frequent, animated for rare.** Hover, tabs, player controls: instant or ≤150ms. Opening a title,
  the source sheet, joining a party: 200–300ms with `--ease-snappy`. Exits are half as long.
- **Tone: quiet, artwork leads.** Neutrals tinted warm (hue 60, chroma ≤0.012). No hue for the brand: the accent is
  light, a white pill for the primary action (Play) and a white glow for the current selection, so the only color in
  the frame is the artwork's. Status colors only for status.

## Novelty budget

Spent on three rare moments: an invite arriving (soft two-note chime + toast that stays until answered), both
people landing in the same room (a short "you're watching together" moment), and opening Wrapped (a scrollable
retrospective with oversized type, artwork and a downloadable card). Wrapped follows the reader's scroll without
autoplay or forced pacing. Everyday Library tabs and charts stay quiet.

## Rules

- Dark only. It is a cinema app; the page is `oklch(0.145 …)`, never #000, and surfaces get lighter as they rise.
- Artwork has fixed aspect ratios (posters 2:3, backdrops 16:9) and a 10% inset outline; missing art has a designed
  fallback, never a grey hole.
- Every wait over 1s says what it is doing ("Finding sources…", "Adding to TorBox…", "Starting stream…").
- Secrets (playback URLs, other accounts' keys) never reach the browser. An addon's link may hold the account's own
  debrid key; only that profile's own sessions read it.
- Solid is the default. Bubbles are a beta you turn on in Settings → Display and sound (`useBubbleGlass`, kept per device), so the plain look has to look deliberate too: check both.
- Bubbles are bubli, the kit in `~/dev/bubli`, vendored as `vendor/bubli-*.tgz`. Krida's fit of it is `src/ui/bubbles.tsx` (the numbers per family) and the `--bubli-*` tokens in `styles.css`. Change those before you change a component, and fix what's wrong in the kit in the kit.
- Controls, bars, menus, popovers, sheets and toasts are bubbles with a rim, a wobble and a little frost. The white pill is the one main action on a screen (`Button variant="primary"`). Rows, cards and posters are never bubbles: a poster has only its plain outline, and a row is a shade under the pointer. Something too small or too short-lived for a bubble of its own (a label on the picture) is `glass`, frosted CSS.
- No bubble in a bubble. A menu or panel's controls are plain (`BubliFlat`), and what's chosen inside one is a soft shade (`lens`). The player's capsules are the one place a thumb sits on a bar.
- A menu is its button grown bigger: `Grow` (`src/ui/grow.tsx`) grows it out of what opened it, overshoots a little and shrinks back with no bounce; `useDismiss` gives it a press outside and Escape. A panel that stays put is a `Pane`. A sheet rises from the bottom on a phone and from the right on a wide screen, with a margin all round.
- The selected item in a bar is a lens (`useLiquidLens`): a quiet lit pill at rest, that lifts into a bubble on a press, slides stretching along its travel and settles. New bars use this.
- A title page takes a trace of its artwork's colour (`useArtTint`); Home stays on Krida's neutral page, since a slide that tints it reads as the page going red. Text and controls stay black and white; the colour is the artwork's, and the film's rim. What passes under a floating bar dims first (`BottomEdge`, the top nav's gradient), so nothing reads through a bar.
- Search is the same everywhere: a round bubble beside the places, that stretches into a field across the bar and grows its suggestions above it, your Library first. On a phone the places fold away for it and it rises with the keyboard. The Search page has its own field at the top.
- The Party panel floats in a corner over the page: opening it moves neither the page nor the dock, and you can see the page through it. Opening it starts nothing. A party begins when you invite someone (or press Start without inviting anyone), and they join from the invite.
- A card's right-click menu (`CardMenu`, `src/features/title/cardMenu.tsx`) names what the card can do. Wrap a new kind of card in it. Touch keeps the long press's peek, and Shift+right-click keeps the browser's menu.
- Phones lead with the picture. Home's banner and a title page run the art to the screen's edges behind the status bar, as Nuvio and Apple TV do, with the logo and facts centred and a full-width white Play under them; a round bubble beside Play holds More info, and a title's other actions are one toolbar under it. How far along you are is a bar as wide as Play, right above it, and a title's description and cast come after its buttons, left aligned. The tab bar is icons with no words under them, with search as its own bubble.
- Over video: bubbles draw over the picture with `bend` only on a pointer-driven screen. A touch player has three clear bubbles in the middle of the picture (back 10, play, forward 10), a timeline whose thumb is a bubble, and one capsule. Reduced transparency, no WebGL or a lost context turn every bubble into its plain look; reduced motion keeps the look and stops the movement.
- A bubble costs a little GPU only when something happens to it. Nothing repeated keeps one: a card's buttons are bubbles only while the card is under the pointer (`HoverFilm`), and a menu exists only from when it's opened until it's shrunk away. A control that isn't one of `ui.tsx`'s buttons takes `<Film />` as its first child.
- A phone held sideways (`short:` in styles.css) gets the tab bar as a rail at the left, never the desktop dock:
  the height is the scarce side there, and Play stays on the first screen. On touch, the picture behaves like
  every streaming app: a tap shows or hides the controls, with play and the 10-second skips in the middle of the
  picture where a thumb reaches them; a double tap on a side skips 10 seconds; holding and dragging the left side
  sets brightness and the right side volume; holding still plays at 2× until the finger lifts (alone, never in a
  party, which shares one clock); sliding sideways scrubs with the picture at that time; pinching fills the screen
  or fits it again; swiping up the middle goes full screen and turns the phone sideways, and it stays sideways from
  one episode to the next. Speed and picture in picture live in Playback, beside the automatic switches.
- Watching on a phone is always sideways. Play goes full screen and turns the phone where the browser allows it
  (Android); where it doesn't (iPhones, or rotation locked), the player turns itself a quarter turn on the upright
  screen and you turn the phone, as a sideways app looks. Everything in the room works in that turned frame: its
  gestures, timeline, panels and sheets (`ui/sideways.ts`; inside the room use `stage:`, not `md:`, and the
  `--safe-*` insets, not `env()`). The brightness and volume drags change the picture and the player's own volume:
  a web page can't reach the phone's backlight or system volume, so the phone's own controls still do that.
- Phones feel like an app: a bottom sheet can be dragged down to close, pressing the tab you're on goes back to the
  top, a gesture that took gives a short tick on Android, and installed on an iPhone (which has no browser back
  there) a swipe in from the left edge goes back.
- On a phone held upright, a row shows three posters and a sliver of the fourth, as Netflix does, and a search shows
  three across. The Library opens on tiles of what's in it. A long press on a poster opens its peek (Play, Details, Plan to watch, Rate): the actions a mouse
  finds by hovering, which touch otherwise had only on the title page. A tap still opens the title.
- Installed from the home screen, Krida behaves like an app: an iPhone opens on a dark launch screen, it says when
  you're offline instead of spinning, and it offers a reload when a newer build is live (never in the player).
  Settings → Display has Install where the browser allows it, and the Share steps on an iPhone.
- Earn its place. Show each fact once per screen (no year on the card and again beside it) and give each surface one
  main action. A source icon on every episode, or a pill for every filter, is noise.
- Reuse before you style. The same element looks the same everywhere: one source icon, one row style, one title font
  in the player, chat and party alike. Find the existing component before drawing a new one.
- A redesign is visibly different. When asked to redesign, show two directions as mockups or screenshots, not a
  restyle of what's there. Nuvio and Hayase are the bar.
