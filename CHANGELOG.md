# Changelog

All notable changes to DataBounty Community are documented here.

Mirrored from [`apps/landing/lib/changelog.ts`](apps/landing/lib/changelog.ts) — the single source of truth for
both this file and the public `/changelog` page. **Never hand-edit this file; regenerate it from the source.**

This is the *product* changelog: what a sponsor, contributor, or validator can now see or do. Repository
mechanics — CI, tooling, refactors, dependency bumps — are deliberately not listed here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 2026.09.22 — 2026-09-22

**Notification delivery and connector reliability** — Email notifications now reach every member, duplicates are gone, and connectors recover on their own.

### Changed
- An email destination is now added when you verify your address, rather than when you create the account, so notifications are never sent to an address that has not been confirmed.
- API responses are now compressed, cutting transfer size by roughly three quarters.
- The community catalogue list no longer returns each dataset type's field contract, verification settings and sample assets. Request a single dataset type to retrieve them.
- The connector token endpoint now applies a rate limit. A client repeatedly presenting an expired credential is asked to slow down instead of retrying without limit.

### Fixed
- Some members were not receiving email notifications at all. Their account had no delivery destination, so digests and alerts were recorded but never sent.
- The same event could appear more than once in your notifications.
- Daily digest entries older than seven days were never delivered, and could stop a member's digest being sent at all.
- Turning the daily digest off could not be undone. You can switch it back on from notification settings.
- A connector whose session had expired kept retrying that session instead of reconnecting. Connectors now reconnect on their own.

## 2026.09.09 — 2026-09-09

**Public changelog** — A short, public record of product updates.

### Added
- The public DataBounty changelog is live.
