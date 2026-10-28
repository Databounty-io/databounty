# SPDX-License-Identifier: Apache-2.0
"""Contributing from the Space: the rules and wording behind the web page's contributor screens.

Plain data in, plain data out. webapi.py does the HTTP, account.py the calls to DataBounty, and
web/app.js the drawing. Copy rule: say what to do next in a few plain words. Dataset types carry
long, precise field specs written for agents; the form shows a one-line hint per field and keeps
the full specs one click away.
"""

from __future__ import annotations

import csv
import io
import re
from typing import Any

import items as checks

GENERATION_METHODS = {"human": "I wrote it", "ai_assisted": "With AI help", "ai_generated": "AI generated"}
MAX_BULK_ROWS = 500
CODE_ROLES = {"input_code", "solution_code", "tests", "expected_output"}
LONG_TEXT_ROLES = {"instruction", "input_context", "rationale"}
TITLE_KEYS = ("title", "prompt", "name", "question", "task", "instruction")

# A plain one-line hint per field role, used when a field's own help is a long spec.
ROLE_HINTS = {
    "instruction": "What should be done, in plain words.",
    "input_context": "Any context the task needs.",
    "input_code": "The code the task starts from.",
    "solution_code": "Your working solution.",
    "tests": "Tests that show the solution works.",
    "expected_output": "What a correct answer produces.",
    "rationale": "Why the answer is right.",
    "list": "One entry per line.",
    "reference": "A source or a link.",
    "enum": "Pick one.",
    "file": "Attach a file.",
}
DIFFICULTY_TIPS = {
    "beginner": "Keep it simple and self-contained.",
    "intermediate": "Make it realistic, with at least one tricky case.",
    "advanced": "Make it challenging: several constraints and real edge cases.",
}
# DataBounty field `lang` values, shown as the code box's language.
CODE_LANGUAGES = {
    "py": "python", "python": "python", "js": "javascript", "javascript": "javascript", "ts": "typescript",
    "typescript": "typescript", "sql": "sql", "sh": "shell", "bash": "shell", "shell": "shell", "json": "json",
    "yaml": "yaml", "yml": "yaml", "c": "c", "cpp": "c++", "c++": "c++", "go": "go", "rust": "rust", "java": "java",
    "html": "html", "css": "css", "r": "r", "md": "markdown", "markdown": "markdown", "regex": "regex",
}
# Submission statuses, grouped the way a contributor thinks about them: (label, tone, filter group).
STATUS_GROUPS = [
    ({"draft", "submitted", "duplicate_check", "contamination_check", "running_tests", "llm_validation"}, "Checking", "info", "progress"),
    ({"provisionally_accepted", "in_audit", "in_sponsor_review", "accepted_pending_sample", "disputed"}, "In review", "review", "progress"),
    ({"needs_fixes", "flagged", "tests_failed"}, "Needs your fix", "warn", "action"),
    ({"accepted"}, "Accepted", "ok", "accepted"),
    ({"rejected"}, "Rejected", "bad", "closed"),
]
CHECK_LABELS = {
    "dedupe": "Not a duplicate",
    "duplicate_check": "Not a duplicate",
    "contamination": "Not copied from a benchmark",
    "ai_attribution": "AI disclosure",
    "execution": "Tests in a sandbox",
    "llm": "Quality review",
    "pool_capacity": "Room in the pool",
    "human_audit": "Reviewer",
}
PIPELINE_STEPS = {
    "dedupe": ("Dedupe", "Not already in the pool."),
    "contamination": ("Benchmark check", "Not copied from a public benchmark."),
    "ai_attribution": ("AI attribution", "Declared AI help is recorded for the reviewer."),
    "execution": ("Execution", "Your tests run in an isolated sandbox."),
    "llm": ("LLM review", "A model scores quality. Advisory only."),
    "human_audit": ("Validator audit", "A person makes the final call."),
}
_SHOUTING = re.compile(r"\b[A-Z]{4,}\b")


