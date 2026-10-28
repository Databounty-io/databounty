# SPDX-License-Identifier: Apache-2.0
"""Run with: python -m unittest discover -s deploy/huggingface/tests

Contributing through the Space's MCP server with a DataBounty API key (agent_tools.py, and the tool
wiring in app.py). DataBounty's tools are stubbed; nothing touches the network.
"""

import inspect
import os
import typing
import sys
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("SPACE_PUBLIC_URL", "https://example-space.hf.space")
os.environ.setdefault("DATABOUNTY_MCP_URL", "https://console.example.test/mcp")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "databounty"))

import account  # noqa: E402
import agent_tools  # noqa: E402

KEY = "db_live_sk_" + "x" * 40
FIELDS = [
    {"key": "task", "label": "Task", "role": "instruction", "required": True},
    {"key": "solution", "label": "Solution", "role": "solution_code", "required": True},
    {"key": "level", "label": "Level", "role": "enum", "required": False, "options": ["easy", "hard"]},
]
CONTRACT = {
    "bounty": {"title": "CLI parsers", "status": "active", "karmaPricing": {"contributorPerItem": 40}},
    "capacity": {"poolRemaining": 100, "recommendedPath": "submit_pool_items"},
    "submitLimits": {"maxItemsPerRequest": 3},
    "datasetType": {"name": "Python function", "fields": FIELDS},
}
GOOD = {"task": "Parse flags", "solution": "def f(): pass"}


class AgentToolsTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.contract = CONTRACT
        patcher = mock.patch.object(account, "call_tool_with_key", side_effect=self.call)
        patcher.start()
        self.addCleanup(patcher.stop)

    def call(self, key, name, arguments=None):
        self.calls.append((key, name, arguments))
        if name == "whoami":
            return {"handle": "asha", "displayName": "Asha", "karmaTotal": 40, "emailVerified": True, "onboarded": True}
        if name == "get_pool_contract":
            return self.contract
        if name == "submit_pool_items":
            return {"submissions": [{"id": f"s{i}", "status": "submitted"} for i, _ in enumerate(arguments["items"])]}
        if name == "list_my_submissions":
            return {"items": [{"id": "s1", "title": "Parse flags", "status": "in_audit", "bounty": {"title": "CLI parsers"}}], "total": 1}
        if name == "get_sponsor_submission_evidence":
            return {"total": 1, "submissions": [{"id": "s9", "title": "Parse flags", "status": "accepted", "payloadJson": {"task": "t"},
                                                 "contributor": {"handle": "kim"}, "disputeWindowClosesAt": "2999-01-01T00:00:00Z"}]}
        if name == "dispute_accepted_submission":
            return {"ok": True}
        raise account.ToolError(f"{name} isn't stubbed")

    def sent(self, name):
        return [arguments for _, called, arguments in self.calls if called == name]

    def test_without_a_key_it_says_where_to_get_one_and_sends_nothing(self):
        for raw in (None, "", "   "):
            with self.subTest(raw=raw), self.assertRaises(agent_tools.AgentError) as caught:
                agent_tools.my_account(raw)
            self.assertIn("X-DataBounty-Key", str(caught.exception))
        self.assertEqual(self.calls, [])

    def test_only_a_databounty_key_is_ever_forwarded(self):
        for raw in ("hf_abcdefghijklmnop", "sk-live-123", "ghp_123"):
            with self.subTest(raw=raw), self.assertRaises(agent_tools.AgentError):
                agent_tools.my_account(raw)
        self.assertEqual(self.calls, [])
        agent_tools.my_account(f"Bearer {KEY}")
        self.assertEqual(self.calls[0][0], KEY)

    def test_a_refused_key_says_so(self):
        with mock.patch.object(account, "call_tool_with_key", side_effect=account.NotSignedIn()):
            with self.assertRaises(agent_tools.AgentError) as caught:
                agent_tools.my_account(KEY)
        self.assertIn("didn't accept that API key", str(caught.exception))

    def test_the_account_says_whether_it_can_submit(self):
        self.assertEqual(agent_tools.my_account(KEY)["ready_to_submit"], True)

    def test_the_contract_comes_in_submit_items_shape(self):
        contract = agent_tools.pool_contract("p1", KEY)
        self.assertEqual(contract["max_items_per_call"], 3)
        self.assertEqual([f["key"] for f in contract["fields"]], ["task", "solution", "level"])
        self.assertEqual(contract["fields"][2]["options"], ["easy", "hard"])

    def test_good_items_go_in_one_call_with_titles_and_the_method(self):
        result = agent_tools.submit_items("p1", [GOOD, dict(GOOD, task="Parse more flags", level="hard")], "ai_assisted", KEY)
        self.assertEqual((result["sent"], result["duplicates"]), (2, 0))
        (sent,) = self.sent("submit_pool_items")
        self.assertEqual(sent["bountyId"], "p1")
        self.assertEqual([item["title"] for item in sent["items"]], ["Parse flags", "Parse more flags"])
        self.assertEqual({item["generationMethod"] for item in sent["items"]}, {"ai_assisted"})

    def test_one_bad_item_stops_the_whole_set(self):
        with self.assertRaises(agent_tools.AgentError) as caught:
            agent_tools.submit_items("p1", [{"task": "No solution"}, dict(GOOD, level="medium"), "text"], "human", KEY)
        message = str(caught.exception)
        self.assertIn("Nothing was sent", message)
        for part in ('item 1: "solution" is required', "item 2: \"level\" must be one of", "item 3: must be an object"):
            self.assertIn(part, message)
        self.assertEqual(self.sent("submit_pool_items"), [])

    def test_the_method_and_the_pool_limit_are_enforced_before_sending(self):
        cases = {
            "unknown method": (lambda: agent_tools.submit_items("p1", [GOOD], "robot", KEY), "generation_method"),
            "no items": (lambda: agent_tools.submit_items("p1", [], "human", KEY), "at least one item"),
            "over the pool's limit": (lambda: agent_tools.submit_items("p1", [GOOD] * 4, "human", KEY), "at most 3 items"),
        }
        for name, (run, message) in cases.items():
            with self.subTest(name), self.assertRaises(agent_tools.AgentError) as caught:
                run()
            self.assertIn(message, str(caught.exception))
        self.assertEqual(self.sent("submit_pool_items"), [])

    def test_closed_pools_and_pools_needing_files_are_refused(self):
        self.contract = {**CONTRACT, "capacity": {"recommendedPath": "none", "nextStep": "The pool is full."}}
        with self.assertRaises(agent_tools.AgentError) as caught:
            agent_tools.submit_items("p1", [GOOD], "human", KEY)
        self.assertIn("isn't taking items", str(caught.exception))
        self.contract = {**CONTRACT, "datasetType": {"fields": FIELDS + [{"key": "shot", "role": "file", "required": True}]}}
        with self.assertRaises(agent_tools.AgentError) as caught:
            agent_tools.submit_items("p1", [GOOD], "human", KEY)
        self.assertIn("can't upload", str(caught.exception))
        self.assertEqual(self.sent("submit_pool_items"), [])

    def test_submissions_are_listed_and_filtered(self):
        listed = agent_tools.my_submissions(KEY, status="in_audit", pool_id="p1")
        self.assertEqual(self.sent("list_my_submissions"), [{"limit": 50, "status": "in_audit", "bountyId": "p1"}])
        self.assertEqual(listed["submissions"][0]["where_it_stands"], "In review")


    def test_a_sponsor_reads_their_pool_and_disputes_with_a_real_reason(self):
        with mock.patch.object(agent_tools.db, "pool_details", return_value={"fields": FIELDS}):
            pool = agent_tools.sponsor_items("p1", KEY, status="accepted")
        self.assertEqual(self.sent("get_sponsor_submission_evidence"), [{"bountyId": "p1", "limit": 50, "status": "accepted"}])
        self.assertEqual((pool["total"], pool["items"][0]["fields"], pool["items"][0]["can_dispute"]), (1, {"task": "t"}, True))
        with self.assertRaises(agent_tools.AgentError):
            agent_tools.dispute_item("s9", "tests_invalid", "bad", KEY)
        self.assertEqual(self.sent("dispute_accepted_submission"), [])
        self.assertTrue(agent_tools.dispute_item("s9", "tests_invalid", "The tests assert nothing.", KEY)["disputed"])


