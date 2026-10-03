---
name: deploy-new-version
description: Use when the user asks to ship, release or deploy a new version of Drift Rally to production — "выкати релиз", "выпусти новую версию", "залей в master / в прод", "слей ветку в релиз", "подними версию", "обнови changelog и тег", "deploy new version".
---

# Deploy a new version of Drift Rally

## Overview

Production is GitHub Pages: every push to `master` runs `.github/workflows/deploy.yml` (`npm ci`, `npm test`,
`npm run build`, deploy). A release = finished features merged into `develop`, a release commit on `develop`,
`develop` merged into `master`, an annotated tag, a GitHub Release. (v0.3.0 and v0.4.0 made the release commit on
`feature/v1-game` and merged it on to `develop`; features now branch from `develop`, so it goes on `develop`.)

Work in the main checkout (`/Users/algavkovskii/programming/rally`) as long as `develop` and `master` are not
checked out in another worktree (`git worktree list`). Note the branch it is on: that is where you return at the
end. Commit messages are English (Conventional Commits); the changelog, tag message and release title are Russian.

**Push, tag and GitHub Release are public.** Run this only when the user asked for a release. Never force-push,
never move or delete a pushed tag, never rewrite pushed history of `master` or `develop`.

## Stop and ask when

- the feature branch does not exist or has uncommitted work (`git -C .claude/worktrees/<name> status`);
- the checkout you release from has modified tracked files (untracked files that no branch touches are fine), or
  local `master`/`develop` differ from `origin` and `git pull --ff-only` fails;
- a trial merge conflicts in code: `git merge-tree --write-tree develop feature/<name>` (writes only unreferenced
  objects) lists conflicted files. The branch was tested without what `develop` gained since it forked, so the
  merge result is untested: the branch owner merges `develop` into it in its worktree, re-tests, then you release.
  A conflict in `CHANGELOG.md` alone you resolve yourself (step 2);
- it is unclear which branches ship, or `## [Unreleased]` in `CHANGELOG.md` does not describe them;
- `git log --oneline origin/develop..develop` shows local commits nobody mentioned: everything there ships;
- any check in step 5 fails: nothing is pushed yet, so drop the local release merge
  (`git switch master && git reset --hard origin/master`), fix on `develop`, start again from step 3.

## Pipeline

**0. Sync.** `git fetch origin --prune --tags`; `git status` clean; then
`git switch master && git pull --ff-only` and `git switch develop && git pull --ff-only`.

**1. Version.** SemVer `0.MINOR.PATCH` from `git describe --tags --abbrev=0 origin/master`: MINOR for new features
or noticeable gameplay changes, PATCH for fixes only.

**2. Merge what ships into `develop`**, one branch at a time, `--no-ff`, default merge message:
`git switch develop && git merge --no-ff feature/<name>`. A merge brings the branch's ancestors too, so a branch
built on `feature/v1-game` needs nothing extra; merge `feature/v1-game` itself only if it holds unreleased commits
that should ship (`git log --oneline develop..feature/v1-game`). Check what will ship: `git log --oneline master..develop`.

Feature branches live in worktrees (`.claude/worktrees/<name>`): a branch checked out there cannot be switched to,
but it can be merged by name. Do not remove, reset or commit in other agents' worktrees. A `CHANGELOG.md` conflict:
keep released sections as they are, put the new entries under `## [Unreleased]`.

**3. Release commit on `develop`.**
- `package.json`: `"version"` by hand. Not `npm version` (it tags the wrong branch); `package-lock.json` stays as is.
  The garage corner shows this version (Vite `__APP_VERSION__`).
- `CHANGELOG.md` (Russian, player-facing, sections `Добавлено` / `Изменено` / `Исправлено`): rename
  `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD`, add an empty `## [Unreleased]` above it, update the links at the
  bottom: `[Unreleased]: …/compare/vX.Y.Z...HEAD` and a new `[X.Y.Z]: …/compare/v<previous>...vX.Y.Z`.
- `git commit -m "chore(release): vX.Y.Z"` (body: one line on what ships).

**4. `develop` into `master`.**
`git switch master && git merge --no-ff develop -m "Merge branch 'develop' into master: release vX.Y.Z"`

**5. Verify the exact commit that ships** (on `master`; CI runs only test and build):
`npm run typecheck && npm test && npm run build && npm run e2e:software`, and
`grep -o '"X.Y.Z"' dist/assets/index-*.js`. If e2e reports port 4173 in use, another agent's preview holds it: do
not kill it; run Playwright from a temporary copy of `playwright.config.ts` on another port, then delete the copy.

**6. Tag and push.**
`git tag -a vX.Y.Z -m "vX.Y.Z — <коротко, по-русски>"` on the `master` merge commit, then
`git push --atomic origin master develop vX.Y.Z` (add `feature/v1-game` if it changed). Feature branches need not be
pushed: their commits travel in the merges.

**7. Watch the deploy.** `gh run list --commit "$(git rev-parse master)"` (right after the push, `--limit 1` can
still show the previous release's run; retry until it appears), then `gh run watch <id> --exit-status`.

**8. GitHub Release, once the deploy is green.**
```bash
# $(...) drops the section's trailing blank line: the empty line below puts it back.
notes="$(awk '/^## \[X\.Y\.Z\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md)

Играть: https://sachayt1.github.io/drift-rally/"
gh release create vX.Y.Z --verify-tag --latest --title "vX.Y.Z — <коротко, по-русски>" --notes "$notes"
```

**9. Live check.** The site serves the new version:
```bash
js=$(curl -s https://sachayt1.github.io/drift-rally/ | grep -o 'assets/index-[^"]*\.js' | head -1)
curl -s "https://sachayt1.github.io/drift-rally/$js" | grep -o '"X.Y.Z"'
```

**10. Tidy up.** Delete the feature branches merged for this release that no worktree has checked out
(`git branch -d feature/<name>`). A branch checked out in a worktree cannot be deleted: leave it and the worktree
unless the user asks (`git worktree remove .claude/worktrees/<name>`,
then `git branch -d`). Switch back to the branch you started on. Report: version, tag, release URL, deploy run,
live check.

## If something breaks after the push

Fix forward: a fix on `develop`, a PATCH release through the same pipeline. Do not revert by force-pushing or
re-tagging.

## Common mistakes

| Mistake | Instead |
|---|---|
| Testing the feature branch, not the merge on `master` | Step 5 runs on `master` after the merge |
| Resolving code conflicts in the release merge | Owner merges `develop` into the branch and re-tests first |
| `npm version` | Edit `package.json` by hand |
| Release created before the deploy finished | Release after `gh run watch` is green |
| Changelog entry in English or about code internals | Russian, what the player sees |
| Killing the process on port 4173 | Run e2e on another port |
| Leaving an empty `## [Unreleased]` out | Keep it on top for the next release |
