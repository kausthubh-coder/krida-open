# Library, stats and Wrapped verification

Verified on October 7, 2026 after merging main through `0b0137e`.

This note is from October 7; the Library has since become collections (Plan to watch, Watching, Watched, To rate, On hold, Dropped) with Stats beside them. Redesign notes and direction mockups: `docs/mockups/library-redesign.html`. Wrapped uses the selected scroll format with an all-time retrospective and a downloadable PNG. Stats supports all time and calendar years. Artwork, fonts, spacing, surfaces and controls reuse Krida's design system. Critly concepts applied: Visual Hierarchy, Design Tokens, Empty States, Interaction States, Overlays and Novelty Budget.

## Checks

| Result | Check |
| --- | --- |
| PASS | `npx tsc -b` and `npx tsc -p tsconfig.test.json --noEmit` |
| PASS | `npm test`: 232 tests across 15 files |
| PASS | `npx oxlint src convex`: no errors; existing warnings elsewhere in the app remain. No warnings in the new Library components or stats backend. |
| PASS | `npm run build`; Vite reports the existing large-chunk warning |
| PASS | `npx convex dev --once --typecheck enable` against an isolated local backend on port 3220, using an explicit local environment file |
| PASS | Real Chrome through `scripts/e2e-library.mjs`, with a disposable local Library QA profile and independent Convex query read-back |
| PASS | Rating saves, stable rows, undo, history removal and undo, keyboard scoring, persistence after reload |
| PASS | One episode of a long show excluded; local episodes supplement imported counts; rating preserves the imported diary date |
| PASS | Watching, Rewatching, On hold and Dropped; layouts at 320, 390, 768, 1100 and 1440 CSS pixels |
| PASS | Stats year selection and accessible monthly values; mobile stats; scrolling Wrapped, PNG download and focus restoration |
| PASS | T3 collaborative browser: empty Library/Stats/Wrapped, pending stats computation, long title, rejected save stays on the same rating card and shows an error |
| PASS | Regression cases for partial episode dates, duplicate episode identities, date-only marks across time zones, stale computations after corrections and rejected Simkl removals |
| NOT RUN | Shared Convex dev push, to avoid replacing another worktree's functions |
| NOT RUN | Production deployment, production Simkl re-import or changes to either friend's real watch history |

Browser artifacts are local and ignored under `.artifacts/library-qa/`: desktop/mobile stats, rating rows, mobile rating sheet, Wrapped and the downloaded PNG. Tests use synthetic history and no real provider credentials. Mobile checks verify responsive browser layouts, not native-device behavior.

## Repeating browser checks

Run the frontend against an isolated local Convex backend. Seed a disposable profile whose name contains `-QA-` (like `Library-QA-1`), with at least one unrated finished movie and other sample history. Set `KRIDA_QA_TOKEN` to that local session and `KRIDA_QA_CONVEX_URL` to the local backend, then run:

```sh
node scripts/e2e-library.mjs http://127.0.0.1:5187
```

The script refuses non-local URLs and other profile names. It resets its chosen title's rating and history correction in `finally`. The profile should be disposable because scoring a previously untracked movie can create watch history by design.

## Data and release notes

- Hours combine recorded playback and runtime estimates. Unknown runtime shares are visible. Bulk logging is detected heuristically and excluded from dated charts. Date-only records do not support clock insights.
- Imported episode identities and available dates are retained. Partial dates do not discard undated episodes. Older imports need the previously discussed one-time re-import after deployment to recover dates the parser used to discard.
- There is no complete session or rewatch ledger. Repeat viewings are not counted separately. Room overlap is labelled room presence and includes pauses.
- Friend agreement requires at least five shared scores. Metadata backfill is capped at 300 free addon lookups per computation.
- Corrections invalidate cached insights immediately. An older in-flight computation cannot restore removed history. Simkl removal uses the existing delayed outbox; Undo cancels unsent removal. Once a request may have reached Simkl, the UI tells the user to check Simkl before restoring it there.
- Additive schema fields preserve the live client contract. Deploy the combined backend before its frontend. The shared-dev coordination restriction remains in effect. Production merge/deploy and the real-profile re-import remain separate follow-up actions.
