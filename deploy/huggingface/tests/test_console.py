# SPDX-License-Identifier: Apache-2.0
"""Run with: python -m unittest discover -s deploy/huggingface/tests

The signed-in Space's console pages: console.py's data shaping and the /api/console routes. Hermetic:
DataBounty's tools and public API are stubbed, nothing touches the network.
"""

import os
import sys
import time
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock

os.environ.setdefault("SPACE_PUBLIC_URL", "https://example-space.hf.space")
os.environ.setdefault("DATABOUNTY_MCP_URL", "https://console.example.test/mcp")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "databounty"))

import console  # noqa: E402

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except ImportError:  # pragma: no cover - only where fastapi isn't installed
    FastAPI = None

if FastAPI is not None:
    import account
    import webapi

NOW = datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc)  # a Wednesday
LADDER = [
    {"label": "Bodhi", "minKarma": 5000, "color": "#d4a24e", "earlyAccessHours": 24},
    {"label": "Dharma", "minKarma": 0, "color": "#8a9382", "earlyAccessHours": 0},
    {"label": "Moksha", "minKarma": 50000, "color": "#b6ff1c", "earlyAccessHours": 48},
]
KARMA = {
    "totalKarma": 1240,
    "tier": {
        "current": {"label": "Dharma", "minKarma": 0, "color": "#8a9382", "blurb": "The path is taken.", "perks": ["Leaderboard listing"]},
        "next": {"label": "Bodhi", "minKarma": 5000, "color": "#d4a24e", "perks": ["Everything in Dharma", "Batch sizes up to 25 items"]},
        "progress": 0.248,
    },
    "leaderboardRank": 7,
}


def sub(status, created, pool="p1", title="CLI parsers"):
    return {"id": f"s-{status}-{created}", "status": status, "createdAt": created, "bounty": {"id": pool, "title": title, "karmaPerAcceptedItem": 25}}


