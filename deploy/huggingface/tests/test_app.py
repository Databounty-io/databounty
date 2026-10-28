# SPDX-License-Identifier: Apache-2.0
"""Run with: python -m unittest discover -s deploy/huggingface/tests  (needs gradio installed)

Spaces set GRADIO_SSR_MODE=true. With SSR on, mounting Gradio starts a Node server on the
Space's one public port, uvicorn can't bind it, and the Space crash-loops with "address already
in use". That shipped once; this pins SSR off whatever the environment says.
"""

import importlib
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

SPACE_DIR = Path(__file__).resolve().parents[1] / "databounty"

try:
    import gradio  # noqa: F401
except ImportError:  # pragma: no cover - only where gradio isn't installed
    gradio = None

META = {
    "issuer": "https://console.example.test/mcp",
    "authorization_endpoint": "https://console.example.test/mcp/oauth/authorize",
    "token_endpoint": "https://console.example.test/mcp/oauth/token",
}


def load_app():
    os.environ["GRADIO_SSR_MODE"] = "true"
    sys.path.insert(0, str(SPACE_DIR))
    cwd = os.getcwd()
    os.chdir(SPACE_DIR)
    try:
        return importlib.import_module("app")
    finally:
        os.chdir(cwd)


@unittest.skipIf(gradio is None, "gradio is not installed")
class AppMountTest(unittest.TestCase):
    def test_ssr_stays_off_even_when_spaces_turn_it_on(self):
        app = load_app()
        self.assertIs(app.demo.ssr_mode, False)
        paths = {getattr(route, "path", "") for route in app.app.routes}
        self.assertTrue({"/oauth/start", "/oauth/callback", "/oauth/status", "/oauth/client-metadata.json"} <= paths)

    def test_the_page_its_files_and_its_api_answer_before_gradio(self):
        from fastapi.testclient import TestClient

        client = TestClient(load_app().app)
        page = client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn('id="page"', page.text)
        self.assertEqual(page.headers["cache-control"], "no-cache")
        for path in ("/static/app.js", "/static/app.css", "/static/logo.svg"):
            with self.subTest(path):
                self.assertEqual(client.get(path).status_code, 200)
        # index.html versions app.css and app.js, so browsers keep those; anything else, for an hour.
        self.assertEqual(client.get("/static/app.js?v=9").headers["cache-control"], "public, max-age=31536000, immutable")
        self.assertEqual(client.get("/static/logo.svg").headers["cache-control"], "public, max-age=3600")
        # The page's own routes are compressed; Gradio's, the MCP server among them, are not.
        for path in ("/static/app.js?v=9", "/api/me"):
            with self.subTest(path):
                self.assertEqual(client.get(path, headers={"Accept-Encoding": "gzip"}).headers.get("content-encoding"), "gzip" if "static" in path else None)
        gradio_route = client.get("/gradio_api/info", headers={"Accept-Encoding": "gzip"})
        self.assertNotEqual(gradio_route.headers.get("content-encoding"), "gzip")
        self.assertEqual(client.get("/api/me").status_code, 401)
        self.assertEqual(client.get("/api/me").json(), {"error": "Sign in to continue."})


@unittest.skipIf(gradio is None, "gradio is not installed")
class SignInRoutesTest(unittest.TestCase):
    """The routes that start and finish a sign-in (see account.py for the whole flow)."""

    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient

        cls.app = load_app()
        cls.account = cls.app.account
        cls.client = TestClient(cls.app.app)
        cls.hash = "ab" * 32

    def test_start_refuses_a_sign_in_the_page_did_not_start(self):
        cases = {
            "no hash": ("/oauth/start", {"Sec-Fetch-Site": "same-origin"}),
            "a link from another site": (f"/oauth/start?n={self.hash}", {"Sec-Fetch-Site": "cross-site"}),
            "a link opened from anywhere": (f"/oauth/start?n={self.hash}", {"Sec-Fetch-Site": "none"}),
            "no fetch metadata": (f"/oauth/start?n={self.hash}", {}),
        }
        for name, (url, headers) in cases.items():
            with self.subTest(name):
                res = self.client.get(url, headers=headers, follow_redirects=False)
                self.assertEqual(res.status_code, 400)
                self.assertNotIn(self.account.LOGIN_COOKIE, res.cookies)

    def test_start_from_the_page_goes_to_databounty_with_the_hash_in_the_login_cookie(self):
        with mock.patch.object(self.account, "server_metadata", return_value=META):
            res = self.client.get(
                f"/oauth/start?n={self.hash}&popup=1", headers={"Sec-Fetch-Site": "same-origin"}, follow_redirects=False
            )
        self.assertEqual(res.status_code, 302)
        self.assertTrue(res.headers["location"].startswith(META["authorization_endpoint"]))
        context = self.account.login_context(res.cookies.get(self.account.LOGIN_COOKIE))
        self.assertEqual(context, {"n": self.hash, "p": True})

    def callback(self, popup: bool, nonce_hash: str):
        cookie = self.account._seal({"s": "s", "v": "v", "t": 0, "n": nonce_hash, "p": popup})
        with mock.patch.object(self.account, "complete_sign_in", return_value=f"session-{nonce_hash[:6]}"):
            self.client.cookies.set(self.account.LOGIN_COOKIE, cookie)
            try:
                return self.client.get("/oauth/callback?code=c&state=s", follow_redirects=False)
            finally:
                self.client.cookies.clear()

    def test_callback_in_a_window_holds_the_session_and_closes_itself(self):
        nonce_hash = "c1" * 32
        res = self.callback(True, nonce_hash)
        self.assertEqual(res.status_code, 200)
        self.assertIn("signed in</h1>", res.text)
        self.assertIn("window.close()", res.text)
        self.assertTrue(self.account.sign_in_ready(nonce_hash))

    def test_callback_in_the_same_tab_returns_to_the_page(self):
        nonce_hash = "d2" * 32
        res = self.callback(False, nonce_hash)
        self.assertEqual(res.status_code, 302)
        self.assertEqual(res.headers["location"], "/")
        self.assertTrue(self.account.sign_in_ready(nonce_hash))

    def test_status_says_only_whether_the_sign_in_finished(self):
        nonce_hash = "e3" * 32
        self.assertEqual(self.client.get(f"/oauth/status?n={nonce_hash}").json(), {"ready": False})
        self.account.hold_sign_in(nonce_hash, "session-e3")
        body = self.client.get(f"/oauth/status?n={nonce_hash}").json()
        self.assertEqual(body, {"ready": True})
        self.assertNotIn("session", str(body))


if __name__ == "__main__":
    unittest.main()
