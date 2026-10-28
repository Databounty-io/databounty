# SPDX-License-Identifier: Apache-2.0
"""Reviewing from the Space: the rules and wording behind the validator screens.

Plain data in, plain data out, like contribute.py. webapi.py does the HTTP, and account.py the
calls to DataBounty's validator tools (list_audits, claim_audit, get_audit, submit_decisions,
list_my_audits). DataBounty enforces every rule; the checks here only save a round trip.
"""

from __future__ import annotations

import json
from typing import Any

import contribute

# Why a reviewer rejects an item: DataBounty's FlagReason values, in the console's order.
FLAG_REASONS = {
    "duplicate": "Duplicate or near-duplicate",
    "contaminated": "Copied from a public benchmark",
    "tests_invalid": "Tests are wrong",
    "solution_incorrect": "Solution is wrong",
    "too_trivial": "Too easy",
    "low_quality": "Low quality",
    "off_spec": "Doesn't follow the pool's spec",
    "other": "Something else",
}
# DataBounty refuses a rejection without a note at least this long (MIN_FLAG_NOTE_LENGTH):
# the note is all the contributor is told about why their item came back.
MIN_NOTE_LENGTH = 10
METHOD_LABELS = {"human": "Written by a person", "ai_assisted": "Written with AI help", "ai_generated": "AI generated"}
# An audit's status as a reviewer reads it: (label, tone).
AUDIT_STATUS = {
    "available": ("Open", "info"),
    "in_progress": ("Open", "info"),
    "claimed": ("Yours", "review"),
    "overdue_review": ("Past due", "warn"),
    "completed": ("Completed", "ok"),
}


def _int(value: Any) -> int:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def rank_view(who: dict[str, Any]) -> dict[str, Any]:
    """The reviewer's standing from whoami: rank, progress to the next one, and how many audits
    they may hold at once against how many they hold now."""
    validator = (who.get("ranks") or {}).get("validator") or {}
    upcoming = validator.get("nextRank")
    rate = validator.get("falseFlagRate")
    return {
        "rank": validator.get("rank") or "",
        "auditsCompleted": _int(validator.get("auditsCompleted")),
        "nextRank": {"name": upcoming["name"], "toGo": _int(upcoming.get("itemsToGo"))}
        if isinstance(upcoming, dict) and upcoming.get("name")
        else None,
        "maxConcurrent": max(1, _int(validator.get("maxConcurrentAudits"))),
        "active": _int((who.get("activity") or {}).get("activeAudits")),
        "falseFlagRate": rate if isinstance(rate, (int, float)) else None,
        "missedDeadlines": _int(validator.get("missedDeadlines")),
    }


def audit_row(audit: dict[str, Any]) -> dict[str, Any]:
    """One audit in a list: open ones from list_audits, the reviewer's own from list_my_audits."""
    label, tone = AUDIT_STATUS.get(str(audit.get("status") or ""), ("Open", "info"))
    return {
        "id": audit.get("id"),
        "poolId": audit.get("bountyId"),
        "pool": audit.get("bountyTitle") or "",
        "items": _int(audit.get("itemCount")),
        "decided": _int(audit.get("decidedCount")),
        "status": audit.get("status"),
        "statusLabel": label,
        "statusTone": tone,
        "deadline": audit.get("deadline"),
        "category": str(audit.get("category") or "").replace("_", " "),
        "language": audit.get("language") or "",
        "karma": audit.get("karmaReward"),
        "closed": bool(audit.get("supersededAt")),
    }


def _text(value: Any) -> str:
    """A field's value as the reviewer reads it. A list puts one entry per line, which keeps
    lists of test cases readable."""
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    if isinstance(value, list) and value:
        return "[\n" + ",\n".join(f"  {json.dumps(entry, ensure_ascii=False)}" for entry in value) + "\n]"
    return json.dumps(value, indent=2, ensure_ascii=False)


