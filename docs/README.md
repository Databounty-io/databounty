# DataBounty Community — Documentation

Reference documentation for people **running, configuring, or integrating with** DataBounty Community.

Start with the [project README](../README.md) if you want to know what this software *is*, and
[DEPLOYMENT.md](../DEPLOYMENT.md) for build commands and the Docker path. This folder covers everything
after that.

| Document | Read it when you want to |
|---|---|
| [Architecture](architecture.md) | Understand how the four apps, the in-process background workers, and the validation pipeline fit together before changing anything. |
| [Configuration](configuration.md) | Set environment variables correctly. The API reads **81**; this documents **43** of them — what each does and what breaks when it is unset — plus the **30** runtime settings that live in the database instead. The remaining **38 are being written up next** — for those, `apps/api/src/config.ts` is the source of truth today, and it declares each one in place with its default. They cover the Hugging Face and GitHub publication credentials, `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD`, the cookie and database-pool settings, the MCP and API-key rate limits, and the background sweep intervals. |
| [Self-hosting](self-hosting.md) | Take it from empty database to serving traffic, then keep it running — first run, seeding, upgrades, backups, and the failures that look like bugs but aren't. |
| [REST API](api.md) | Call the API from your own code. Authentication, scopes, conventions, and the full route surface by area. |
| [MCP server](mcp.md) | Point an agent at it. All 45 tools by scope, both auth modes, and the limits. |

## Conventions used here

- **Verified against source.** Every number, default, path and tool name in these documents was read out
  of the code, not recalled. Where the code and a document disagree, the code is right and the document
  is a bug — please report it.
- **Absence is stated, not implied.** Where something is unbuilt, deliberately excluded, or fails closed,
  it says so in those words. This project treats a check that *looks* like it ran but didn't as a defect,
  and the documentation holds itself to the same standard.
- **Paths** are relative to the repository root unless shown otherwise.

## Scope of this repository

- **Karma is the reward model.** See [Karma](../README.md#karma) for how it is earned, held, and
  surfaced, and [Where we draw the line](../README.md#where-we-draw-the-line) for the scope decisions
  behind what a verification claim here stands for.
- **Delivery material lives elsewhere.** Roadmaps, decision registers, and parity-audit documents are
  kept outside this repository so what ships here stays focused on running the software.

## Contributing to these docs

Same process as code — see [CONTRIBUTING.md](../CONTRIBUTING.md). Two rules specific to documentation:

1. **The code wins.** If a document claims something the code does not do, fix the document, not the code.
2. **Cite what you checked.** A doc change that corrects a claim should say which file you read to
   confirm it, in the pull request description.
