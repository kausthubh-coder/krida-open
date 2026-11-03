---
name: worktree-krida
description: "Make a Krida checkout run on its own port and its own Convex backend. Use at the start of every task in a new worktree, whenever install, .env.local, the port or the backend look wrong, and before giving a helper agent its own checkout."
---

# Krida worktrees

Each checkout runs alone: its own `node_modules`, its own dev port, and its own local Convex backend seeded with two QA profiles. Nothing here pushes functions to the shared dev deployment `fastidious-oyster-35`, so worktrees stop overwriting each other.

## Setup and doctor

- `npm run setup` copies `.env.local` from the main checkout (dev values only; with nothing to copy, as in a cloud session, it writes one naming the dev URLs and no keys), runs `npm ci` when needed, picks ports, creates the backend, links `.claude/skills` to `.agents/skills`, then runs the doctor. Rerun it any time; with nothing missing it takes about 15 seconds, most of it the doctor.
- `npm run doctor` checks the same things without changing anything. Each FAIL line names its fix.
- Healthy looks like every line PASS or INFO, ending with `Ready. npm run dev serves http://localhost:<port> on its own backend http://127.0.0.1:<port>.`

What setup keeps in `.krida.local/` (ignored by git): `worktree.json` (ports, QA password), `backend/` (the local deployment and its data), `dev.json` (what `npm run dev` started, while it runs).

## Running it

- `npm run dev` starts Vite and `convex dev` against this checkout's backend. Backend edits push there on save, and `convex/_generated` updates as usual.
- Sign in at `http://localhost:<port>/qa` as `Worktree-QA-one` or `Worktree-QA-two` (QA sign-in, no Clerk). The password is in `.krida.local/worktree.json`. The e2e scripts take them: `KRIDA_QA_PASSWORD=<password> node scripts/e2e-light.mjs http://localhost:<port> Worktree-QA-one`.
- The backend from the CLI: `node scripts/dev.mjs convex run profiles:list`, `… convex data <table>`, `… convex env set NAME value`.
- Stop: `node scripts/dev.mjs stop`.
- The local backend has none of the provider keys (TorBox, Simkl) and no addons, so playback and Simkl sync fail there. For those, `npm run dev -- --shared` runs the app against the dev backend (`fastidious-oyster-35`) from `.env.local` and pushes nothing. Plain `npx convex dev` pushes this branch's functions to the shared dev and replaces what other branches pushed. Run it only when I ask.

## Helper agents

One worktree and one backend per helper; never two agents in one checkout. Put it next to T3's worktrees:

```sh
M=$(git worktree list --porcelain | head -1 | cut -d' ' -f2)   # the main checkout
git -C $M fetch origin
git -C $M worktree add ~/.t3/worktrees/krida-open/<name> -b <branch> origin/main
cd ~/.t3/worktrees/krida-open/<name> && npm run setup
```

## The main checkout

The first checkout `git worktree list` prints stays on `main` and is never edited. `ship-krida` pulls it after a ship.

## Cleanup

- Stop only what you started: `node scripts/dev.mjs stop` for this checkout's dev, and anything else by the PID you captured.
- Remove a worktree only when its work is merged or I say so, and never one another live thread uses (`t3_thread_list`, compare `worktreePath`).
- To remove one, run `node scripts/dev.mjs remove` inside it. It stops dev, removes the `.claude/skills` link (which plain `git worktree remove` leaves behind as a stray folder), and removes the worktree with its backend data. Git still refuses one with uncommitted work. The branch stays; delete it with `git -C <main checkout> branch -d <branch>`.
