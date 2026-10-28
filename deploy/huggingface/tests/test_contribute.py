# SPDX-License-Identifier: Apache-2.0
"""Run with: python -m unittest discover -s deploy/huggingface/tests

The contributor screens' rules and wording: plain data, no network, no web server.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "databounty"))

import contribute  # noqa: E402

LONG_SPEC = (
    "THE GRADED ARTIFACT. Python code defining EXACTLY ONE top-level function named `build_parser`, with EXACTLY "
    "this signature: `def build_parser():` -- no arguments; it must construct and return a parser."
)
FIELDS = [
    {"key": "task", "label": "Task", "role": "instruction", "required": True, "help": "What to build, in one sentence."},
    {"key": "solution", "label": "Solution", "role": "solution_code", "required": True, "help": LONG_SPEC, "lang": "py"},
    {"key": "level", "label": "Level", "role": "enum", "required": False, "options": ["easy", "hard"]},
    {"key": "tags", "label": "Tags", "role": "list", "required": False},
    {"key": "screenshot", "label": "Screenshot", "role": "file", "required": False, "maxCount": 2},
]


class FieldTest(unittest.TestCase):
    def test_a_long_spec_gives_way_to_a_plain_hint_for_the_role(self):
        self.assertEqual(contribute.short_hint({"role": "solution_code", "help": LONG_SPEC}), "Your working solution.")

    def test_a_short_plain_help_is_kept(self):
        self.assertEqual(contribute.short_hint({"role": "instruction", "help": "The bug, in one sentence."}), "The bug, in one sentence.")

    def test_no_help_falls_back_to_the_role(self):
        self.assertEqual(contribute.short_hint({"role": "tests"}), "Tests that show the solution works.")
        self.assertEqual(contribute.short_hint({"role": "made-up"}), "")

    def test_code_fields_name_their_language(self):
        self.assertEqual(contribute.code_language({"lang": "py"}), "python")
        self.assertEqual(contribute.code_language({"lang": "go"}), "go")
        self.assertEqual(contribute.code_language({"label": "Parser builder (Python)"}), "python")
        self.assertEqual(contribute.code_language({"label": "Invocations", "help": "JSON array of runs"}), "json")
        self.assertIsNone(contribute.code_language({"label": "Notes"}))

    def test_each_role_gets_its_input(self):
        kinds = {spec["key"]: contribute.field_kind(spec) for spec in FIELDS}
        self.assertEqual(kinds, {"task": "longtext", "solution": "code", "level": "enum", "tags": "list", "screenshot": "file"})
        self.assertEqual(contribute.field_kind({"role": "enum"}), "text")  # an enum without options can't be a picker
        self.assertEqual(contribute.field_kind({"role": "reference"}), "text")


class TitleTest(unittest.TestCase):
    def test_the_title_comes_from_the_first_wording_field(self):
        self.assertEqual(contribute.title_for({"solution": "def f(): pass", "prompt": "  Reverse   a list  "}), "Reverse a list")

    def test_then_any_text_then_the_row(self):
        self.assertEqual(contribute.title_for({"x": "ab", "y": "Something longer"}), "Something longer")
        self.assertEqual(contribute.title_for({"x": 1}, 7), "Item from row 7")
        self.assertEqual(contribute.title_for(None), "Item from row 1")


class StatusTest(unittest.TestCase):
    """Checks read the way DataBounty reads them: no score means not run, never failed."""

    def test_check_states(self):
        cases = {
            "passed": ({"stage": "dedupe", "passed": True, "score": 0.1}, "pass"),
            "not run yet": ({"stage": "execution", "passed": False, "score": None}, "wait"),
            "failed with its reason": (
                {"stage": "execution", "passed": False, "score": 0.4, "detailJson": {"reason": "2 of 5 tests failed"}},
                "fail",
            ),
            "advisory quality review": ({"stage": "llm", "passed": False, "score": 41}, "note"),
            "pool filled first": ({"stage": "pool_capacity", "passed": False, "score": None}, "fail"),
            "close to a benchmark, for a reviewer": (
                {"stage": "contamination", "passed": True, "score": 0.4, "detailJson": {"contaminationDecision": "review_required"}},
                "note",
            ),
        }
        for name, (result, expected) in cases.items():
            with self.subTest(name):
                self.assertEqual(contribute.check_state(result)[0], expected)
        self.assertEqual(contribute.check_state(cases["failed with its reason"][0])[1], "2 of 5 tests failed")

    def test_statuses_group_the_way_people_think(self):
        self.assertEqual(contribute.status_view("tests_failed"), {"label": "Needs your fix", "tone": "warn", "group": "action"})
        self.assertEqual(contribute.status_view("in_audit")["label"], "In review")
        self.assertEqual(contribute.status_view("accepted")["group"], "accepted")
        self.assertEqual(contribute.status_view("brand_new_status")["label"], "Brand new status")

    def test_a_submission_lists_each_check_once_newest_first(self):
        sub = {
            "id": "s1",
            "title": "Reverse a list",
            "status": "tests_failed",
            "bounty": {"id": "p1", "title": "Python tasks"},
            "createdAt": "2026-10-22T10:00:00Z",
            "validationResults": [
                {"stage": "execution", "passed": False, "score": 0.2, "detailJson": {"reason": "1 of 3 tests failed"}},
                {"stage": "execution", "passed": False, "score": None},
                {"stage": "dedupe", "passed": True, "score": 0.0},
            ],
            "flags": [{"note": "Add a test for an empty list."}],
        }
        view = contribute.submission_view(sub, "https://console.example.test")
        self.assertEqual([(c["label"], c["state"]) for c in view["checks"]], [("Not a duplicate", "pass"), ("Tests in a sandbox", "fail")])
        self.assertEqual(view["checks"][1]["reason"], "1 of 3 tests failed")
        self.assertEqual(view["notes"], ["Add a test for an empty list."])
        self.assertEqual(view["fixUrl"], "https://console.example.test/contributor/submissions/s1/")
        self.assertEqual((view["pool"], view["date"], view["statusGroup"]), ("Python tasks", "2026-10-22", "action"))


class ContractTest(unittest.TestCase):
    RAW = {
        "bounty": {"title": "CLI parsers", "status": "active", "difficulty": "advanced", "karmaPricing": {"contributorPerItem": 40}, "communityLicense": "CC-BY-4.0"},
        "capacity": {"poolRemaining": 4940, "recommendedPath": "direct_submit"},
        "submitLimits": {"maxItemsPerRequest": 25},
        "datasetType": {
            "name": "Python function",
            "fields": FIELDS + [{"label": "no key"}],
            "sampleAssets": [{"fields": {"task": "Parse flags"}}, {"fields": {}}],
            "verification": {"pipeline": ["schema", "dedupe", "contamination", "execution", "human_audit"]},
        },
    }

    def test_the_pool_page_gets_what_it_draws(self):
        view = contribute.contract_view(self.RAW, "p1")
        self.assertTrue(view["open"])
        self.assertEqual((view["karma"], view["remaining"], view["maxItems"], view["license"]), (40, 4940, 25, "CC-BY-4.0"))
        self.assertEqual(view["tip"], contribute.DIFFICULTY_TIPS["advanced"])
        self.assertEqual([f["key"] for f in view["fields"]], ["task", "solution", "level", "tags", "screenshot"])
        self.assertEqual(view["fields"][1]["language"], "python")
        self.assertEqual(view["fields"][4]["maxCount"], 2)
        self.assertEqual(view["samples"], [{"task": "Parse flags"}])

    def test_only_checks_that_really_run_are_listed(self):
        # The schema check is the form itself, and DataBounty runs no benchmark screening yet.
        keys = [step["key"] for step in contribute.contract_view(self.RAW, "p1")["pipeline"]]
        self.assertEqual(keys, ["dedupe", "ai_attribution", "execution", "human_audit"])
        self.assertEqual([step["key"] for step in contribute.pipeline(None)], ["dedupe", "ai_attribution", "human_audit"])

    def test_a_full_or_closed_pool_is_not_open(self):
        full = {**self.RAW, "capacity": {"recommendedPath": "none", "nextStep": "This pool is full."}}
        self.assertFalse(contribute.contract_view(full, "p1")["open"])
        paused = {**self.RAW, "bounty": {**self.RAW["bounty"], "status": "paused"}}
        self.assertFalse(contribute.contract_view(paused, "p1")["open"])

    def test_the_public_view_has_the_same_shape(self):
        details = {"id": "p1", "title": "CLI parsers", "target_items": 100, "accepted_items": 40, "karma_per_accepted_item": 40, "status": "active", "fields": FIELDS}
        public = contribute.public_contract_view(details)
        self.assertEqual(set(public), set(contribute.contract_view(self.RAW, "p1")))
        self.assertEqual((public["remaining"], public["signedIn"], public["samples"]), (60, False, []))
        self.assertNotIn("execution", [step["key"] for step in public["pipeline"]])

    def test_the_public_view_shows_examples_and_sandbox_tests_when_the_record_has_them(self):
        details = {"id": "p1", "trust_tier": "execution_verified", "example_items": [{"task": "Parse flags"}, {}], "fields": FIELDS}
        public = contribute.public_contract_view(details)
        self.assertEqual(public["samples"], [{"task": "Parse flags"}])
        self.assertEqual([step["key"] for step in public["pipeline"]], ["dedupe", "ai_attribution", "execution", "human_audit"])


class ItemTest(unittest.TestCase):
    def views(self):
        return [contribute._field_view(spec) for spec in FIELDS]

    def test_values_become_the_payload(self):
        payload, problems = contribute.item_payload(
            self.views(), {"task": "  Parse flags ", "solution": "def f():\n    pass", "level": "", "tags": "cli\n\n parsing "}, {}
        )
        self.assertEqual(problems, [])
        self.assertEqual(payload, {"task": "Parse flags", "solution": "def f():\n    pass", "tags": ["cli", "parsing"]})

    def test_missing_fields_are_named_by_their_labels(self):
        _, problems = contribute.item_payload(self.views(), {"task": "x"}, {})
        self.assertEqual(problems, ["Fill in: Solution."])

    def test_a_wrong_option_and_too_many_files_are_refused(self):
        values = {"task": "x", "solution": "y"}
        _, problems = contribute.item_payload(self.views(), {**values, "level": "medium"}, {})
        self.assertEqual(problems, ["Level must be one of 'easy', 'hard'"])
        _, problems = contribute.item_payload(self.views(), values, {"screenshot": 3})
        self.assertEqual(problems, ["Screenshot takes at most 2 files."])

    def test_a_required_file_counts_when_attached(self):
        fields = [contribute._field_view({"key": "doc", "label": "Document", "role": "file", "required": True})]
        self.assertEqual(contribute.item_payload(fields, {}, {})[1], ["Fill in: Document."])
        self.assertEqual(contribute.item_payload(fields, {}, {"doc": 1}), ({}, []))

    def test_the_template_has_every_column_but_file_fields(self):
        self.assertEqual(contribute.template_csv(FIELDS).strip(), "task,solution,level,tags")
        self.assertIsNone(contribute.template_csv([FIELDS[4]]))


if __name__ == "__main__":
    unittest.main()