def short_hint(spec: dict[str, Any]) -> str:
    """A one-line hint: the field's own help when it is short and plain, else a plain hint for its role."""
    text = " ".join(str(spec.get("help") or "").split())
    if text and len(text) <= 110 and not _SHOUTING.search(text):
        return text
    return ROLE_HINTS.get(spec.get("role") or "", "")


def code_language(spec: dict[str, Any]) -> str | None:
    """The language a code field holds, from its `lang`, else its label or a JSON spec."""
    lang = str(spec.get("lang") or "").strip().lower()
    if lang in CODE_LANGUAGES:
        return CODE_LANGUAGES[lang]
    label = str(spec.get("label") or "").lower()
    for word, language in (("python", "python"), ("typescript", "typescript"), ("javascript", "javascript"), ("sql", "sql"), ("json", "json"), ("bash", "shell"), ("shell", "shell")):
        if word in label:
            return language
    if str(spec.get("help") or "").lstrip().upper().startswith("JSON"):
        return "json"
    return None


def field_kind(spec: dict[str, Any]) -> str:
    """How the form draws a field: enum, file, code, list, longtext or text."""
    role = spec.get("role")
    if role == "enum" and spec.get("options"):
        return "enum"
    if role in {"file", "list"}:
        return str(role)
    if role in CODE_ROLES:
        return "code"
    return "longtext" if role in LONG_TEXT_ROLES else "text"


def title_for(payload: dict[str, Any] | None, number: int = 1) -> str:
    """The same rule DataBounty uses when an item comes without a title."""
    payload = payload or {}
    for key in TITLE_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())[:120]
    for value in payload.values():
        if isinstance(value, str) and len(value.strip()) >= 3:
            return " ".join(value.split())[:120]
    return f"Item from row {number}"


def status_view(status: str | None) -> dict[str, str]:
    """{label, tone, group} for a submission status."""
    for statuses, label, tone, group in STATUS_GROUPS:
        if status in statuses:
            return {"label": label, "tone": tone, "group": group}
    return {"label": str(status or "Unknown").replace("_", " ").capitalize(), "tone": "info", "group": "progress"}


def check_state(result: dict[str, Any]) -> tuple[str, str]:
    """('pass' | 'fail' | 'wait' | 'note', reason) for one check, read the way DataBounty reads it:
    a check with no score never ran, which is never a failure, and a failing quality review is
    advisory: a reviewer still decides."""
    stage = str(result.get("stage") or "")
    detail = result.get("detailJson") if isinstance(result.get("detailJson"), dict) else {}
    reason = detail.get("reason") if isinstance(detail.get("reason"), str) else ""
    if result.get("passed"):
        if detail.get("contaminationDecision") == "review_required" or detail.get("duplicateDecision") == "review_required":
            return "note", reason or "Close to existing work: a reviewer will look"
        return "pass", ""
    if result.get("outcome") == "pool_capacity_reached" or stage == "pool_capacity":
        return "fail", reason or "The pool filled up before this item was counted."
    if result.get("score") is None:
        return "wait", reason or "Not run yet"
    if stage == "llm":
        return "note", "Below the quality bar. Advisory: a reviewer still decides."
    if stage == "ai_attribution" and detail.get("status") == "flagged":
        return "note", "AI involvement found: a reviewer will look"
    return "fail", reason or "Didn't pass"


def template_csv(fields: list[dict[str, Any]]) -> str | None:
    """A CSV with the pool's columns, for the file upload. File fields are left out: items with
    files are added one at a time."""
    keys = [spec["key"] for spec in fields if spec.get("role") != "file"]
    if not keys:
        return None
    buffer = io.StringIO()
    csv.writer(buffer).writerow(keys)
    return buffer.getvalue()


def pipeline(verification: dict[str, Any] | None) -> list[dict[str, str]]:
    """The checks an item goes through, in order: the type's own, plus the platform's always-on ones."""
    stages = [s for s in (verification or {}).get("pipeline") or [] if isinstance(s, str) and s not in {"schema", "contamination"}]
    if "dedupe" not in stages:
        stages.insert(0, "dedupe")
    if "ai_attribution" not in stages:
        stages.insert(stages.index("dedupe") + 1, "ai_attribution")
    if "human_audit" not in stages:
        stages.append("human_audit")
    return [{"key": s, "label": PIPELINE_STEPS[s][0], "what": PIPELINE_STEPS[s][1]} for s in stages if s in PIPELINE_STEPS]