def fields_view(payload: Any, specs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """An item's fields for reading: the contract's fields in its order, then anything else it carries."""
    payload = payload if isinstance(payload, dict) else {}
    known = [spec["key"] for spec in specs if spec.get("key")]
    labels = {spec["key"]: spec.get("label") or spec["key"] for spec in specs if spec.get("key")}
    kinds = {spec["key"]: contribute.field_kind(spec) for spec in specs if spec.get("key")}
    keys = [k for k in known if k in payload] + [k for k in payload if k not in known]
    return [{"key": key, "label": labels.get(key, key), "value": _text(payload.get(key)), "code": kinds.get(key) == "code"} for key in keys]


def _item_view(item: dict[str, Any], specs: list[dict[str, Any]]) -> dict[str, Any]:
    sub = item.get("submission") or {}
    verdict = item.get("verdict")
    # The console's rule (validator/audit/[id]/view.tsx itemDecision): when DataBounty says where
    # a verdict came from, the verdict is real. An audit without an audit batch has no decision
    # time until it closes, so requiring one would offer controls DataBounty then refuses.
    decided = verdict in ("ok", "flagged") and ("verdictSource" in item or "decidedAt" not in item or bool(item.get("decidedAt")))
    return {
        "id": item.get("id"),
        "submissionId": item.get("submissionId") or sub.get("id"),
        "title": sub.get("title") or "",
        "method": METHOD_LABELS.get(str(sub.get("generationMethod") or ""), ""),
        "fields": fields_view(sub.get("payloadJson"), specs),
        "checks": [c for c in contribute.checks_for(sub.get("validationResults")) if c["stage"] != "human_audit"],
        "attachments": [
            {"name": a.get("filename") or "file", "size": a.get("sizeBytes")}
            for a in item.get("attachments") or []
            if isinstance(a, dict)
        ],
        "decided": decided,
        "verdict": verdict if decided else None,
        "flagReason": FLAG_REASONS.get(str(item.get("flagReason") or ""), "") if decided and verdict == "flagged" else "",
        "note": (item.get("note") or "") if decided and verdict == "flagged" else "",
    }


def audit_view(detail: dict[str, Any], app_url: str) -> dict[str, Any]:
    """A claimed audit for its review page, from get_audit: the pool's spec and each item with
    its content, its automated checks and any decision already made."""
    bounty = detail.get("bounty") or {}
    dataset_type = bounty.get("datasetType") or {}
    specs = [f for f in dataset_type.get("fields") or [] if isinstance(f, dict) and f.get("key")]
    items = [_item_view(item, specs) for item in detail.get("items") or [] if isinstance(item, dict)]
    return {
        "id": detail.get("id"),
        "poolId": detail.get("bountyId") or bounty.get("id"),
        "pool": bounty.get("title") or "",
        "typeName": dataset_type.get("name") or "",
        "language": bounty.get("language") or "",
        "deadline": detail.get("claimExpiresAt") or detail.get("deadline"),
        "status": detail.get("status"),
        "karma": detail.get("karmaReward"),
        "spec": [
            {"key": spec["key"], "label": spec.get("label") or spec["key"], "required": bool(spec.get("required")), "hint": contribute.short_hint(spec)}
            for spec in specs
        ],
        "items": items,
        "decided": sum(1 for item in items if item["decided"]),
        "total": len(items),
        "consoleUrl": f"{app_url}/validator/audit/{detail.get('id')}/",
    }


def decision(body: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """One decision from the page, in submit_decisions' shape, or why DataBounty would refuse it."""
    item_id = str(body.get("itemId") or "").strip()
    verdict = body.get("verdict")
    if not item_id:
        return None, "Pick the item you're deciding."
    if verdict == "ok":
        return {"auditItemId": item_id, "verdict": "ok"}, ""
    if verdict != "flagged":
        return None, "Approve the item or reject it."
    reason = str(body.get("flagReason") or "")
    note = str(body.get("note") or "").strip()  # DataBounty counts the trimmed note
    if reason not in FLAG_REASONS:
        return None, "Choose why you're rejecting it."
    if len(note) < MIN_NOTE_LENGTH:
        return None, f"Tell the contributor what's wrong, in at least {MIN_NOTE_LENGTH} characters. It's all they'll see."
    return {"auditItemId": item_id, "verdict": "flagged", "flagReason": reason, "note": note}, ""
