// SPDX-License-Identifier: Apache-2.0

/**
 * Per-channel text rendering for outbound notifications.
 *
 * Ported from v1's `renderDigestChat` / `ChatSyntax` in
 * services/notifications/digest.ts. Telegram/Slack/Discord/Google Chat/Teams
 * each have their own bold and link markup, but the STRUCTURE of a message —
 * title, body, link, and for a digest the sections — is identical everywhere.
 * Passing the primitives in (rather than letting each adapter re-walk the
 * payload) means a change to what a message contains lands in one place, and
 * keeps escaping where it belongs: each channel supplies its own `escape`, so
 * this module never has to know which characters are dangerous where.
 *
 * Pure: no DB, no transport.
 */
import type { DigestPayload } from "./digest.js";

export interface ChannelSyntax {
  bold(text: string): string;
  link(href: string, label: string): string;
  escape(text: string): string;
}

const identity = (text: string) => text;

/**
 * Community's Telegram adapter posts without `parse_mode`, so Telegram
 * receives PLAIN TEXT. Emitting `<b>`/`*bold*` here would show the markup
 * characters to the reader rather than styling anything — honest plain text
 * is the correct rendering for the transport as it is actually wired.
 */
const plain: ChannelSyntax = {
  bold: identity,
  link: (href, label) => `${label}: ${href}`,
  escape: identity,
};

/** Slack `chat.postMessage` mrkdwn, and Google Chat's text-message subset —
 * both use `*bold*` and `<url|label>`. */
const slackLike: ChannelSyntax = {
  bold: (text) => `*${text}*`,
  link: (href, label) => `<${href}|${label}>`,
  // Only these three are special in Slack/Google Chat text.
  escape: (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
};

/** Discord webhook `content` and Teams `text` both render a markdown subset,
 * but neither linkifies `[label](url)` reliably in a plain message — a bare
 * URL is what actually becomes clickable. */
const markdownPlainLink: ChannelSyntax = {
  bold: (text) => `**${text}**`,
  link: (href, label) => `${label}: ${href}`,
  escape: identity,
};

export const CHANNEL_SYNTAX = {
  email: plain, // email renders HTML separately; this is its text/plain part
  telegram: plain,
  slack: slackLike,
  google_chat: slackLike,
  discord: markdownPlainLink,
  microsoft_teams: markdownPlainLink,
} as const;

/** One ordinary (non-digest) notification as channel text. */
export function renderChatMessage(
  syntax: ChannelSyntax,
  message: { title: string; body: string; href?: string }
): string {
  const lines = [syntax.bold(syntax.escape(message.title))];
  if (message.body) lines.push(syntax.escape(message.body));
  if (message.href) lines.push(syntax.link(message.href, "Open in DataBounty"));
  return lines.join("\n");
}

/** A `digest.summary` payload as channel text: headline count, then one
 * block per section with its true count and a trimmed item list. */
export function renderDigestChat(syntax: ChannelSyntax, payload: DigestPayload): string {
  const header = syntax.bold(
    syntax.escape(payload.total === 1 ? "1 update from DataBounty" : `${payload.total} updates from DataBounty`)
  );
  const blocks = payload.sections.map((section) => {
    const lines = [syntax.bold(syntax.escape(`${section.label} (${section.count})`))];
    for (const item of section.items) {
      lines.push(`• ${syntax.link(item.href, syntax.escape(item.title))}`);
    }
    const hidden = section.count - section.items.length;
    if (hidden > 0) lines.push(`• +${hidden} more`);
    return lines.join("\n");
  });
  return [header, ...blocks, syntax.link(payload.primary.href, syntax.escape(payload.primary.label))].join("\n\n");
}
