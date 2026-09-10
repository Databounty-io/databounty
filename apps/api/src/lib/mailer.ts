// SPDX-License-Identifier: Apache-2.0

import nodemailer from "nodemailer";
import { config } from "../config.js";

const isProdEnv = process.env.NODE_ENV === "production";

export interface MailMessage {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    if (config.email.smtpHost && config.email.smtpUser) {
      transporter = nodemailer.createTransport({
        host: config.email.smtpHost,
        port: config.email.smtpPort ?? 587,
        secure: config.email.smtpSecure ?? config.email.smtpPort === 465,
        auth: {
          user: config.email.smtpUser,
          pass: config.email.smtpPass,
        },
      });
    } else {
      // Fail closed in production. A stream transport DISCARDS the message and
      // reports success, so an unset SMTP_HOST/SMTP_USER meant verification
      // codes, password resets and admin invites were silently never delivered
      // while every API call returned 200 — no error, no log, no symptom until
      // a user says "I never got the email". The original application refuses
      // to boot in this state; this throws on first send rather than at boot
      // so a deployment that never sends mail is not blocked, but nothing can
      // silently vanish.
      if (isProdEnv) {
        throw new Error(
          "SMTP is not configured in production (SMTP_HOST / SMTP_USER unset) — refusing to fall back to a transport that discards mail. Set the SMTP credentials, or explicitly disable the feature that is sending."
        );
      }
      // Development only: stream / mock transporter.
      transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: "unix",
        buffer: true,
      });
    }
  }
  return transporter;
}

/**
 * Throws on failure. Callers that must not fail the request because mail
 * failed should catch explicitly and say so at the call site — the previous
 * blanket catch here made every send look successful, which is how a
 * misconfigured mailer stayed invisible.
 */
export async function sendMail(msg: MailMessage): Promise<void> {
  const mailer = getTransporter();
  try {
    await mailer.sendMail({
      from: config.email.from,
      to: Array.isArray(msg.to) ? msg.to.join(", ") : msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      cc: Array.isArray(msg.cc) ? msg.cc.join(", ") : msg.cc,
      bcc: Array.isArray(msg.bcc) ? msg.bcc.join(", ") : msg.bcc,
      replyTo: msg.replyTo,
    });
  } catch (err) {
    // Log the classification only — never the raw nodemailer error, which
    // carries the recipient address and the provider's response body. V1 logs
    // `code`/`responseCode` for the same reason.
    const e = err as { code?: string; responseCode?: number; message?: string };
    console.error(
      `[mailer] send failed: code=${e.code ?? "unknown"} responseCode=${e.responseCode ?? "none"} subject="${msg.subject}"`
    );
    throw new Error(`mail send failed (${e.code ?? e.responseCode ?? "unknown"})`);
  }
}
