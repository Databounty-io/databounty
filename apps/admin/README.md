# DataBounty Community Admin

The operator console for DataBounty Community: review and approve/decline community dataset requests, moderate
flags and disputes, manage validators/users, and edit platform settings (e.g. the karma-hold toggle
`community.karma_holds.enabled` referenced in [../../DEPLOYMENT.md](../../DEPLOYMENT.md)). Next.js app talking
to `apps/api` over HTTP; it has no direct database access.

See the [top-level README](../../README.md) for the overall four-app architecture.

Note the malware-scan toggle is **not** among them: `artifacts.malware_scan.enabled` is read straight from the
`admin_settings` table by `apps/api/src/services/artifact-scanner.ts`, but it is not in the API's validated
settings catalog and has no admin route or UI, so it can only be set by writing the row directly. Documented
gap, not a console feature.

## Running standalone

```bash
npm install
cp .env.example .env   # fill in NEXT_PUBLIC_API_URL and the sibling-app URLs at minimum
npm run dev
```

`apps/api` must be reachable at `NEXT_PUBLIC_API_URL`, and its `CORS_ORIGINS` must include this app's origin.

This is an ordinary served Next.js app: `npm run build` then `npm start` (`next start`). Set
`NEXT_OUTPUT=standalone` at build time to emit `.next/standalone` instead (what `Dockerfile` uses), or
`NEXT_OUTPUT=export` for a static `out/` directory. Detail pages read their id from a query param
client-side rather than a dynamic route segment, which keeps the `export` mode workable and matches the
V1 admin route shape. `NEXT_PUBLIC_*` values are baked into the client bundle at **build** time in every
mode, so they must be correct then.

Other scripts: `npm run lint`.

## Port

Dev server port: `3002` (`npm run dev` runs `next dev -p 3002`).

This app pins `next` to exactly `16.3.4` (so does `apps/landing`); `apps/web` floats `^16.2.12`, which
currently resolves to that same `16.3.4`. There is no root `package.json` and no npm workspace, so each app
installs into its own `node_modules` from its own `package-lock.json` and nothing is hoisted between them —
`npx next` from this directory resolves this app's own binary. (An earlier revision of this note described a
cross-app `next` hoisting failure returning HTTP 500 on every route. It does not apply to this layout and is not
reproducible, so it has been removed. `./node_modules/.bin/next --version` is still the quickest way to confirm
which binary actually ran.)

## Environment variables

See [`.env.example`](.env.example) for the full list.

| Variable | Required? | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | **Yes** | Base URL of `apps/api`. |
| `NEXT_PUBLIC_DASHBOARD_URL`, `NEXT_PUBLIC_ADMIN_URL`, `NEXT_PUBLIC_LANDING_URL` | Effectively yes | Used to build links to this app itself and the other two frontends. |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | No | Enables Google sign-in for admin login. Unset → the sign-in UI reports it is not configured rather than faking a signed-in session. |
| `NEXT_OUTPUT` | No | Set to `standalone` or `export` to change the build output mode. Leave unset for a normal `next start` server. |

---

Reference documentation: [Configuration](../../docs/configuration.md) (the 29 runtime settings this console edits) · [Architecture](../../docs/architecture.md)
