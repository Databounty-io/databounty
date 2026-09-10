## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- The problem being solved. Link the issue if there is one: Fixes #123 -->

## Apps touched

- [ ] `apps/api`
- [ ] `apps/web`
- [ ] `apps/admin`
- [ ] `apps/landing`
- [ ] Docs / CI only

## How you verified it

<!-- Required. "Should work" is not a verification.
     If a user can see it: which page you loaded and what you observed.
     If it is API behavior: the request you sent and the response you got. -->

Ran in **each app I touched**:

- [ ] `npm run typecheck`
- [ ] `npm run lint` (frontends — `apps/api` has no eslint config)
- [ ] `npm run build`
- [ ] `npm test` (`apps/api` only — against the disposable `databounty_community_parity_verify` database)

## Checks

- [ ] Any Prisma schema change ships with its migration **in this PR**
- [ ] No build output, `node_modules`, or `.env` file in the diff
- [ ] No new wallet / payment / escrow / payout / on-chain code
- [ ] Every validation or trust claim reflects what actually ran — nothing reports passed when it was
      skipped, unsupported, unconfigured, or stale
- [ ] New user-visible async actions have a loading state **and** an error state
- [ ] New list endpoints filter and paginate server-side
- [ ] Reused the existing shared components and `lib/api-*` clients rather than hand-rolling
- [ ] Commit messages carry no AI attribution (no `Co-Authored-By` for an assistant, no 🤖)
- [ ] Every commit carries a DCO sign-off — `git commit -s` (CI enforces this)

## Credit

By default you are credited in [`CONTRIBUTORS.md`](../CONTRIBUTORS.md) and the release notes when this
merges. Nothing to do — a maintainer adds you.

- [ ] Please **do not** list me (tick only if you would rather not be credited; your commit stays in
      git history either way)

## Anything reviewers should know

<!-- Known gaps, deliberate omissions, follow-up work, or a decision you want challenged.
     Pre-existing failures you did NOT cause: say so here rather than absorbing them silently. -->
