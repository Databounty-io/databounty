// SPDX-License-Identifier: Apache-2.0

/**
 * Escaping regression coverage for `renderEmail` — added 2026-09-02 after a V1
 * parity audit found this module interpolated every field into HTML with no
 * escaping at all, while V1 escapes at each interpolation.
 *
 * This matters because the inputs are user-controlled and the output is mailed
 * to third parties: `displayName` is validated only as 2-50 characters
 * (lib/display-name.ts), `invitedByName` is whatever an admin's profile says,
 * and Google's `identity.name` flows straight in on first sign-in
 * (routes/v1/auth.ts). Unescaped, that text renders as live markup in a
 * welcome, verify-email or admin-invite message — link spoofing, or a forged
 * "reset your password" CTA sitting above the real one.
 *
 * There were no email tests in this app before this file, which is how the
 * regression survived.
 */
import { describe, expect, it } from "vitest";
import { renderEmail } from "./email-template.js";

describe("renderEmail escaping", () => {
  it("escapes markup in the heading, paragraphs and footnote", () => {
    const { html } = renderEmail({
      heading: `Welcome <script>alert(1)</script>`,
      paragraphs: [`Hi <b>Bob</b> & "friends"`],
      footnote: `<img src=x onerror=alert(1)>`,
    });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>Bob</b>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;Bob&lt;/b&gt;");
    expect(html).toContain("&amp;");
  });

  it("escapes the button href so it cannot break out of the attribute", () => {
    // A quote in the href would otherwise close `href="` and let the rest of
    // the value inject attributes onto the anchor.
    const { html } = renderEmail({
      heading: "Verify your email",
      paragraphs: ["Confirm your address."],
      button: { label: `Verify <b>now</b>`, href: `https://x.test/a" onmouseover="alert(1)` },
    });

    expect(html).not.toContain(`onmouseover="alert(1)"`);
    expect(html).toContain("&quot;");
    expect(html).not.toContain("<b>now</b>");
  });

  it("leaves the plain-text part unescaped and readable", () => {
    // The text part is not markup, so escaping it would show users literal
    // `&amp;` in their mail client.
    const { text } = renderEmail({
      heading: "Welcome",
      paragraphs: [`Rock & Roll <not markup>`],
      button: { label: "Open", href: "https://x.test/a" },
    });

    expect(text).toContain("Rock & Roll <not markup>");
    expect(text).not.toContain("&amp;");
    expect(text).toContain("https://x.test/a");
  });

  it("prints the link under the button as a fallback", () => {
    const { html } = renderEmail({
      heading: "Reset your password",
      paragraphs: ["Use the button below."],
      button: { label: "Reset", href: "https://x.test/reset?token=abc" },
    });
    // Clients that strip styled anchors, and anyone forwarding as plain text,
    // otherwise lose the only way to act on the mail.
    expect(html).toContain("paste this into your browser");
    expect((html.match(/https:\/\/x\.test\/reset\?token=abc/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
