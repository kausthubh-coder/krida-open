---
name: ship-krida
description: "Take verified Krida work to production and leave main, the main checkout and the worktree list clean. Use only when I say ship, deploy, release, or merge and deploy."
---

# Ship Krida

Krida is a personal project: work lands straight on `main`, with no PR. Pushing `main` deploys everything. Vercel builds it with `scripts/vercel-build.mjs`, which runs the tests, then `convex deploy` to production (`industrious-axolotl-949`), then builds the frontend. So the backend always goes out before the frontend that needs it. Krida's apps (Windows, Mac, Android) show that live site, so they need a release only when their own folder changed: step 5.

Push only `main`. Every other branch pushed to GitHub gets a Vercel preview, and each preview claims a Convex deployment out of the team's 40.

**Rules**
- Production needs my go in this conversation. "Ship" is that go for every step below, including cleanup: don't stop to ask between steps.
- When a step fails because of this change (a deploy limit, a failing check), fix it, rerun the checks and carry on. Stop and tell me only when the cause is outside the change or the fix needs my decision.
- Never end the turn while a build or deploy you started is still queued or running: watch it to the end.
- Never force-push, skip a check or raise the oxlint warning cap to get through.
- A rehearsal ("dry run") walks every step but prints the push, the deploy watch and the branch deletes instead of running them.
- In a cloud session (AGENTS.md, "Cloud sessions") the steps are the same, in bash, except where a step says "Cloud".

## 1. Ready

Run these in the worktree, in Git Bash:

```sh
git status --porcelain                    # must print nothing
git fetch origin && git rebase origin/main
npm run check                             # CI's steps; reinstalls deps, takes minutes
git log --oneline origin/main..HEAD       # what's going out
git diff --stat origin/main..HEAD -- convex
```

- Every commit going out is authored by me: `git log --format=%ae origin/main..HEAD` prints only my email, the one Vercel's project belongs to. Vercel's Hobby plan doesn't deploy a commit by anyone else, so it would land on `main` and never go live. Cloud sessions commit as Claude unless `scripts/cloud.mjs` set the repo's git author; fix authors before pushing (`git rebase origin/main --exec 'git commit --amend --no-edit --reset-author'` on unpushed commits).
- Every changed feature was driven in the app and has evidence in this thread (screenshots, script output). Use `verify-krida`, and run `npm run regress` when the change should look the same.
- `npm run release -- "notes" --dry-run` says which apps this change will need released after landing (step 5). A change to `desktop/` or `android/` must have run in that app first (`verify-krida`, "The apps"); for updates themselves, `scripts/e2e-android-update.ts` and `scripts/e2e-desktop-mac-update.ts`.
- If `convex/` changed, the change must work with the live frontend (optional fields, old signatures kept; `docs/ops.md`). Real people may be watching during the deploy.
- Write the rollback down before going on:
  - `PREV=$(git rev-parse origin/main)`, the commit production runs now.
  - Rolling back means `git revert --no-edit $PREV..origin/main`, `npm run check`, then `git push origin HEAD:main`. That redeploys both Convex and the frontend.
  - For a frontend-only change, Vercel's Instant Rollback to the previous production deployment is faster. It leaves Convex as it is.
  - If the change added a required schema field, a revert can fail to deploy over the new data. Say so before shipping.

## 2. Land

```sh
git push origin HEAD:main
```

If it's rejected because `main` moved, fetch, rebase and go back to step 1.

## 3. Deploy

Deploying happens on the push. Watch Vercel's status on the commit, giving up after 15 minutes:

```sh
SHA=$(git rev-parse HEAD); end=$((SECONDS+900))
until s=$(gh api repos/kausthubh-coder/krida-open/commits/$SHA/status -q '[.statuses[]|select(.context=="Vercel")][0].state'); [ "$s" = success ] || [ "$s" = failure ] || [ "$s" = error ] || [ $SECONDS -ge $end ]; do sleep 15; done; echo "Vercel: $s"
gh api repos/kausthubh-coder/krida-open/commits/$SHA/status -q '.statuses[] | .context+" "+.state+" "+.target_url'
gh run list --commit $SHA                 # Checks on main runs too; report it
```

On failure, read the `target_url`'s build log. If the failure comes from this change, fix it, rerun step 1 and push again; otherwise give me the `target_url`. If the build failed after `convex deploy`, production runs the new backend under the old frontend until it's fixed or rolled back.