def _field_view(spec: dict[str, Any]) -> dict[str, Any]:
    return {
        "key": spec["key"],
        "label": spec.get("label") or spec["key"],
        "role": spec.get("role"),
        "required": bool(spec.get("required")),
        "kind": field_kind(spec),
        "hint": short_hint(spec),
        "help": " ".join(str(spec.get("help") or "").split()),
        "language": code_language(spec) if spec.get("role") in CODE_ROLES else None,
        "options": [str(o) for o in spec.get("options") or []],
        "maxCount": int(spec.get("maxCount") or 1),
        "minCount": spec.get("minCount"),
        "accept": spec.get("accept") or "",
    }


def contract_view(raw: dict[str, Any], pool_id: str) -> dict[str, Any]:
    """What the pool page needs, from DataBounty's get_pool_contract."""
    bounty = raw.get("bounty") or {}
    capacity = raw.get("capacity") or {}
    limits = raw.get("submitLimits") or {}
    dataset_type = raw.get("datasetType") or {}
    fields = [f for f in dataset_type.get("fields") or [] if isinstance(f, dict) and f.get("key")]
    karma = (bounty.get("karmaPricing") or {}).get("contributorPerItem") or bounty.get("karmaPerAcceptedItem")
    difficulty = str(bounty.get("difficulty") or bounty.get("poolDifficulty") or "")
    samples = [
        s["fields"] for s in dataset_type.get("sampleAssets") or []
        if isinstance(s, dict) and isinstance(s.get("fields"), dict) and s["fields"]
    ]
    remaining = capacity.get("poolRemaining")
    return {
        "id": pool_id,
        "title": bounty.get("title") or "",
        "description": " ".join(str(bounty.get("description") or "").split()),
        "typeName": dataset_type.get("name") or "",
        "difficulty": difficulty,
        "tip": DIFFICULTY_TIPS.get(difficulty.lower(), ""),
        "language": bounty.get("language") or "",
        "license": bounty.get("communityLicense") or bounty.get("license") or "",
        "karma": karma,
        "remaining": remaining if isinstance(remaining, int) else None,
        "open": capacity.get("recommendedPath") != "none" and bounty.get("status") == "active",
        "nextStep": capacity.get("nextStep") or "",
        "maxItems": int(limits.get("maxItemsPerRequest") or 20),
        "fields": [_field_view(f) for f in fields],
        "samples": samples[:3],
        "pipeline": pipeline(raw.get("verification") or dataset_type.get("verification")),
        "signedIn": True,
    }


def public_contract_view(details: dict[str, Any]) -> dict[str, Any]:
    """The same shape from the public pool details, for someone not signed in yet."""
    difficulty = str(details.get("difficulty") or "")
    target, accepted = int(details.get("target_items") or 0), int(details.get("accepted_items") or 0)
    # The public record has no pipeline, but its trust tier says whether tests run in a sandbox.
    executed = details.get("trust_tier") == "execution_verified"
    return {
        "id": details["id"],
        "title": details.get("title") or "",
        "description": " ".join(str(details.get("description") or "").split()),
        "typeName": details.get("dataset_type") or "",
        "difficulty": difficulty,
        "tip": DIFFICULTY_TIPS.get(difficulty.lower(), ""),
        "language": details.get("language") or "",
        "license": details.get("license") or "",
        "karma": details.get("karma_per_accepted_item"),
        "remaining": max(0, target - accepted) if target else None,
        "open": details.get("status") in (None, "", "active"),
        "nextStep": "",
        "maxItems": 20,
        "fields": [_field_view(f) for f in details.get("fields") or [] if isinstance(f, dict) and f.get("key")],
        "samples": [s for s in details.get("example_items") or [] if isinstance(s, dict) and s][:3],
        "pipeline": pipeline({"pipeline": ["dedupe", "execution", "human_audit"]} if executed else None),
        "signedIn": False,
    }


