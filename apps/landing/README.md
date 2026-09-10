# DataBounty Community Landing

The public marketing site for DataBounty Community: home page, dataset catalog (`/open`), public contributor
profiles, docs/how-it-works pages. Next.js app talking to `apps/api` over HTTP for public, unauthenticated data
only (catalog listings, public profile data) — it holds no session and performs no writes.

See the [top-level README](../../README.md) for the overall four-app architecture.

## Running standalone

```bash
npm install
cp .env.example .env   # fill in NEXT_PUBLIC_API_URL and the sibling-app URLs at minimum
npm run dev            # http://localhost:3001
```

`apps/api` must be reachable at `NEXT_PUBLIC_API_URL`, and its `CORS_ORIGINS` must include this app's origin for
any client-side fetches to succeed (server-side rendering calls are not subject to browser CORS, but any
client-side data fetch is).

Other scripts: `npm run build` (`next build`), `npm start` (`next start`), `npm run lint`.

> **Known gap — the lockfile is behind `package.json`.** `package.json` requires `next` and
> `eslint-config-next` at `16.3.4`, but `package-lock.json` still pins `16.2.10` for both. `npm ci` rejects that
> mismatch, so use `npm install` here (which will update the lockfile) until the lockfile is regenerated and
> committed. This is a repository gap, not a configuration step you got wrong.

## Port

`3001` by default (`npm run dev` runs `next dev -p 3001`). Pass `-- -p <port>` to `npm run dev` to change it,
and keep `NEXT_PUBLIC_LANDING_URL` and `apps/api`'s `CORS_ORIGINS` in step with whatever you choose — public
profile URLs are built from `NEXT_PUBLIC_LANDING_URL`.

## Environment variables

See [`.env.example`](.env.example) for the full list.

| Variable | Required? | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | **Yes** | Base URL of `apps/api`, used for public catalog/profile data. |
| `INTERNAL_API_URL` | No | Private server-runtime API URL for SSR; defaults to `NEXT_PUBLIC_API_URL`. Use `http://api:4000` in Docker. |
| `NEXT_PUBLIC_DASHBOARD_URL`, `NEXT_PUBLIC_ADMIN_URL`, `NEXT_PUBLIC_LANDING_URL` | Effectively yes | Used to build links to the dashboard (e.g. "sign in" / "submit"), the admin console, and this app itself. |
| `NEXT_OUTPUT` | No | Set to `standalone` to change the build output mode. Leave unset for a normal `next start` server. |

This app also sets a fixed set of security response headers (`Strict-Transport-Security`, `X-Content-Type-Options`,
`Referrer-Policy`, `X-Frame-Options`, `Content-Security-Policy: frame-ancestors 'none'`) in `next.config.ts` —
not environment-configurable, listed here for completeness.

## Public contact

The public footer links to [`support@databounty.io`](mailto:support@databounty.io) for support, correction, and
withdrawal requests. This is a static public contact address; it is not an API endpoint and must not be used for
credentials, dataset artifacts, or other sensitive material.

---

Reference documentation: [Architecture](../../docs/architecture.md)
