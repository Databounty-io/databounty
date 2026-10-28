# SPDX-License-Identifier: Apache-2.0
"""Run with: python -m unittest discover -s deploy/huggingface/tests

The Space's public-data cache (databounty._cached). A fresh answer comes from memory; a stale one is
served at once while DataBounty is asked again in the background; only a cold or very old cache
makes a request wait, and requests arriving together share that one wait. No network: the loaders
are stand-ins.
"""

import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "databounty"))

import databounty as db  # noqa: E402


def settle(key, timeout=3.0):
    """Wait for the background refresh of `key` to finish."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with db._lock:
            if key not in db._refreshing:
                return
        time.sleep(0.01)
    raise AssertionError(f"the background refresh of {key} never finished")


class CacheTest(unittest.TestCase):
    def setUp(self):
        with db._lock:
            db._cache.clear()

    def age(self, key, seconds):
        with db._lock:
            _, value = db._cache[key]
            db._cache[key] = (time.monotonic() - seconds, value)

    def test_a_fresh_answer_comes_from_memory(self):
        calls = []
        load = lambda: calls.append(1) or len(calls)  # noqa: E731
        self.assertEqual(db._cached(("k",), load), 1)
        self.assertEqual(db._cached(("k",), load), 1)
        self.assertEqual(len(calls), 1)

    def test_a_stale_answer_is_served_at_once_while_one_refresh_runs_behind_it(self):
        db._cached(("k",), lambda: "old")
        self.age(("k",), db.CACHE_TTL_SECONDS + 1)
        release, calls = threading.Event(), []

        def slow():
            calls.append(1)
            release.wait(3)
            return "new"

        started = time.monotonic()
        self.assertEqual(db._cached(("k",), slow), "old")
        self.assertEqual(db._cached(("k",), slow), "old")
        self.assertLess(time.monotonic() - started, 0.5)  # nobody waited for DataBounty
        release.set()
        settle(("k",))
        self.assertEqual(len(calls), 1)  # one refresh, however many reads
        self.assertEqual(db._cached(("k",), lambda: "unused"), "new")

    def test_a_failed_refresh_keeps_serving_the_answer_we_have(self):
        db._cached(("k",), lambda: "old")
        self.age(("k",), db.CACHE_TTL_SECONDS + 1)

        def down():
            raise db.UpstreamError("DataBounty didn't answer.")

        with self.assertLogs(db.log, level="WARNING"):
            self.assertEqual(db._cached(("k",), down), "old")
            settle(("k",))
            self.assertEqual(db._cached(("k",), down), "old")  # still served; asked again
            settle(("k",))

    def test_a_very_old_answer_makes_the_request_wait_for_a_new_one(self):
        db._cached(("k",), lambda: "old")
        self.age(("k",), db.CACHE_MAX_STALE_SECONDS + 1)
        self.assertEqual(db._cached(("k",), lambda: "new"), "new")

    def test_requests_arriving_together_share_one_load(self):
        gate, calls, answers = threading.Event(), [], []

        def load():
            calls.append(1)
            gate.wait(3)
            return "value"

        readers = [threading.Thread(target=lambda: answers.append(db._cached(("k",), load))) for _ in range(5)]
        for reader in readers:
            reader.start()
        time.sleep(0.2)
        gate.set()
        for reader in readers:
            reader.join(5)
        self.assertEqual(answers, ["value"] * 5)
        self.assertEqual(len(calls), 1)

    def test_an_error_is_never_cached(self):
        def down():
            raise db.UpstreamError("DataBounty didn't answer.")

        with self.assertRaises(db.UpstreamError):
            db._cached(("k",), down)
        self.assertEqual(db._cached(("k",), lambda: "back"), "back")

    def test_a_refresh_is_built_from_fresh_parts(self):
        # The pool catalog is read page by page, each page cached on its own: refreshing the whole
        # must not rebuild it from stale pages.
        db._cached(("page",), lambda: "page 1")
        db._cached(("whole",), lambda: db._cached(("page",), lambda: "page 1") + " +")
        self.age(("page",), db.CACHE_TTL_SECONDS + 1)
        self.age(("whole",), db.CACHE_TTL_SECONDS + 1)
        rebuild = lambda: db._cached(("page",), lambda: "page 2") + " +"  # noqa: E731
        self.assertEqual(db._cached(("whole",), rebuild), "page 1 +")  # served at once
        settle(("whole",))
        self.assertEqual(db._cached(("whole",), rebuild), "page 2 +")


class WarmTest(unittest.TestCase):
    def test_warming_loads_the_first_pages_and_shrugs_off_an_outage(self):
        with mock.patch.object(db, "stats", side_effect=db.UpstreamError("down")) as stats, \
                mock.patch.object(db, "open_pools", return_value=[]) as pools, \
                mock.patch.object(db, "published_datasets", return_value=[]) as datasets, \
                mock.patch.object(db, "leaderboard", return_value=[]) as board, \
                self.assertLogs(db.log, level="WARNING"):
            db.warm()
        for loader in (stats, pools, datasets):
            loader.assert_called_once()
        board.assert_called_once_with(limit=100)


if __name__ == "__main__":
    unittest.main()
