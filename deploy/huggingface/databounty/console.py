# SPDX-License-Identifier: Apache-2.0
"""The signed-in Space, drawn like the DataBounty console: what each console page shows, shaped from
DataBounty's MCP tools (whoami, get_karma_details, get_my_work_progress, list_my_submissions,
list_notifications, list_my_issues, get_issue).

Plain data in, plain data out, like contribute.py, validate.py and sponsor.py. Where the console reads
something no MCP tool offers (weekly validator charts, held karma, notification channels, API keys,
profile edits), the page says so and links to databounty.io instead of guessing.
"""

from __future__ import annotations

from collections import OrderedDict
from datetime import date, datetime, timedelta, timezone
from typing import Any

import contribute

WEEKS = 12

# The console's analytics series (apps/web/components/analytics.tsx), in its colours.
SUBMISSION_SERIES = [
    ("accepted", "Accepted", "#4f7a00"),
    ("inReview", "Still in review", "#2b6cb0"),
    ("needsFixes", "Needs fixes", "#b8860b"),
    ("rejected", "Rejected", "#c2334d"),
]
KARMA_SERIES = [("karma", "Karma", "#7c5cc4")]
# contribute.STATUS_GROUPS' filter group → the analytics series a submission counts in.
GROUP_SERIES = {"accepted": "accepted", "progress": "inReview", "action": "needsFixes", "closed": "rejected"}

KARMA_KINDS = {
    "community_item_accepted": ("accepted item", "ok"),
    "community_item_reversed": ("reversed", "bad"),
    "community_audit_completed": ("audit", "info"),
    "community_request_approved": ("request approved", "karma"),
    "community_bounty_published": ("published", "karma"),
    "community_flag_confirmed": ("flag confirmed", "info"),
    "community_publish_bonus": ("publish bonus", "karma"),
    "admin_adjustment": ("adjustment", ""),
}

ISSUE_STATUS = {
    "received": ("Received", "info"),
    "triaged": ("Triaged", "info"),
    "investigating": ("Investigating", "review"),
    "needs_info": ("Needs your answer", "warn"),
    "duplicate": ("Merged duplicate", ""),
    "not_reproducible": ("Not reproducible", ""),
    "resolved": ("Resolved", "ok"),
    "rejected": ("Closed", ""),
}
ISSUE_OPEN = {"received", "triaged", "investigating", "needs_info"}
ISSUE_IMPACT = {"blocked": ("Blocked", "bad"), "degraded": ("Degraded", "warn"), "suggestion": ("Suggestion", "info")}
ISSUE_KIND = {
    "contract": "Contract", "validation": "Validation", "mcp": "MCP", "upload_processing": "Upload processing",
    "data_quality": "Data quality", "security_privacy": "Security & privacy", "abuse": "Abuse", "other": "Other",
}


def when(value: Any) -> datetime | None:
    """An ISO time from DataBounty, as an aware datetime."""
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def week_start(moment: datetime) -> date:
    """The Monday (UTC) of the ISO week holding `moment`: the console groups weeks the same way."""
    day = moment.astimezone(timezone.utc).date()
    return day - timedelta(days=day.weekday())


def week_range(weeks: int, now: datetime) -> list[date]:
    """The last `weeks` week starts, oldest first, ending with this week."""
    current = week_start(now)
    return [current - timedelta(weeks=n) for n in range(weeks - 1, -1, -1)]


