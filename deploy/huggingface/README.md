# Hugging Face Spaces

Spaces that DataBounty publishes under the [databounty-io](https://huggingface.co/databounty-io) organisation.
Each subfolder is the complete contents of one Space repository, including its Space card (`README.md` with the
Hub's YAML front matter).

## `databounty/` → `databounty-io/DataBounty`

A read-only Gradio Space that shows DataBounty's live pools, published datasets, karma leaderboard and public
profiles, and doubles as a read-only MCP server at `/gradio_api/mcp/`. It reads only DataBounty's public API and
the Hub. It holds no secrets, no database and no visitor data, and it runs on free `cpu-basic` hardware.

**Deploy** (from the repository root, logged in with a token that can write to `databounty-io`):

```bash
hf upload databounty-io/DataBounty deploy/huggingface/databounty . \
  --repo-type space --exclude "**/__pycache__/**" --exclude ".gradio/**"
hf spaces logs databounty-io/DataBounty --build --follow
```

`--repo-type space` is required: without it `hf upload` targets, and silently creates, a model repo.

**Configuration** (optional Space variables; the defaults point at production):

| Variable | Default |
|---|---|
| `DATABOUNTY_API_URL` | `https://api.databounty.io` |
| `DATABOUNTY_SITE_URL` | `https://databounty.io` |
| `DATABOUNTY_APP_URL` | `https://console.databounty.io` |
| `DATABOUNTY_HF_ORG` | `databounty-io` |
| `CACHE_TTL_SECONDS` | `120` |

**Run locally**: `pip install "gradio[mcp]==6.30.0"`, then `python app.py` from `databounty/`. On Windows, set
`PYTHONUTF8=1` first: Gradio prints an emoji at start-up that a cp1252 console cannot encode.

**Keep in sync**

- `sdk_version` in `databounty/README.md` pins Gradio. Bump it deliberately and re-test.
- The `datasets:` list in `databounty/README.md` is static. Add each newly published dataset so the Hub
  cross-links it with the Space.
- Profiles come only from `/v1/profiles/handle/:handle`, which hides private profiles and hidden fields. Do not
  switch to `/v1/community/members/:handle`: it returns members whose profile is private as long as they have a
  handle, and it ignores the per-field privacy preferences.
- Do not name a Space `README` in this organisation. That name is the org profile card, which
  `apps/api/src/lib/publication/hugging-face.ts` rewrites after every dataset publish.
