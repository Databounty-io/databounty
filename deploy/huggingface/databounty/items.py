# SPDX-License-Identifier: Apache-2.0
"""Item checks and bulk-file parsing for contributing from the Space.

Both mirror DataBounty's own server code, so the Space can show a contributor
which rows will be refused before anything is sent:

- `item_problems` mirrors apps/api/src/services/item-contract.ts, the check
  every intake path applies: a required field must have a value, and an enum
  field's value must be one of its options.
- `parse_bulk` mirrors apps/api/src/services/jobs/bulk-source-parse.ts: JSONL,
  a JSON array of objects, or CSV/TSV with a header row.

The server stays the authority. These only save a round trip.
"""

from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass, field
from typing import Any

MAX_BULK_BYTES = 10 * 1024 * 1024


@dataclass
class Row:
    number: int
    payload: dict[str, Any] | None
    error: str | None = None
    problems: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.payload is not None and self.error is None and not self.problems


def _blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, (list, dict)):
        return len(value) == 0
    return str(value).strip() == ""


def item_problems(fields: list[dict[str, Any]], payload: dict[str, Any]) -> list[str]:
    """Why an item breaks its pool's field contract, in contract order. Empty when it conforms."""
    problems: list[str] = []
    for spec in fields:
        key = spec.get("key")
        if not isinstance(key, str):
            continue
        value = payload.get(key)
        if spec.get("required"):
            multi_file = spec.get("role") == "file" and (spec.get("maxCount") or 1) > 1
            missing = (
                not isinstance(value, list) or len(value) < (spec.get("minCount") or 1)
                if multi_file
                else _blank(value)
            )
            if missing:
                problems.append(f'"{key}" is required')
                continue
        options = spec.get("options")
        if spec.get("role") == "enum" and isinstance(options, list) and options and not _blank(value):
            allowed = [str(option) for option in options]
            if str(value).strip() not in allowed:
                problems.append(f'"{key}" must be one of {", ".join(f"{o!r}" for o in allowed)}')
    return problems


def _row(number: int, value: Any) -> Row:
    if not isinstance(value, dict):
        return Row(number, None, "row must be a JSON object of field values")
    return Row(number, value)


def parse_bulk(data: bytes, filename: str) -> list[Row]:
    """Numbered rows from a JSONL, JSON or CSV/TSV file. Raises ValueError for an unusable file."""
    if len(data) > MAX_BULK_BYTES:
        raise ValueError(f"That file is larger than {MAX_BULK_BYTES // (1024 * 1024)} MB.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("That file is not UTF-8 text.") from exc
    name = filename.lower()

    if name.endswith((".jsonl", ".ndjson")):
        rows: list[Row] = []
        number = 0
        for line in text.splitlines():
            if not line.strip():
                continue  # blank separator lines are not rows
            number += 1
            try:
                rows.append(_row(number, json.loads(line)))
            except json.JSONDecodeError:
                rows.append(Row(number, None, "line is not valid JSON"))
        return rows

    if name.endswith(".json"):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError("That file is not valid JSON.") from exc
        if not isinstance(parsed, list):
            raise ValueError("A JSON file must be an array of item objects.")
        return [_row(index + 1, value) for index, value in enumerate(parsed)]

    if name.endswith((".csv", ".tsv")):
        delimiter = "\t" if name.endswith(".tsv") else ","
        table = list(csv.reader(io.StringIO(text, newline=""), delimiter=delimiter))
        if not table or not table[0]:
            raise ValueError("That file has no header row.")
        columns = [column.strip() for column in table[0]]
        rows = []
        for index, cells in enumerate(table[1:]):
            if len(cells) != len(columns):
                rows.append(Row(index + 1, None, f"row has {len(cells)} fields, header declares {len(columns)}"))
                continue
            rows.append(Row(index + 1, dict(zip(columns, cells))))
        return rows

    raise ValueError("Upload a .jsonl, .json, .csv or .tsv file.")


def check_rows(rows: list[Row], fields: list[dict[str, Any]]) -> list[Row]:
    """Attach each parsed row's contract problems."""
    for row in rows:
        if row.payload is not None and row.error is None:
            row.problems = item_problems(fields, row.payload)
    return rows


def coerce_for_contract(fields: list[dict[str, Any]], payload: dict[str, Any]) -> dict[str, Any]:
    """CSV cells are strings; turn a list-role field's comma or newline separated cell into a list,
    the shape the dashboard's own form sends."""
    out = dict(payload)
    for spec in fields:
        key = spec.get("key")
        if spec.get("role") == "list" and isinstance(out.get(key), str):
            out[key] = [part.strip() for part in out[key].replace("\n", ",").split(",") if part.strip()]
    return out