class CallWithKeyTest(unittest.TestCase):
    def test_the_key_is_the_bearer_and_a_refusal_is_not_signed_in(self):
        reply = mock.Mock(status_code=200, text='{"result": {"content": [{"type": "text", "text": "{\\"ok\\": true}"}]}}')
        with mock.patch.object(account._client, "post", return_value=reply) as post:
            self.assertEqual(account.call_tool_with_key(KEY, "whoami"), {"ok": True})
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], f"Bearer {KEY}")
        with mock.patch.object(account._client, "post", return_value=mock.Mock(status_code=401)):
            with self.assertRaises(account.NotSignedIn):
                account.call_tool_with_key(KEY, "whoami")

    def test_anything_but_a_databounty_key_never_leaves(self):
        with mock.patch.object(account._client, "post") as post:
            with self.assertRaises(account.NotSignedIn):
                account.call_tool_with_key("hf_secret_token", "whoami")
        post.assert_not_called()


try:
    import gradio as gr
except ImportError:  # pragma: no cover - only where gradio isn't installed
    gr = None


@unittest.skipIf(gr is None, "gradio is not installed")
class ToolWiringTest(unittest.TestCase):
    def test_the_key_header_comes_last_in_every_agent_tool(self):
        # Gradio writes a header's value at its parameter's position, over any argument there.
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "databounty"))
        import app

        for tool in (app.get_my_account, app.get_pool_contract, app.submit_items, app.list_my_submissions, app.check_submission,
                     app.get_pool_items_as_sponsor, app.dispute_accepted_item):
            with self.subTest(tool.__name__):
                params = list(inspect.signature(tool).parameters)
                self.assertEqual(params[-1], "x_databounty_key")
                self.assertIs(typing.get_type_hints(tool)["x_databounty_key"], gr.Header)


if __name__ == "__main__":
    unittest.main()