class ConsoleViewsTest(unittest.TestCase):
    def test_weeks_start_on_monday_utc_and_end_with_this_week(self):
        self.assertEqual(console.week_start(NOW), date(2026, 10, 26))
        self.assertEqual(console.week_start(datetime(2026, 10, 26, 0, 30, tzinfo=timezone.utc)), date(2026, 10, 26))
        span = console.week_range(4, NOW)
        self.assertEqual(span, [date(2026, 10, 5), date(2026, 10, 12), date(2026, 10, 19), date(2026, 10, 26)])

    def test_analytics_groups_by_the_week_sent_and_where_items_stand_today(self):
        subs = [
            sub("accepted", "2026-10-27T09:00:00Z"),
            sub("in_audit", "2026-10-26T01:00:00Z"),
            sub("needs_fixes", "2026-10-20T09:00:00Z"),
            sub("rejected", "2026-10-19T09:00:00Z"),
            sub("accepted", "2026-08-01T09:00:00Z"),  # before the window
            {"status": "accepted"},  # no time
        ]
        events = [{"amount": 40, "createdAt": "2026-10-27T09:00:00Z"}, {"amount": -5, "createdAt": "2026-10-21T09:00:00Z"},
                  {"amount": "40", "createdAt": "2026-10-27T09:00:00Z"}]
        view = console.analytics_view(subs, events, 4, NOW)
        self.assertEqual(view["range"], {"weeks": 4, "from": "2026-10-05", "to": "2026-10-28"})
        this_week, last_week = view["submissions"]["weeks"][-1], view["submissions"]["weeks"][-2]
        self.assertEqual((this_week["accepted"], this_week["inReview"]), (1, 1))
        self.assertEqual((last_week["needsFixes"], last_week["rejected"]), (1, 1))
        self.assertEqual(view["submissions"]["totals"], {"accepted": 1, "inReview": 1, "needsFixes": 1, "rejected": 1})
        self.assertEqual([w["karma"] for w in view["karma"]["weeks"]], [0, 0, -5, 40])
        self.assertEqual(view["karma"]["totals"], {"karma": 35})

    def test_tier_view_reads_the_next_tier_and_progress(self):
        view = console.tier_view(KARMA)
        self.assertEqual((view["total"], view["tier"]["label"], view["progress"], view["rank"]), (1240, "Dharma", 25, 7))
        self.assertEqual((view["next"]["label"], view["next"]["toGo"]), ("Bodhi", 3760))
        top = console.tier_view({"totalKarma": 600000, "tier": {"current": {"label": "Nirvana"}, "next": None}})
        self.assertEqual((top["next"], top["progress"]), (None, 100))
        self.assertEqual(console.tier_view({})["total"], 0)

    def test_every_tier_lists_its_perks(self):
        tiers = console.tiers_view(LADDER, console.tier_view(KARMA))
        self.assertEqual([(t["label"], t["state"]) for t in tiers], [("Dharma", "current"), ("Bodhi", "locked"), ("Moksha", "locked")])
        self.assertEqual(tiers[0]["perks"], ["Leaderboard listing"])
        self.assertEqual(tiers[1]["perks"], ["Everything in Dharma", "Batch sizes up to 25 items"])  # DataBounty's own words
        self.assertEqual(tiers[2]["perks"], ["Everything in Bodhi", "48h early access to new pools"])  # from the public ladder
        higher = console.tier_view({**KARMA, "totalKarma": 60000, "tier": {"current": {"label": "Moksha", "perks": ["Claim priority queue"]}}})
        self.assertEqual([t["state"] for t in console.tiers_view(LADDER, higher)], ["unlocked", "unlocked", "current"])

    def test_karma_events_read_as_the_console_names_them(self):
        row = console.karma_event_row({"eventType": "community_item_accepted", "amount": 40, "createdAt": "2026-10-26T05:58:07Z",
                                       "metadata": {"bountyTitle": "CLI parsers"}})
        self.assertEqual(row, {"kind": "accepted item", "tone": "ok", "source": "CLI parsers", "amount": 40, "day": "OCT 26, 2026"})
        odd = console.karma_event_row({"eventType": "something_new", "sourceType": "admin_tool"})
        self.assertEqual((odd["kind"], odd["source"], odd["amount"], odd["day"]), ("something new", "Admin tool", 0, ""))

    def test_my_submissions_group_into_one_row_per_pool(self):
        subs = [sub("accepted", "2026-10-20T00:00:00Z"), sub("needs_fixes", "2026-10-21T00:00:00Z"), sub("in_audit", "2026-10-22T00:00:00Z"),
                sub("submitted", "2026-10-23T00:00:00Z", pool="p2", title="Rate limiters")]
        rows = console.pool_groups(subs)
        self.assertEqual([r["poolId"] for r in rows], ["p2", "p1"])  # the most recent first
        p1 = rows[1]
        self.assertEqual((p1["accepted"], p1["action"], p1["review"], p1["checking"], p1["total"], p1["karma"]), (1, 1, 1, 0, 3, 25))
        self.assertEqual(p1["filters"], ["all", "action", "outcome", "accepted"])
        self.assertEqual(rows[0]["filters"], ["all", "outcome"])

    def test_notifications_lead_where_databounty_routes_them(self):
        app = "https://console.example.test"
        cases = [
            ({"entityType": "submission", "entityId": "s1"}, {"href": "#/submission/s1"}),
            ({"entityType": "audit_window", "entityId": "w1"}, {"href": "#/audit/w1"}),
            ({"entityType": "bounty", "entityId": "p1"}, {"href": "#/pool/p1"}),
            ({"type": "badge.earned"}, {"href": "#/karma"}),
            ({"entityType": "rank"}, {"href": "#/profile"}),
            ({"entityType": "agent_issue", "entityId": "i1"}, {"href": "#/issues/i1"}),
            ({"entityType": "dataset_request", "entityId": "r1"}, {"external": f"{app}/sponsor/requests/r1/"}),
            ({"linkBountyId": "p9"}, {"href": "#/pool/p9"}),
            ({}, {"href": "#/notifications"}),
        ]
        for note, link in cases:
            with self.subTest(note):
                self.assertEqual(console.notification_link(note, app), link)
        view = console.notification_view({"id": "n1", "type": "submission.needs_fixes", "title": "Fix", "createdAt": "2026-10-28T11:58:00Z"}, NOW, app)
        self.assertEqual((view["tone"], view["when"], view["read"]), ("warn", "2m", False))
        self.assertEqual(console.notification_view({"type": "submission.accepted"}, NOW, app)["tone"], "ok")

    def test_relative_times(self):
        self.assertEqual(console.relative(None, NOW), "")
        self.assertEqual(console.relative(datetime(2026, 10, 28, 11, 59, 30, tzinfo=timezone.utc), NOW), "just now")
        self.assertEqual(console.relative(datetime(2026, 10, 28, 9, 0, tzinfo=timezone.utc), NOW), "3h")
        self.assertEqual(console.relative(datetime(2026, 10, 26, 9, 0, tzinfo=timezone.utc), NOW), "2d")
        self.assertEqual(console.relative(datetime(2026, 10, 5, 9, 0, tzinfo=timezone.utc), NOW), "Oct 5")

    def test_a_support_case_reads_like_the_consoles(self):
        issue = {"id": "i1", "summary": "Slow preview", "status": "needs_info", "impact": "degraded", "category": "upload_processing",
                 "resources": [{"id": "r"}], "createdAt": "2026-10-20T10:00:00Z", "updatedAt": "2026-10-28T10:00:00Z",
                 "events": [{"actorRole": "reporter", "type": "comment", "body": "Still slow"}, {"actorRole": "admin", "type": "status_change"}]}
        view = console.issue_view(issue, NOW)
        self.assertEqual((view["statusLabel"], view["needsAnswer"], view["canReply"]), ("Needs your answer", True, True))
        self.assertEqual((view["kind"], view["impact"], view["context"], view["updated"]), ("Upload processing", "Degraded", "1 attached", "2h"))
        self.assertEqual([(e["who"], e["type"]) for e in view["history"]], [("You", "comment"), ("DataBounty", "status change")])
        closed = console.issue_row({"status": "resolved"}, NOW)
        self.assertEqual((closed["open"], closed["context"]), (False, "No context attached"))