def item_payload(fields: list[dict[str, Any]], values: dict[str, Any], file_counts: dict[str, int]) -> tuple[dict[str, Any], list[str]]:
    """The item's payload from the form's values, and what's wrong with it. File fields are counted,
    not read, so nothing is uploaded for an item DataBounty would refuse."""
    payload: dict[str, Any] = {}
    for spec in fields:
        key, role = spec["key"], spec.get("role")
        if role == "file":
            continue
        value = values.get(key)
        if role == "list":
            value = [line.strip() for line in str(value or "").splitlines() if line.strip()] if not isinstance(value, list) else value
        elif isinstance(value, str):
            value = value.strip()
        if value not in (None, "", []):
            payload[key] = value
    labels = {spec["key"]: spec.get("label") or spec["key"] for spec in fields}
    missing = [
        labels[spec["key"]] for spec in fields
        if spec.get("required") and spec["key"] not in payload and not file_counts.get(spec["key"])
    ]
    if missing:
        return payload, [f"Fill in: {', '.join(missing)}."]
    probe = dict(payload)
    for spec in fields:
        count = file_counts.get(spec["key"], 0)
        if spec.get("role") == "file" and count:
            limit = int(spec.get("maxCount") or 1)
            if count > limit:
                return payload, [f"{labels[spec['key']]} takes at most {limit} file{'s' if limit > 1 else ''}."]
            probe[spec["key"]] = ["file"] * count if limit > 1 else "file"
    problems = checks.item_problems(fields, probe)
    return payload, [re.sub(r'"([^"]+)"', lambda m: labels.get(m.group(1), m.group(1)), p) for p in problems]


def submission_row(item: dict[str, Any]) -> dict[str, Any]:
    status = status_view(item.get("status"))
    return {
        "id": item.get("id"),
        "title": item.get("title") or "",
        "pool": (item.get("bounty") or {}).get("title") or "",
        "poolId": (item.get("bounty") or {}).get("id") or item.get("bountyId"),
        "date": str(item.get("createdAt") or "")[:10],
        "status": item.get("status"),
        "statusLabel": status["label"],
        "statusTone": status["tone"],
        "statusGroup": status["group"],
    }


def checks_for(validation_results: list[dict[str, Any]] | None) -> list[dict[str, str]]:
    """Each check's latest result, in pipeline order and plain words. Results come newest first."""
    latest: dict[str, dict[str, Any]] = {}
    for result in validation_results or []:
        stage = str(result.get("stage") or "")
        if stage and stage not in latest:
            latest[stage] = result
    order = ["dedupe", "duplicate_check", "contamination", "ai_attribution", "execution", "llm", "pool_capacity", "human_audit"]
    stages = sorted(latest, key=lambda s: order.index(s) if s in order else len(order))
    results = []
    for stage in stages:
        state, reason = check_state(latest[stage])
        results.append({"stage": stage, "label": CHECK_LABELS.get(stage, stage.replace("_", " ").capitalize()), "state": state, "reason": reason})
    return results


def submission_view(sub: dict[str, Any], app_url: str) -> dict[str, Any]:
    """One submission for its detail page: status, each check in plain words, reviewer notes."""
    results = checks_for(sub.get("validationResults"))
    notes = [
        flag.get("note") or flag.get("validatorNote") or flag.get("message") or "A reviewer flagged this item."
        for flag in sub.get("flags") or []
    ]
    recheck = (sub.get("validation") or {}).get("recheckAfterSeconds")
    needs_fix = sub.get("status") in {"needs_fixes", "flagged", "tests_failed"}
    return {
        **submission_row(sub),
        "checks": results,
        "notes": notes,
        "recheckAfter": int(recheck) if isinstance(recheck, (int, float)) and recheck > 0 else None,
        "fixUrl": f"{app_url}/contributor/submissions/{sub.get('id')}/" if needs_fix else None,
    }
