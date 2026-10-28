# Hugging Face Spaces

Spaces that DataBounty publishes under the [databounty-io](https://huggingface.co/databounty-io) organisation.
Each subfolder is the complete contents of one Space repository, including its Space card (`README.md` with the
Hub's YAML front matter).

## `databounty/` → `databounty-io/DataBounty`

A Space that shows DataBounty's live pools, published datasets, karma leaderboard and public profiles, and lets a
person sign in to DataBounty to add items to open pools, review other people's, and see the items in pools they
requested, as themselves. Its page is a small web app drawn like the
DataBounty console (`web/`: `index.html`, `app.css`, `app.js`, no build step), backed by a JSON API (`webapi.py`).
Gradio is mounted underneath only for the Space's MCP server at `/gradio_api/mcp/`: six browse tools, and seven
that act as the owner of a DataBounty API key (`agent_tools.py`): five submit items, two serve a pool's sponsor. The key comes in the `X-DataBounty-Key`
header, read with `gr.Header`, so it is never a tool argument the model sees. Keep the header parameter last in
each tool's signature: Gradio writes its value at that position. It has no database: browsing
reads only DataBounty's public API and the Hub, and a signed-in person's tokens live in the process's memory. It runs
on free `cpu-basic` hardware.

How signing in works:

- The Space is an OAuth public client of DataBounty's MCP authorization server. It identifies itself with a Client
  ID Metadata Document it serves at `/oauth/client-metadata.json`, so there is nothing to register and no client
  secret. `app.py` serves that route, `/oauth/start` and `/oauth/callback` next to the page and its API.
- The page keeps a random secret in its sessionStorage and starts at `/oauth/start?n=<sha256 of the secret>`.
  `/oauth/start` refuses anything but a start from the Space's own page (`Sec-Fetch-Site: same-origin`), then puts the
  `state`, the PKCE verifier and the hash in a signed, httpOnly, `SameSite=Lax` cookie. `/oauth/callback` only accepts
  a `state` that matches it, so nobody can start a sign-in and have someone else finish it into their session.
- The callback holds the new session under the hash for five minutes, and the page claims it with the secret itself
  (`POST /api/session/claim`, `account.claim_sign_in`). The page keeps the session handle in its localStorage and
  sends it as a bearer token, because inside the huggingface.co embed the Space's cookies are third-party and most
  browsers withhold them. The handle is random; the tokens it stands for never leave the Space.
- At its own address the Space signs in in the same tab. The embed's sandbox allows windows but not leaving the page
  (no `allow-top-navigation`), and DataBounty's sign-in pages refuse to be framed, so there it opens a small sign-in
  window and polls `/oauth/status?n=<hash>` until the sign-in finishes. The window closes itself.
- Tool calls use the stateless MCP protocol (`2026-07-28`) against `https://console.databounty.io/mcp`, so there is
  no MCP session to expire.

**Deploy** (from the repository root, logged in with a token that can write to `databounty-io`):

```bash
hf upload databounty-io/DataBounty deploy/huggingface/databounty . \
  --repo-type space --exclude "__pycache__/**" --exclude "**/__pycache__/**" --exclude ".gradio/**"
hf spaces logs databounty-io/DataBounty --build --follow
```

`--repo-type space` is required: without it `hf upload` targets, and silently creates, a model repo. Keep both
`__pycache__` excludes: `**/__pycache__/**` does not match the folder at the top level, so a local run's bytecode
would be uploaded with it.

**Configuration** (optional Space variables; the defaults point at production):

| Variable | Default |
|---|---|
| `DATABOUNTY_API_URL` | `https://api.databounty.io` |
| `DATABOUNTY_SITE_URL` | `https://databounty.io` |
| `DATABOUNTY_APP_URL` | `https://console.databounty.io` |
| `DATABOUNTY_HF_ORG` | `databounty-io` |
| `CACHE_TTL_SECONDS` | `120`. How long public data counts as fresh. |
| `CACHE_MAX_STALE_SECONDS` | `3600`. How long older public data is still served at once while it refreshes in the background. |
| `DATABOUNTY_MCP_URL` | `https://console.databounty.io/mcp` |
| `SPACE_PUBLIC_URL` | `https://$SPACE_HOST` (Hugging Face sets `SPACE_HOST`) |
| `SPACE_COOKIE_SECRET` | random per start. Set it as a Space **secret** so sign-ins in flight survive a restart. |
| `DATABOUNTY_CLIENT_ID` | the metadata-document URL. Local runs only; see below. |

**Run locally**: `pip install "gradio[mcp]==6.30.0"`, then `python app.py` from `databounty/`. It serves on
`GRADIO_SERVER_PORT` (default 7860). The page's CSS and script are loaded with a `?v=` version in `web/index.html`;
bump it when you change them, so browsers fetch the new files. On Windows, set `PYTHONUTF8=1` first: Gradio prints an emoji at start-up that a
cp1252 console cannot encode.

To sign in locally, point the Space at a local API (`DATABOUNTY_MCP_URL=http://localhost:4000/mcp`,
`SPACE_PUBLIC_URL=http://127.0.0.1:7860`). DataBounty refuses to fetch a metadata document from localhost, so
register a client instead: `POST /mcp/oauth/register` with `redirect_uris: ["http://127.0.0.1:7860/oauth/callback"]`
and a `client_name` that does not contain "databounty". Then set `DATABOUNTY_CLIENT_ID` to the returned id.

**Tests**: `python -m unittest discover -s deploy/huggingface/tests` from the repository root. The tests live outside
`databounty/`, so they are never uploaded to the Space.

**Keep in sync**

- `sdk_version` in `databounty/README.md` pins Gradio. Bump it deliberately and re-test.
- The `datasets:` list in `databounty/README.md` is static. Add each newly published dataset so the Hub
  cross-links it with the Space.
- Profiles come only from `/v1/profiles/handle/:handle`, which hides private profiles and hidden fields. Do not
  switch to `/v1/community/members/:handle`: it returns members whose profile is private as long as they have a
  handle, and it ignores the per-field privacy preferences.
- `items.py` mirrors the API's field rules (`apps/api/src/services/item-contract.ts`) and bulk-file parsing
  (`services/jobs/bulk-source-parse.ts`). Change them together.
- The metadata document must answer with a plain 200 JSON response. If the Space is asleep or rebuilding, DataBounty
  can't fetch it, and sign-ins fail with `invalid_client` until the Space is back. DataBounty caches the failure for
  60 seconds.
- Every visitor shares one OAuth client, so code exchanges and refreshes share DataBounty's token-endpoint budget of
  60 a minute per client (`MCP_TOKEN_RATE_LIMIT_PER_MIN`).
- Do not name a Space `README` in this organisation. That name is the org profile card, which
  `apps/api/src/lib/publication/hugging-face.ts` rewrites after every dataset publish.