Cloud: GitHub's statuses, checks and Actions answer 403 there, so watch what production serves instead. Each build writes the commit it built to `/version.json`:

```sh
SHA=$(git rev-parse HEAD); end=$((SECONDS+900))
until c=$(curl -s https://krida-open.vercel.app/version.json | grep -o '[0-9a-f]\{40\}'); [ "$c" = "$SHA" ] || [ $SECONDS -ge $end ]; do sleep 20; done; echo "live: ${c:-none}"
```

Live means the deploy finished. After 15 minutes without it, the build failed or is stuck: say so, and list reading the Vercel build log as a step for my machine.

## 4. Check production

These reads never write:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://krida-open.vercel.app/
js=$(curl -s https://krida-open.vercel.app/ | grep -o '/assets/index[^"]*\.js' | head -1); echo $js
curl -s "https://krida-open.vercel.app$js" | grep -c '<a string the change added>'
npx convex function-spec --prod           # only if convex/ changed: the new function is listed
```

The bundle name must differ from the one before the push. Don't sign in on production; you don't have the password.

## 5. Release the apps

Only when `desktop/` or `android/` changed since their last release; otherwise skip. On the Mac mini, in the
worktree, now that `main` has the change:

```sh
git fetch origin && git reset --hard origin/main   # the worktree's branch has no commits of its own after landing
npm run release -- "What's new, one line people will read" --no-windows
```

- It bumps the versions, builds and signs each app, publishes them to the public `kausthubh-coder/krida-open-releases`,
  then commits the versions, tags them and pushes `main` (which deploys again; that build changes nothing people
  see). Watch that deploy as in step 3.
- `--no-windows` releases the Mac app alone, as open Krida does until Windows is built on the laptop. Adding
  Windows to that release afterwards is `node scripts/release.ts --add-windows`, on the laptop (`docs/desktop.md`,
  "Windows, built last on the laptop"). List it under "Needs you" in the report rather than running it.
- The notes show in each app once it updates ("What's new"). Write them for the people using it, like a button
  label: what they'll notice, not what changed in the code.
- It prints what `latest.json` and `android.json` say afterwards: each must name the new version. Installed apps take
  it within 6 hours or at their next start. Then check the landing page's downloads point at the new files:
  `curl -s "https://api.github.com/repos/kausthubh-coder/krida-open-releases/releases?per_page=5" | grep browser_download_url`
  and `curl -sIL` each `.dmg` and `.apk` link (200).
- Needs open Krida's keys in `~/.krida-open`: `krida-open-updater.key`, and for Android `krida-open-release.jks` and
  `android-signing.properties`. Never private Krida's `~/.krida`. If one is missing, it stops before changing
  anything: tell me which.
- If it fails after publishing, the release exists but the version commit doesn't. Fix forward: push the version
  files and tags it left in the worktree (`git status`, `git tag --points-at HEAD`), or delete the release
  (`gh release delete <tag> --repo kausthubh-coder/krida-open-releases --cleanup-tag`) and run it again.
- Cloud: skip this step and list it in the report; it needs the Mac mini.

## 6. Update the main checkout

```sh
M=$(git worktree list --porcelain | head -1 | cut -d' ' -f2)   # the main checkout
git -C $M status --porcelain; git -C $M branch --show-current
```

If it's clean and on `main`, run `git -C $M pull --ff-only`, then `npm run setup` in `$M`. If it's dirty or on another branch, leave it alone and tell me.

Cloud: the main checkout is on my machine. Skip this step and list it in the report.

## 7. Clean up

- If the branch was ever pushed: `git push origin --delete <branch>`.
- If no other live thread uses this worktree (`t3_thread_list`), remove it as the last command: `node scripts/dev.mjs remove`, then `git -C $M branch -d <branch>`. Otherwise just `node scripts/dev.mjs stop`.
- List other worktrees whose branch is already in `origin/main` (`git -C $M worktree list`, `git -C $M branch --merged origin/main`) and name them in the report. Don't remove them.
- Cloud: the session expects its own branch on GitHub. Push it only now, at the shipped commit (`git push -u origin HEAD:<session branch>`), and keep it: the VM goes away with the session, so there's no worktree to remove. Stop what you started (`npm run qa -- down`, `node scripts/dev.mjs stop`).

## 8. Report

A few lines: the commits that shipped, the Vercel deployment URL, what the production check saw, the apps released (versions, release links) or why none needed one, the rollback command, and anything skipped or left over. An app release can't be rolled back: a fix goes out as the next version.
