# SPDX-License-Identifier: Apache-2.0
"""Run with: python -m unittest discover -s deploy/huggingface/tests"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "databounty"))

from items import check_rows, coerce_for_contract, item_problems, parse_bulk  # noqa: E402

FIELDS = [
    {"key": "instruction", "label": "Instruction", "role": "instruction", "required": True},
    {"key": "difficulty", "label": "Difficulty", "role": "enum", "options": ["easy", "hard"]},
    {"key": "tags", "label": "Tags", "role": "list", "required": True},
]


class ItemProblemsTest(unittest.TestCase):
    """Must agree with apps/api/src/services/item-contract.ts, case for case."""

    def test_conforming_item_with_extra_keys(self):
        self.assertEqual(item_problems(FIELDS, {"instruction": "x", "tags": ["a"], "agent_run": "r1"}), [])

    def test_blank_values_are_missing(self):
        for blank in (None, "", "   ", [], {}):
            self.assertEqual(item_problems(FIELDS, {"instruction": blank, "tags": ["a"]}), ['"instruction" is required'])

    def test_false_and_zero_are_values(self):
        self.assertEqual(item_problems(FIELDS, {"instruction": False, "tags": ["a"]}), [])
        self.assertEqual(item_problems(FIELDS, {"instruction": 0, "tags": ["a"]}), [])

    def test_enum_must_be_an_option_but_may_be_left_empty(self):
        self.assertEqual(
            item_problems(FIELDS, {"instruction": "x", "tags": ["a"], "difficulty": "medium"}),
            ["\"difficulty\" must be one of 'easy', 'hard'"],
        )
        self.assertEqual(item_problems(FIELDS, {"instruction": "x", "tags": ["a"], "difficulty": " hard "}), [])
        self.assertEqual(item_problems(FIELDS, {"instruction": "x", "tags": ["a"], "difficulty": ""}), [])

    def test_multi_file_field_needs_min_count(self):
        files = [{"key": "images", "role": "file", "required": True, "minCount": 2, "maxCount": 4}]
        self.assertEqual(item_problems(files, {"images": ["a", "b"]}), [])
        self.assertEqual(item_problems(files, {"images": ["a"]}), ['"images" is required'])
        self.assertEqual(item_problems(files, {"images": "a"}), ['"images" is required'])


class ParseBulkTest(unittest.TestCase):
    def test_jsonl_numbers_rows_and_flags_bad_lines(self):
        rows = parse_bulk(b'{"instruction": "a"}\n\nnot json\n[1, 2]\n{"instruction": "b"}\n', "items.jsonl")
        self.assertEqual([r.number for r in rows], [1, 2, 3, 4])
        self.assertEqual([r.error is None for r in rows], [True, False, False, True])

    def test_json_must_be_an_array(self):
        self.assertEqual(len(parse_bulk(b'[{"instruction": "a"}, {"instruction": "b"}]', "items.json")), 2)
        with self.assertRaises(ValueError):
            parse_bulk(b'{"instruction": "a"}', "items.json")

    def test_csv_with_quoted_commas_and_a_ragged_row(self):
        rows = parse_bulk(b'instruction,tags\n"sort, then dedupe",a\nonly-one-cell\n', "items.csv")
        self.assertEqual(rows[0].payload, {"instruction": "sort, then dedupe", "tags": "a"})
        self.assertIsNotNone(rows[1].error)

    def test_tsv_and_byte_order_mark(self):
        rows = parse_bulk("﻿instruction\ttags\nx\ty\n".encode("utf-8"), "items.tsv")
        self.assertEqual(rows[0].payload, {"instruction": "x", "tags": "y"})

    def test_unsupported_and_oversized_files_are_refused(self):
        with self.assertRaises(ValueError):
            parse_bulk(b"hello", "notes.txt")
        with self.assertRaises(ValueError):
            parse_bulk(b"x" * (10 * 1024 * 1024 + 1), "big.jsonl")

    def test_check_rows_attaches_contract_problems(self):
        rows = check_rows(parse_bulk(b'{"instruction": "a", "tags": ["t"]}\n{"tags": ["t"]}\n', "x.jsonl"), FIELDS)
        self.assertTrue(rows[0].ok)
        self.assertEqual(rows[1].problems, ['"instruction" is required'])


class CoerceTest(unittest.TestCase):
    def test_list_cells_become_lists_like_the_dashboard_form(self):
        self.assertEqual(
            coerce_for_contract(FIELDS, {"instruction": "x", "tags": "a, b\nc"}),
            {"instruction": "x", "tags": ["a", "b", "c"]},
        )


if __name__ == "__main__":
    unittest.main()