@unittest.skipIf(FastAPI is None, "fastapi is not installed")
class ConsoleApiTest(unittest.TestCase):
    def setUp(self):
        server = FastAPI()
        server.include_router(webapi.router)
        server.add_exception_handler(webapi.ApiError, webapi.api_error)
        self.client = TestClient(server)
        self.calls = []
        self.signed_out = False
        self.submission_pages = {None: {"items": [sub("accepted", "2026-10-27T09:00:00Z")], "nextCursor": "c2", "hasMore": True},
                                 "c2": {"items": [sub("needs_fixes", "2026-07-01T09:00:00Z", pool="p2", title="Rate limiters")],
                                        "nextCursor": "c3", "hasMore": True}}
        patcher = mock.patch.object(account, "call_tool", side_effect=self.call_tool)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name, value in (("tiers", LADDER), ("open_pools", [{"id": "mine", "title": "Mine"}, {"id": "theirs", "title": "Theirs"}])):
            patcher = mock.patch.object(webapi.db, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(webapi, "_now", return_value=NOW)
        patcher.start()
        self.addCleanup(patcher.stop)
        webapi._SPONSORED.clear()
        self.addCleanup(webapi._SPONSORED.clear)
        self.session_id = f"console-{id(self)}"
        self.session = account.Session(access_token="at", refresh_token=None, expires_at=time.time() + 3600,
                                       scope="read contribute validate artifact sponsor account")
        with account._store_lock:
            account._sessions[account._digest(self.session_id)] = self.session
        self.addCleanup(lambda: account._sessions.pop(account._digest(self.session_id), None))
        self.auth = {"Authorization": f"Bearer {self.session_id}"}

    def call_tool(self, session, name, arguments=None):
        self.calls.append((name, arguments))
        arguments = arguments or {}
        if self.signed_out:
            raise account.NotSignedIn("expired")
        if name == "whoami":
            return {"handle": "asha", "displayName": "Asha Rao", "email": "asha@example.test", "badges": [{"label": "Accepted work"}, {"x": 1}],
                    "ranks": {"contributor": {"rank": "Scout", "nextRank": {"name": "Apprentice", "itemsToGo": 24}},
                              "validator": {"rank": "Observer", "decidedFlags": 5, "dismissedFlags": 1, "maxConcurrentAudits": 2}}}
        if name == "get_my_work_progress":
            return {"contributor": {"submitted": 3}, "validator": {"claimedBatches": 4, "completedBatches": 3}}
        if name == "get_karma_details":
            if arguments.get("cursor") == "k2":  # the last page
                return {**KARMA, "events": [], "eventCount": 3, "hasMore": False, "nextCursor": None}
            events = [{"eventType": "admin_adjustment", "amount": 1185, "createdAt": "2026-10-27T09:00:00Z"}]
            return {**KARMA, "events": events, "eventCount": 3, "hasMore": True, "nextCursor": "k2", "breakdown": {"admin_adjustment": {"total": 1185}}}
        if name == "list_notifications":
            return {"items": [{"id": "n1", "type": "submission.accepted", "title": "Accepted", "entityType": "submission", "entityId": "s1",
                               "createdAt": "2026-10-28T11:00:00Z"}], "unreadCount": 2, "hasMore": False, "nextCursor": "ignored"}
        if name == "mark_notifications_read":
            return {"ok": True}
        if name == "list_my_submissions":
            return self.submission_pages.get(arguments.get("cursor"), {"items": []})
        if name == "list_my_issues":
            return {"items": [{"id": "i1", "summary": "Slow preview", "status": "needs_info"}], "issueCount": 1, "hasMore": False}
        if name in ("get_issue", "reply_to_issue"):
            return {"id": arguments["issueId"], "summary": "Slow preview", "status": "investigating", "events": []}
        if name == "get_attribution_preference":
            return {"profilePublic": False, "publicProfilePrefs": {"showKarma": True}, "optOut": False}
        if name == "get_sponsor_submission_evidence":
            if arguments["bountyId"] == "mine":
                return {"total": 3, "submissions": []}
            if arguments["bountyId"] == "slow":
                raise account.ToolError("DataBounty didn't answer in time. Try again in a moment.")
            raise account.ToolError("only the bounty owner can inspect submissions")
        raise account.ToolError(f"{name} isn't stubbed")

    def sent(self, name):
        return [arguments for called, arguments in self.calls if called == name]

    def get(self, path):
        res = self.client.get(path, headers=self.auth)
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()

    def test_console_routes_need_a_sign_in(self):
        for path in ("/api/console/shell", "/api/console/analytics", "/api/console/karma", "/api/console/sponsor", "/api/console/issues"):
            with self.subTest(path):
                self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.calls, [])

    def test_the_sidebar_shows_karma_and_unread(self):
        body = self.get("/api/console/shell")
        self.assertEqual((body["total"], body["tier"]["label"], body["next"]["toGo"], body["unread"]), (1240, "Dharma", 3760, 2))

    def test_analytics_reads_back_only_as_far_as_its_weeks(self):
        body = self.get("/api/console/analytics?weeks=7")  # not a choice on the page: the default
        self.assertEqual(body["range"]["weeks"], 12)
        self.assertEqual(self.sent("list_my_submissions"), [{"limit": 100}, {"limit": 100, "cursor": "c2"}])  # c2 reached July: stop
        since = "2026-08-10T00:00:00+00:00"
        self.assertEqual(self.sent("get_karma_details"), [{"limit": 100, "since": since}, {"limit": 100, "since": since, "cursor": "k2"}])
        self.assertEqual((body["submissions"]["totals"]["accepted"], body["karma"]["totals"]["karma"]), (1, 1185))

    def test_contributor_and_validator_headers(self):
        contributor = self.get("/api/console/contributor")
        self.assertEqual(contributor["rank"], {"name": "Scout", "next": "Apprentice", "toGo": 24})
        self.assertEqual(contributor["funnel"], {"submitted": 3})
        validator = self.get("/api/console/validator")
        self.assertEqual(validator["flags"], {"decided": 5, "dismissed": 1})
        self.assertEqual((validator["reviewer"]["rank"], validator["reviewer"]["maxConcurrent"], validator["work"]["claimedBatches"]), ("Observer", 2, 4))

    def test_my_pools_filter_and_search(self):
        self.submission_pages["c2"]["hasMore"] = False
        everything = self.get("/api/console/my-pools")
        self.assertEqual((everything["submitted"], [p["poolId"] for p in everything["pools"]]), (2, ["p1", "p2"]))
        self.assertEqual(everything["counts"], {"all": 2, "action": 1, "outcome": 0, "accepted": 1})
        self.assertEqual([p["poolId"] for p in self.get("/api/console/my-pools?filter=action")["pools"]], ["p2"])
        self.assertEqual([p["poolId"] for p in self.get("/api/console/my-pools?q=%20RATE%20")["pools"]], ["p2"])
        self.assertEqual(len(self.get("/api/console/my-pools?filter=bogus")["pools"]), 2)

    def test_karma_history_filters_by_kind_and_pages(self):
        body = self.get("/api/console/karma?kind=admin_adjustment&cursor=k1")
        self.assertEqual(self.sent("get_karma_details")[0], {"limit": 20, "cursor": "k1", "eventType": "admin_adjustment"})
        self.assertEqual((body["nextCursor"], body["eventCount"], body["badges"]), ("k2", 3, ["Accepted work"]))
        self.assertEqual([t["label"] for t in body["tiers"]], ["Dharma", "Bodhi", "Moksha"])
        self.assertEqual(body["events"][0]["kind"], "adjustment")
        self.get("/api/console/karma?kind=drop_table")
        self.assertNotIn("eventType", self.sent("get_karma_details")[-1])

    def test_karma_still_shows_when_the_public_ladder_is_down(self):
        with mock.patch.object(webapi.db, "tiers", side_effect=webapi.db.UpstreamError("down")):
            body = self.get("/api/console/karma")
        self.assertEqual((body["tiers"], body["karma"]["total"]), ([], 1240))

    def test_profile_is_read_only_and_links_to_settings(self):
        body = self.get("/api/console/profile")
        self.assertEqual((body["handle"], body["profilePublic"], body["prefs"]), ("asha", False, {"showKarma": True}))
        self.assertTrue(body["publicUrl"].endswith("/asha"))
        self.assertTrue(body["settingsUrl"].endswith("/profile/"))

    def test_notifications_list_and_mark_read(self):
        body = self.get("/api/console/notifications?unread=true&cursor=n0")
        self.assertEqual(self.sent("list_notifications"), [{"limit": 30, "unreadOnly": True, "cursor": "n0"}])
        self.assertEqual((body["unread"], body["nextCursor"], body["items"][0]["href"], body["items"][0]["when"]), (2, None, "#/submission/s1", "1h"))
        self.client.post("/api/console/notifications/read", json={"id": "n1"}, headers=self.auth)
        self.client.post("/api/console/notifications/read", json={}, headers=self.auth)
        self.assertEqual(self.sent("mark_notifications_read"), [{"notificationId": "n1"}, {}])

    def test_support_cases_search_and_reply(self):
        self.get("/api/console/issues?status=bogus&q=a")
        self.get("/api/console/issues?status=resolved&q=%20%20slow%20%20%20preview%20")
        self.assertEqual(self.sent("list_my_issues"), [{"limit": 20}, {"limit": 20, "status": "resolved", "q": "slow preview"}])
        self.assertEqual(self.get("/api/console/issues")["waiting"], 1)
        for body, message in (("   ", "Write a reply first."), ("x" * 2001, "Keep the reply under 2000 characters.")):
            res = self.client.post("/api/console/issues/i1/reply", json={"body": body}, headers=self.auth)
            self.assertEqual((res.status_code, res.json()["error"]), (400, message))
        self.assertEqual(self.sent("reply_to_issue"), [])
        res = self.client.post("/api/console/issues/i1/reply", json={"body": " It still takes a minute. "}, headers=self.auth)
        self.assertEqual((res.status_code, res.json()["statusLabel"]), (200, "Investigating"))
        self.assertEqual(self.sent("reply_to_issue"), [{"issueId": "i1", "body": "It still takes a minute."}])

    def test_sponsor_finds_the_persons_pools_and_remembers_them(self):
        body = self.get("/api/console/sponsor")
        self.assertEqual([(p["id"], p["items"]) for p in body["pools"]], [("mine", 3)])
        self.assertTrue(body["requestUrl"].endswith("/sponsor/create/"))
        self.assertEqual(len(self.sent("get_sponsor_submission_evidence")), 2)
        self.get("/api/console/sponsor")
        self.assertEqual(len(self.sent("get_sponsor_submission_evidence")), 2)  # remembered
        self.get("/api/console/sponsor?fresh=true")
        self.assertEqual(len(self.sent("get_sponsor_submission_evidence")), 4)

    def test_sponsor_forgets_old_answers(self):
        webapi._SPONSORED["someone-else"] = (time.monotonic() - webapi.SPONSORED_TTL - 1, [])
        self.get("/api/console/sponsor")
        self.assertNotIn("someone-else", webapi._SPONSORED)
        self.assertEqual(len(webapi._SPONSORED), 1)

    def test_sponsor_does_not_remember_a_pool_databounty_didnt_answer_for(self):
        with mock.patch.object(webapi.db, "open_pools", return_value=[{"id": "mine"}, {"id": "slow"}]):
            first = self.get("/api/console/sponsor")
            self.assertEqual((first["partial"], [p["id"] for p in first["pools"]]), (True, ["mine"]))
            self.get("/api/console/sponsor")
        self.assertEqual(len(self.sent("get_sponsor_submission_evidence")), 4)  # asked again

    def test_sponsor_asks_to_sign_in_again_when_the_sign_in_ended(self):
        self.signed_out = True
        res = self.client.get("/api/console/sponsor", headers=self.auth)
        self.assertEqual(res.status_code, 401)
        self.assertEqual(webapi._SPONSORED, {})

    def test_sponsor_without_the_sponsor_permission(self):
        self.session.scope = "read contribute validate artifact account"
        body = self.get("/api/console/sponsor")
        self.assertEqual((body["needsScope"], body["pools"]), (True, []))
        self.assertEqual(self.sent("get_sponsor_submission_evidence"), [])

    def test_developers_reads_the_public_developer_surface(self):
        surface = {"mcpRemoteUrl": "https://api.example.test/mcp", "rateLimitPerMinute": 300, "mcpTools": [{"name": "a"}, {"name": "b"}]}
        with mock.patch.object(webapi.db, "developer_surface", return_value=surface):
            body = self.client.get("/api/console/developers").json()
        self.assertEqual((body["mcpUrl"], body["rateLimit"], body["toolCount"]), ("https://api.example.test/mcp", 300, 2))
        self.assertTrue(body["keysUrl"].endswith("/developers/"))


if __name__ == "__main__":
    unittest.main()
