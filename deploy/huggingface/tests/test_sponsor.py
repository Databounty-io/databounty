# SPDX-License-Identifier: Apache-2.0
"""Run with: python -m unittest discover -s deploy/huggingface/tests

What a pool's requester sees of the items in their pool (sponsor.py): plain data, no network.
"""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "databounty"))

import sponsor  # noqa: E402

NOW = datetime(2026, 10, 23, 12, 0, tzinfo=timezone.utc)
SPECS = [{"key": "task", "label": "Task", "role": "instruction"}, {"key": "solution", "label": "Solution", "role": "solution_code"}]
EVIDENCE = {
    "total": 3,
    "hasMore": False,
    "submissions": [
        {"id": "s1", "title": "Parse flags", "status": "accepted", "generationMethod": "ai_assisted", "createdAt": "2026-10-20T09:00:00Z",
         "contributor": {"displayName": "Asha", "handle": "asha"}, "payloadJson": {"solution": "def f(): pass", "task": "Parse flags"},
         "validationResults": [{"stage": "dedupe", "passed": True, "score": 0.1}, {"stage": "human_audit", "passed": True, "score": 1}],
         "disputeWindowClosesAt": "2026-10-24T09:00:00.000Z"},
        {"id": "s2", "title": "Old one", "status": "accepted", "createdAt": "2026-09-01T09:00:00Z", "contributor": {"handle": "ravi"},
         "payloadJson": {}, "disputeWindowClosesAt": "2026-09-03T09:00:00.000Z"},
        {"id": "s3", "title": "Came back", "status": "needs_fixes", "createdAt": "2026-10-21T09:00:00Z", "contributor": {"handle": "kim"},
         "payloadJson": {}, "flags": [{"reason": "tests_invalid", "details": "Test 2 can never fail.", "status": "open"}], "disputeWindowClosesAt": None},
    ],
}


class SponsorViewTest(unittest.TestCase):
    def test_items_read_in_plain_words_with_fields_in_contract_order(self):
        view = sponsor.pool_view(EVIDENCE, SPECS, NOW)
        first = view["items"][0]
        self.assertEqual((view["total"], view["more"]), (3, False))
        self.assertEqual((first["statusLabel"], first["handle"], first["date"], first["method"]), ("Accepted", "asha", "2026-10-20", "Written with AI help"))
        self.assertEqual([f["key"] for f in first["fields"]], ["task", "solution"])
        self.assertEqual([c["stage"] for c in first["checks"]], ["dedupe"])

    def test_only_an_accepted_item_inside_its_window_can_be_disputed(self):
        items = {item["id"]: item for item in sponsor.pool_view(EVIDENCE, SPECS, NOW)["items"]}
        self.assertTrue(items["s1"]["canDispute"])
        self.assertFalse(items["s2"]["canDispute"])  # window closed
        self.assertFalse(items["s3"]["canDispute"])  # never accepted
        self.assertIsNone(items["s3"]["disputeUntil"])

    def test_flags_show_their_reason_and_note(self):
        third = sponsor.pool_view(EVIDENCE, SPECS, NOW)["items"][2]
        self.assertEqual(third["statusLabel"], "Sent back for a fix")  # not "Needs your fix": it waits on the contributor
        flags = third["flags"]
        self.assertEqual(flags, [{"reason": "Tests are wrong", "note": "Test 2 can never fail."}])


class DisputeTest(unittest.TestCase):
    def test_a_dispute_needs_a_known_reason_and_a_real_argument(self):
        cases = {
            "no reason": ({"argument": "The tests assert nothing at all."}, "Choose why"),
            "unknown reason": ({"reason": "vibes", "argument": "The tests assert nothing at all."}, "Choose why"),
            "too short": ({"reason": "tests_invalid", "argument": "  bad  "}, "at least 10"),
            "too long": ({"reason": "tests_invalid", "argument": "x" * 2001}, "under 2000"),
        }
        for name, (body, message) in cases.items():
            with self.subTest(name):
                arguments, problem = sponsor.dispute(body)
                self.assertIsNone(arguments)
                self.assertIn(message, problem)

    def test_a_good_dispute_is_trimmed_and_shaped_for_databounty(self):
        self.assertEqual(
            sponsor.dispute({"reason": "tests_invalid", "argument": "  The tests assert nothing at all. "}),
            ({"reason": "tests_invalid", "argument": "The tests assert nothing at all."}, ""),
        )


if __name__ == "__main__":
    unittest.main()
