# SPDX-License-Identifier: Apache-2.0
"""Run with: python -m unittest discover -s deploy/huggingface/tests

Hermetic: DataBounty's metadata and token endpoint are stubbed, nothing touches the network.
The full sign-in round trip against a real DataBounty API is exercised separately (see the PR).
"""

import os
import sys
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

os.environ.setdefault("SPACE_PUBLIC_URL", "https://example-space.hf.space")
os.environ.setdefault("DATABOUNTY_MCP_URL", "https://console.example.test/mcp")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "databounty"))

import account  # noqa: E402

META = {
    "issuer": "https://console.example.test/mcp",
    "authorization_endpoint": "https://console.example.test/mcp/oauth/authorize",
    "token_endpoint": "https://console.example.test/mcp/oauth/token",
    "revocation_endpoint": "https://console.example.test/mcp/oauth/revoke",
}
TOKENS = {"access_token": "db_mcp_at_x", "refresh_token": "db_mcp_rt_x", "expires_in": 28800, "scope": "read contribute"}


class SignInTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(account, "server_metadata", return_value=META)
        patcher.start()
        self.addCleanup(patcher.stop)

    def start(self):
        url, cookie = account.begin_sign_in()
        return parse_qs(urlsplit(url).query), cookie

    def test_authorize_url_asks_for_pkce_the_resource_and_only_the_needed_scopes(self):
        query, _ = self.start()
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertEqual(query["resource"], ["https://console.example.test/mcp"])
        self.assertEqual(query["client_id"], ["https://example-space.hf.space/oauth/client-metadata.json"])
        self.assertEqual(query["redirect_uri"], ["https://example-space.hf.space/oauth/callback"])
        self.assertEqual(set(query["scope"][0].split()), {"read", "contribute", "validate", "artifact", "sponsor", "account"})

    def test_completes_with_the_matching_cookie_and_keeps_tokens_server_side(self):
        query, cookie = self.start()
        with mock.patch.object(account, "_token_request", return_value=TOKENS) as token:
            session_id = account.complete_sign_in({"code": "c", "state": query["state"][0], "iss": META["issuer"]}, cookie)
        sent = token.call_args.args[0]
        self.assertEqual(sent["grant_type"], "authorization_code")
        self.assertEqual(sent["code_verifier"], account._unseal(cookie)["v"])
        self.assertNotIn("db_mcp_", session_id)
        self.assertEqual(account.session_for(session_id).access_token, "db_mcp_at_x")

    def test_refuses_without_touching_the_token_endpoint(self):
        query, cookie = self.start()
        state = query["state"][0]
        forged = cookie[:-4] + ("0000" if not cookie.endswith("0000") else "1111")
        expired = account._seal({"s": state, "v": "v" * 43, "t": int(time.time()) - account.LOGIN_TTL_SECONDS - 1})
        cases = {
            "no cookie": ({"code": "c", "state": state}, None),
            "another browser's state": ({"code": "c", "state": "someone-elses-state"}, cookie),
            "tampered cookie": ({"code": "c", "state": state}, forged),
            "expired": ({"code": "c", "state": state}, expired),
            "declined at DataBounty": ({"error": "access_denied", "state": state}, cookie),
            "a different issuer": ({"code": "c", "state": state, "iss": "https://evil.example/mcp"}, cookie),
            "no code": ({"state": state}, cookie),
        }
        with mock.patch.object(account, "_token_request") as token:
            for name, (params, login_cookie) in cases.items():
                with self.subTest(name), self.assertRaises(account.SignInError):
                    account.complete_sign_in(params, login_cookie)
        token.assert_not_called()

    def test_login_cookie_is_cookie_safe(self):
        _, cookie = self.start()
        self.assertRegex(cookie, r"^[A-Za-z0-9_-]+\.[0-9a-f]{64}$")


class ClaimTest(unittest.TestCase):
    """A finished sign-in goes only to the page that started it, which alone holds the secret."""

    def setUp(self):
        patcher = mock.patch.object(account, "server_metadata", return_value=META)
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def secret():
        nonce = f"page-secret-{time.time_ns()}"
        return nonce, account._digest(nonce)

    def test_the_login_cookie_carries_the_hash_and_whether_it_runs_in_a_window(self):
        _, nonce_hash = self.secret()
        _, cookie = account.begin_sign_in(nonce_hash, popup=True)
        self.assertEqual(account.login_context(cookie), {"n": nonce_hash, "p": True})
        self.assertEqual(account.login_context("forged.cookie"), {"n": "", "p": False})

    def test_only_the_secret_claims_the_session_and_only_once(self):
        nonce, nonce_hash = self.secret()
        self.assertFalse(account.sign_in_ready(nonce_hash))
        account.hold_sign_in(nonce_hash, "session-1")
        self.assertTrue(account.sign_in_ready(nonce_hash))
        self.assertIsNone(account.claim_sign_in(nonce_hash))  # the hash alone claims nothing
        self.assertIsNone(account.claim_sign_in("another page's secret"))
        self.assertEqual(account.claim_sign_in(nonce), "session-1")
        self.assertIsNone(account.claim_sign_in(nonce))
        self.assertFalse(account.sign_in_ready(nonce_hash))

    def test_an_unclaimed_sign_in_expires(self):
        nonce, nonce_hash = self.secret()
        account.hold_sign_in(nonce_hash, "session-2")
        later = time.time() + account.CLAIM_TTL_SECONDS + 1
        with mock.patch.object(account.time, "time", return_value=later):
            self.assertFalse(account.sign_in_ready(nonce_hash))
            self.assertIsNone(account.claim_sign_in(nonce))

    def test_ready_answers_only_for_a_hash(self):
        for value in ("", "../etc/passwd", "A" * 64, "a" * 63):
            with self.subTest(value):
                self.assertFalse(account.sign_in_ready(value))


class TransportTest(unittest.TestCase):
    def test_reads_plain_json_and_one_event_sse(self):
        body = '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{}"}]}}'
        self.assertEqual(account._rpc_body(body)["id"], 1)
        self.assertEqual(account._rpc_body(f"event: message\ndata: {body}\n\n")["id"], 1)
        with self.assertRaises(account.ToolError):
            account._rpc_body(": keepalive\n\n")

    def test_client_metadata_matches_what_databounty_requires(self):
        doc = account.client_metadata()
        self.assertEqual(doc["client_id"], account.CLIENT_ID)
        self.assertEqual(doc["redirect_uris"], [account.REDIRECT_URI])
        self.assertEqual(doc["token_endpoint_auth_method"], "none")
        self.assertIn("authorization_code", doc["grant_types"])
        self.assertTrue(doc["client_name"])


if __name__ == "__main__":
    unittest.main()
