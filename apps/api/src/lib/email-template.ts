// SPDX-License-Identifier: Apache-2.0

/**
 * Escape before interpolating anything into the HTML part. Every field of
 * `EmailContent` can carry user-supplied text: `displayName` (validated only
 * as 2-50 chars — see lib/display-name.ts), the inviter's name on an admin
 * invite, and Google's `identity.name` on first sign-in. Without this, that
 * text was injected as live markup into mail sent to third parties — link
 * spoofing, or a forged "click here to reset" CTA above the real one. The
 * original application escapes at every interpolation; this rebuild had no
 * escaping at all until 2026-09-02.
 *
 * `"` is included because `button.href` is interpolated into an `href="..."`
 * attribute, where an unescaped quote is an attribute breakout.
 */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c
  );
}

export interface EmailContent {
  heading: string;
  paragraphs: string[];
  button?: { label: string; href: string };
  footnote?: string;
}

export function renderEmail(content: EmailContent): { html: string; text: string } {
  const textParagraphs = content.paragraphs.join("\n\n");
  const textButton = content.button ? `\n\n${content.button.label.toUpperCase()}: ${content.button.href}` : "";
  const textFootnote = content.footnote ? `\n\n---\n${content.footnote}` : "";
  const text = `${content.heading}\n\n${textParagraphs}${textButton}${textFootnote}`;

  const htmlParagraphs = content.paragraphs
    .map((p) => `<p style="color: #333; line-height: 1.5;">${escapeHtml(p)}</p>`)
    .join("");
  const htmlButton = content.button
    ? `<p style="margin: 24px 0;"><a href="${escapeHtml(content.button.href)}" style="background-color: #2563eb; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: 500; display: inline-block;">${escapeHtml(content.button.label)}</a></p>` +
      // Printed fallback: mail clients that strip styled anchors, and any
      // recipient forwarding as plain text, otherwise lose the only way to
      // act on a verify/reset mail. V1 prints the link under the button too.
      `<p style="color: #888; font-size: 12px; word-break: break-all;">If the button does not work, paste this into your browser:<br>${escapeHtml(content.button.href)}</p>`
    : "";
  const htmlFootnote = content.footnote
    ? `<p style="color: #888; font-size: 12px; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">${escapeHtml(content.footnote)}</p>`
    : "";

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(content.heading)}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f9fafb; padding: 24px;">
  <div style="max-width: 560px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; border: 1px solid #e5e7eb;">
    <h2 style="color: #111827; margin-top: 0;">${escapeHtml(content.heading)}</h2>
    ${htmlParagraphs}
    ${htmlButton}
    ${htmlFootnote}
  </div>
</body>
</html>`;

  return { html, text };
}
