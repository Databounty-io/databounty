// SPDX-License-Identifier: Apache-2.0

/**
 * SMTP transport for the notification DISPATCHER specifically.
 *
 * Why this is not `lib/mailer.ts`: that helper deliberately swallows send
 * errors (`catch { console.error }`) so a failed transactional email never
 * takes a request down. That behaviour is exactly wrong for delivery
 * bookkeeping — a swallowed failure would be recorded as `sent`, which is a
 * fabricated success. The dispatcher needs a transport that THROWS, so the
 * delivery row can be marked `failed`/`dead` with the real reason.
 *
 * It also fails closed when SMTP is not configured. `lib/mailer.ts` falls back
 * to nodemailer's `streamTransport`, which resolves without sending anything;
 * treating that as a delivered notification would be a lie. Here an
 * unconfigured mailer is a NON-RETRYABLE failure, so the delivery row
 * dead-letters with "Email delivery is not configured" and the admin console
 * shows the truth instead of a green tick.
 */
import nodemailer from "nodemailer";
import { config } from "../config.js";

export class NotificationDeliveryError extends Error {
  /** false → terminal (dead-letter now, do not burn the retry budget). */
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "NotificationDeliveryError";
    this.retryable = retryable;
  }
}

let transporter: nodemailer.Transporter | null = null;

export function notificationEmailConfigured(): boolean {
  return Boolean(config.email.smtpHost && config.email.smtpUser);
}

function getTransporter(): nodemailer.Transporter {
  if (!notificationEmailConfigured()) {
    throw new NotificationDeliveryError(
      "Email delivery is not configured (SMTP_HOST/SMTP_USER unset).",
      false
    );
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.email.smtpHost,
      port: config.email.smtpPort ?? 587,
      secure: config.email.smtpSecure ?? config.email.smtpPort === 465,
      auth: { user: config.email.smtpUser, pass: config.email.smtpPass },
    });
  }
  return transporter;
}

/**
 * SMTP reply codes in the 5xx range are permanent (bad recipient, unverified
 * sender identity, message rejected) — retrying them 8 times only delays the
 * honest "this address does not work" signal. 4xx and connection errors are
 * transient.
 */
function classify(err: unknown): NotificationDeliveryError {
  if (err instanceof NotificationDeliveryError) return err;
  const responseCode = (err as { responseCode?: number } | null)?.responseCode;
  const raw = err instanceof Error ? err.message : "Email delivery failed.";
  // Never persist a full provider response body — it can echo the recipient
  // address and other destination data back into a user-visible field.
  const message = raw.slice(0, 300);
  if (typeof responseCode === "number" && responseCode >= 500 && responseCode < 600) {
    return new NotificationDeliveryError(message, false);
  }
  return new NotificationDeliveryError(message, true);
}

export async function sendNotificationEmail(msg: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Extra RFC headers. Used for RFC 2369/8058 `List-Unsubscribe` on routine
   * digest mail only — never on transactional/security mail, which must not
   * advertise an unsubscribe. */
  headers?: Record<string, string>;
}): Promise<void> {
  const mailer = getTransporter();
  try {
    await mailer.sendMail({
      from: config.email.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      ...(msg.headers ? { headers: msg.headers } : {}),
    });
  } catch (err) {
    throw classify(err);
  }
}