def relative(moment: datetime | None, now: datetime) -> str:
    if moment is None:
        return ""
    seconds = (now - moment).total_seconds()
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{int(seconds // 60)}m"
    if seconds < 86400:
        return f"{int(seconds // 3600)}h"
    if seconds < 7 * 86400:
        return f"{int(seconds // 86400)}d"
    return moment.strftime("%b %d").replace(" 0", " ")


# --- Analytics --------------------------------------------------------------------------------------


def contributor_weeks(submissions: list[dict[str, Any]], weeks: list[date]) -> list[dict[str, Any]]:
    """Submissions by the week they were sent, split by where each stands today (as the console does)."""
    rows = OrderedDict((w, {"weekStart": w.isoformat(), **{key: 0 for key, _, _ in SUBMISSION_SERIES}}) for w in weeks)
    for sub in submissions:
        moment = when(sub.get("createdAt"))
        if moment is None or week_start(moment) not in rows:
            continue
        series = GROUP_SERIES.get(contribute.status_view(sub.get("status"))["group"], "inReview")
        rows[week_start(moment)][series] += 1
    return list(rows.values())


def karma_weeks(events: list[dict[str, Any]], weeks: list[date]) -> list[dict[str, Any]]:
    rows = OrderedDict((w, {"weekStart": w.isoformat(), "karma": 0, "events": 0}) for w in weeks)
    for event in events:
        moment = when(event.get("createdAt"))
        amount = event.get("amount")
        if moment is None or week_start(moment) not in rows or not isinstance(amount, int):
            continue
        rows[week_start(moment)]["karma"] += amount
        rows[week_start(moment)]["events"] += 1
    return list(rows.values())


def analytics_view(submissions: list[dict[str, Any]], events: list[dict[str, Any]], weeks: int, now: datetime) -> dict[str, Any]:
    span = week_range(weeks, now)
    subs = contributor_weeks(submissions, span)
    karma = karma_weeks(events, span)
    return {
        "range": {"weeks": weeks, "from": span[0].isoformat(), "to": now.date().isoformat()},
        "submissions": {"series": [{"key": k, "label": label, "color": color} for k, label, color in SUBMISSION_SERIES], "weeks": subs,
                        "totals": {k: sum(w[k] for w in subs) for k, _, _ in SUBMISSION_SERIES}},
        "karma": {"series": [{"key": k, "label": label, "color": color} for k, label, color in KARMA_SERIES], "weeks": karma,
                  "totals": {"karma": sum(w["karma"] for w in karma)}},
    }


# --- Karma and ranks --------------------------------------------------------------------------------


def tier_view(details: dict[str, Any]) -> dict[str, Any]:
    """The karma hero and sidebar card: total, tier, the next one and how far along."""
    total = details.get("totalKarma") if isinstance(details.get("totalKarma"), int) else 0
    tier = details.get("tier") or {}
    current, nxt = tier.get("current") or {}, tier.get("next") or None
    progress = tier.get("progress")
    return {
        "total": total,
        "tier": {"label": current.get("label") or "", "color": current.get("color") or "", "blurb": current.get("blurb") or "",
                 "minKarma": current.get("minKarma") or 0, "perks": list(current.get("perks") or [])},
        "next": {"label": nxt.get("label") or "", "minKarma": nxt.get("minKarma") or 0, "toGo": max(0, (nxt.get("minKarma") or 0) - total),
                 "perks": list(nxt.get("perks") or []), "color": nxt.get("color") or ""} if nxt else None,
        "progress": round(100 * progress) if isinstance(progress, (int, float)) else (100 if not nxt else 0),
        "rank": details.get("leaderboardRank"),
    }


def tiers_view(ladder: list[dict[str, Any]], tier: dict[str, Any]) -> list[dict[str, Any]]:
    """Every tier, marked current, unlocked or locked. DataBounty names the perks of the current and next
    tier; for the others the public ladder gives the early-access hours, and each tier keeps the one below."""
    perks = {tier["tier"]["label"]: tier["tier"]["perks"]}
    if tier["next"]:
        perks[tier["next"]["label"]] = tier["next"]["perks"]
    out: list[dict[str, Any]] = []
    for row in sorted(ladder, key=lambda t: t.get("minKarma") or 0):
        label = row.get("label") or str(row.get("name") or "")
        state = "current" if label == tier["tier"]["label"] else "unlocked" if (row.get("minKarma") or 0) <= tier["total"] else "locked"
        known = perks.get(label)
        if not known:
            hours = row.get("earlyAccessHours") if isinstance(row.get("earlyAccessHours"), int) else 0
            known = ([f"Everything in {out[-1]['label']}"] if out else []) + ([f"{hours}h early access to new pools"] if hours > 0 else [])
        out.append({"label": label, "minKarma": row.get("minKarma") or 0, "color": row.get("color") or "", "state": state, "perks": known})
    return out


def karma_event_row(event: dict[str, Any]) -> dict[str, Any]:
    kind, tone = KARMA_KINDS.get(str(event.get("eventType") or ""), (str(event.get("eventType") or "").replace("_", " "), ""))
    moment = when(event.get("createdAt"))
    meta = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
    source = meta.get("bountyTitle") or meta.get("title") or meta.get("reason") or str(event.get("sourceType") or "").replace("_", " ").capitalize()
    return {"kind": kind, "tone": tone, "source": source, "amount": event.get("amount") or 0,
            "day": moment.strftime("%b %d, %Y").upper() if moment else ""}


def rank_card(rank: dict[str, Any] | None) -> dict[str, Any]:
    rank = rank or {}
    nxt = rank.get("nextRank") or {}
    return {"name": rank.get("rank") or "", "next": nxt.get("name") or "", "toGo": nxt.get("itemsToGo")}


# --- My submissions, grouped by pool -----------------------------------------------------------------

POOL_FILTERS = ("all", "action", "outcome", "accepted")


def pool_groups(submissions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The console's "My submissions": one row per pool, with where its items stand."""
    pools: OrderedDict[str, dict[str, Any]] = OrderedDict()
    for sub in submissions:
        bounty = sub.get("bounty") or {}
        pid = str(bounty.get("id") or sub.get("bountyId") or "")
        row = pools.setdefault(pid, {"poolId": pid, "pool": bounty.get("title") or "", "karma": bounty.get("karmaPerAcceptedItem"),
                                     "accepted": 0, "action": 0, "checking": 0, "review": 0, "rejected": 0, "total": 0, "latest": ""})
        view = contribute.status_view(sub.get("status"))
        if view["group"] == "accepted":
            row["accepted"] += 1
        elif view["group"] == "action":
            row["action"] += 1
        elif view["group"] == "closed":
            row["rejected"] += 1
        elif view["label"] == "In review":
            row["review"] += 1
        else:
            row["checking"] += 1
        row["total"] += 1
        row["latest"] = max(row["latest"], str(sub.get("createdAt") or ""))
    rows = sorted(pools.values(), key=lambda r: r["latest"], reverse=True)
    for row in rows:
        row["filters"] = ["all"] + (["action"] if row["action"] else []) + (["outcome"] if row["checking"] + row["review"] else []) + (["accepted"] if row["accepted"] else [])
    return rows


# --- Notifications ------------------------------------------------------------------------------------


def notification_link(note: dict[str, Any], app_url: str) -> dict[str, str]:
    """Where a notification leads in the Space, as DataBounty routes it (services/notifications/href.ts)."""
    entity = str(note.get("entityType") or "").lower()
    record = str(note.get("entityId") or "")
    bounty = str(note.get("linkBountyId") or "")
    kind = str(note.get("type") or "")
    if entity == "submission" and record:
        return {"href": f"#/submission/{record}"}
    if entity in {"audit", "audit_window"} and record:
        return {"href": f"#/audit/{record}"}
    if entity == "bounty" and record:
        return {"href": f"#/pool/{record}"}
    if entity in {"karma_event", "badge"} or kind.startswith("karma") or kind.startswith("badge"):
        return {"href": "#/karma"}
    if entity in {"profile", "rank"}:
        return {"href": "#/profile"}
    if entity == "agent_issue":
        return {"href": f"#/issues/{record}" if record else "#/issues"}
    if entity == "dataset_request":
        return {"external": f"{app_url}/sponsor/requests/{record}/" if record else f"{app_url}/sponsor/"}
    if bounty:
        return {"href": f"#/pool/{bounty}"}
    return {"href": "#/notifications"}


def notification_view(note: dict[str, Any], now: datetime, app_url: str) -> dict[str, Any]:
    kind = str(note.get("type") or "")
    tone = ("ok" if "accepted" in kind or kind.endswith("approved") else
            "warn" if any(w in kind for w in ("needs_fixes", "flag", "rejected", "dispute", "failed")) else
            "audit" if kind.startswith("audit") or "validator" in kind else
            "badge" if kind.startswith("badge") or "karma" in kind else "info")
    return {"id": note.get("id"), "title": note.get("title") or "", "body": note.get("body") or "", "read": bool(note.get("read")),
            "when": relative(when(note.get("createdAt")), now), "tone": tone, **notification_link(note, app_url)}


# --- Support cases --------------------------------------------------------------------------------------


def issue_row(issue: dict[str, Any], now: datetime) -> dict[str, Any]:
    status = str(issue.get("status") or "")
    label, tone = ISSUE_STATUS.get(status, (status.replace("_", " ").capitalize(), ""))
    impact_label, impact_tone = ISSUE_IMPACT.get(str(issue.get("impact") or ""), (str(issue.get("impact") or "").capitalize(), ""))
    resources = issue.get("resources") or []
    return {
        "id": issue.get("id"),
        "summary": issue.get("summary") or "",
        "status": status, "statusLabel": label, "statusTone": tone, "open": status in ISSUE_OPEN,
        "needsAnswer": status == "needs_info",
        "kind": ISSUE_KIND.get(str(issue.get("category") or ""), str(issue.get("category") or "").replace("_", " ").capitalize()),
        "impact": impact_label, "impactTone": impact_tone,
        "context": f"{len(resources)} attached" if resources else "No context attached",
        "updated": relative(when(issue.get("updatedAt")), now),
    }


def issue_view(issue: dict[str, Any], now: datetime) -> dict[str, Any]:
    row = issue_row(issue, now)
    filed = when(issue.get("createdAt"))
    history = [
        {"who": "You" if e.get("actorRole") == "reporter" else "DataBounty", "type": str(e.get("type") or "").replace("_", " "),
         "body": e.get("body") or "", "when": relative(when(e.get("createdAt")), now)}
        for e in issue.get("events") or [] if isinstance(e, dict)
    ]
    return {
        **row,
        "expected": issue.get("expected") or "", "actual": issue.get("actual") or "", "steps": issue.get("steps") or "",
        "outcome": issue.get("resolutionNote") or "", "guidance": issue.get("guidance") or "",
        "filed": filed.strftime("%b %d, %Y") if filed else "", "alsoReportedBy": issue.get("alsoReportedBy") or 0,
        "history": history, "canReply": row["open"],
    }
