# SPDX-License-Identifier: Apache-2.0
"""Run with: python -m unittest discover -s deploy/huggingface/tests

The reviewer screens' rules and wording: plain data, no network, no web server.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "databounty"))

import validate  # noqa: E402

WHO = {
    "ranks": {"validator": {"rank": "Reviewer", "auditsCompleted": 12, "maxConcurrentAudits": 2, "falseFlagRate": 4.5,
                            "missedDeadlines": 1, "nextRank": {"name": "Inspector", "itemsToGo": 13}}},
    "activity": {"activeAudits": 2},
}
DETAIL = {
    "id": "w1",
    "bountyId": "p1",
    "claimExpiresAt": "2026-10-23T10:00:00.000Z",
    "status": "in_progress",
    "karmaReward": 5,
    "bounty": {
        "id": "p1",
        "title": "CLI parsers",
        "language": "Python",
        "datasetType": {
            "name": "CLI Argument Parsing",
            "fields": [
                {"key": "task", "label": "Task", "role": "instruction", "required": True, "help": "What to build."},
                {"key": "solution", "label": "Solution", "role": "solution_code", "required": True},
            ],
        },
    },
    "items": [
        {
            "id": "m1",
            "submissionId": "s1",
            "verdict": None,
            "decidedAt": None,
            "submission": {
                "id": "s1",
                "title": "Backup tool",
                "generationMethod": "ai_assisted",
                "payloadJson": {"extra": {"a": 1}, "solution": "def f():\n    pass", "task": "Parse flags"},
                "validationResults": [
                    {"stage": "execution", "passed": True, "score": 1},
                    {"stage": "human_audit", "passed": False, "score": None},
                    {"stage": "dedupe", "passed": True, "score": 0.1},
                ],
            },
            "attachments": [{"filename": "run.log", "sizeBytes": 2048, "downloadUrl": "/v1/artifacts/a1/content"}],
        },
        {
            "id": "m2",
            "submissionId": "s2",
            "verdict": "flagged",
            "decidedAt": "2026-10-22T10:00:00.000Z",
            "flagReason": "tests_invalid",
            "note": "The second test can never fail.",
            "submission": {"id": "s2", "title": "Rate limiter", "generationMethod": "human", "payloadJson": {"task": "Limit"}},
        },
    ],
}


class RankTest(unittest.TestCase):
    def test_the_reviewer_standing_comes_from_whoami(self):
        self.assertEqual(
            validate.rank_view(WHO),
            {"rank": "Reviewer", "auditsCompleted": 12, "nextRank": {"name": "Inspector", "toGo": 13}, "maxConcurrent": 2,
             "active": 2, "falseFlagRate": 4.5, "missedDeadlines": 1},
        )

    def test_a_new_reviewer_holds_one_audit_and_has_no_rate_yet(self):
        view = validate.rank_view({})
        self.assertEqual((view["maxConcurrent"], view["active"], view["falseFlagRate"], view["nextRank"]), (1, 0, None, None))


class AuditTest(unittest.TestCase):
    def test_a_list_row(self):
        row = validate.audit_row({"id": "w1", "bountyId": "p1", "bountyTitle": "CLI parsers", "itemCount": 4, "decidedCount": 1,
                                  "status": "overdue_review", "category": "code_generation", "karmaReward": 5, "deadline": None})
        self.assertEqual((row["statusLabel"], row["statusTone"], row["items"], row["decided"], row["category"]),
                         ("Past due", "warn", 4, 1, "code generation"))

    def test_items_show_the_contract_fields_first_then_the_rest(self):
        view = validate.audit_view(DETAIL, "https://console.example.test")
        first = view["items"][0]
        self.assertEqual([f["key"] for f in first["fields"]], ["task", "solution", "extra"])
        self.assertEqual([f["code"] for f in first["fields"]], [False, True, False])
        self.assertEqual(first["fields"][2]["value"], '{\n  "a": 1\n}')
        self.assertEqual(first["method"], "Written with AI help")
        self.assertEqual(first["attachments"], [{"name": "run.log", "size": 2048}])
        self.assertEqual(view["consoleUrl"], "https://console.example.test/validator/audit/w1/")

    def test_checks_leave_out_the_review_being_done(self):
        checks = validate.audit_view(DETAIL, "")["items"][0]["checks"]
        self.assertEqual([c["stage"] for c in checks], ["dedupe", "execution"])

    def test_a_decided_item_shows_its_decision_and_counts(self):
        view = validate.audit_view(DETAIL, "")
        decided = view["items"][1]
        self.assertEqual((decided["decided"], decided["verdict"], decided["flagReason"]), (True, "flagged", "Tests are wrong"))
        self.assertEqual(decided["note"], "The second test can never fail.")
        self.assertEqual((view["decided"], view["total"]), (1, 2))
        self.assertFalse(view["items"][0]["decided"])

    def test_a_verdict_counts_when_databounty_says_where_it_came_from(self):
        decided = lambda item: validate.audit_view({**DETAIL, "items": [item]}, "")["items"][0]["decided"]  # noqa: E731
        base = DETAIL["items"][0]
        # An audit without an audit batch has no decision time until it closes.
        self.assertTrue(decided({**base, "verdict": "ok", "decidedAt": None, "verdictSource": "derived_from_status"}))
        self.assertFalse(decided({**base, "verdict": None, "decidedAt": None, "verdictSource": None}))
        # Older replies without verdictSource need both.
        self.assertFalse(decided({**base, "verdict": "ok", "decidedAt": None}))


class DecisionTest(unittest.TestCase):
    def test_approving_needs_nothing_else(self):
        self.assertEqual(validate.decision({"itemId": "m1", "verdict": "ok", "note": "ignored"}), ({"auditItemId": "m1", "verdict": "ok"}, ""))

    def test_rejecting_needs_a_reason_and_a_real_note(self):
        cases = {
            "no reason": ({"itemId": "m1", "verdict": "flagged", "note": "The tests are wrong here."}, "Choose why"),
            "unknown reason": ({"itemId": "m1", "verdict": "flagged", "flagReason": "meh", "note": "The tests are wrong here."}, "Choose why"),
            "short note": ({"itemId": "m1", "verdict": "flagged", "flagReason": "other", "note": "   bad    "}, "at least 10"),
            "no verdict": ({"itemId": "m1"}, "Approve the item or reject it"),
            "no item": ({"verdict": "ok"}, "Pick the item"),
        }
        for name, (body, message) in cases.items():
            with self.subTest(name):
                decision, problem = validate.decision(body)
                self.assertIsNone(decision)
                self.assertIn(message, problem)

    def test_a_good_rejection_keeps_the_note_as_written(self):
        decision, problem = validate.decision({"itemId": "m1", "verdict": "flagged", "flagReason": "tests_invalid", "note": " Test 2:\n never fails "})
        self.assertEqual(problem, "")
        self.assertEqual(decision, {"auditItemId": "m1", "verdict": "flagged", "flagReason": "tests_invalid", "note": "Test 2:\n never fails"})


if __name__ == "__main__":
    unittest.main()
