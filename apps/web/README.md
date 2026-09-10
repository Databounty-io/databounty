# DataBounty Community Web

The logged-in DataBounty Community dashboard: sponsor bounty/request creation, contributor submission flow,
validator audit queues, karma/profile, notifications. Next.js app talking to `apps/api` over HTTP.

See the [top-level README](../../README.md) for the overall four-app architecture, and
[../../DEPLOYMENT.md](../../DEPLOYMENT.md) for production build/deploy notes.

## Running standalone

```bash
npm install
cp .env.example .env   # fill in NEXT_PUBLIC_API_URL and the sibling-app URLs at minimum
npm run dev            # binds to whatever `npm run dev` defaults to (see Port note below)
```

`apps/api` must be reachable at the URL you set for `NEXT_PUBLIC_API_URL`, and its `CORS_ORIGINS` must include
whichever origin this app is actually served from, or API requests will be blocked by the browser.

Other scripts: `npm run build` (`next build`), `npm start` (`next start`), `npm run lint`.

## Port

This app's own `package.json` `dev` script defaults to port **`53000`** (`next dev -p 53000`). Any port works;
just pass `-- -p <port>` to `npm run dev` (or edit the script) and make sure `NEXT_PUBLIC_DASHBOARD_URL` and
`apps/api`'s `CORS_ORIGINS`/`APP_URL` agree with whatever you choose.

Note `apps/api`'s own `APP_URL` default is `http://localhost:3010`, not `53000`, so if you run this app on its
default port set `APP_URL=http://localhost:53000` on the API (as `apps/api/.env.example` does) or the links the
API builds into emails and notifications will point at a port nothing is listening on.

## Environment variables

See [`.env.example`](.env.example) for the full, current list with defaults. Summary:

| Variable | Required? | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | **Yes** | Base URL of `apps/api`. |
| `NEXT_PUBLIC_DASHBOARD_URL`, `NEXT_PUBLIC_ADMIN_URL`, `NEXT_PUBLIC_LANDING_URL` | Effectively yes | Used to build links to this app and the other two frontends (e.g. "go to admin" / "view public profile"). |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | No | Enables Google sign-in. Unset → the sign-in UI shows an explicit "not configured" message rather than a broken or silently non-functional button (`components/auth.tsx:105-108`). |
| `NEXT_PUBLIC_MAX_UPLOAD_BYTES`, `NEXT_PUBLIC_DIRECT_UPLOAD_TIMEOUT_MS` | No | Direct (non-multipart) artifact upload size cap and timeout. Defaults: 100 MB, 16 minutes. |
| `NEXT_PUBLIC_MULTIPART_THRESHOLD_BYTES`, `NEXT_PUBLIC_MULTIPART_PART_SIZE_BYTES`, `NEXT_PUBLIC_MULTIPART_PART_CONCURRENCY`, `NEXT_PUBLIC_MAX_MULTIPART_UPLOAD_BYTES` | No | Multipart (chunked) upload tuning for large artifacts. Defaults: switch to multipart above 100 MB, 16 MB parts, 4 parts in flight, 5 GB hard cap. |
| `NEXT_OUTPUT` | No | Set to `standalone`, or `export` for a static `out/` directory (supported by this app and `apps/admin`, but not `apps/landing` — see each app's `next.config.ts`). Leave unset for a normal `next start` server. Note `export` drops this app's `/mcp/*` proxy rewrite and its response headers, both of which need a server runtime. |

All variables here are read via `process.env.NEXT_PUBLIC_*` at build time and are visible in the shipped client
bundle — do not put secrets in this app's `.env`.

---

Reference documentation: [Architecture](../../docs/architecture.md) · [REST API](../../docs/api.md)
