// SPDX-License-Identifier: Apache-2.0

import { config } from "../config.js";
import { sendMail, type MailMessage } from "./mailer.js";
import { renderEmail, type EmailContent } from "./email-template.js";

const APP_URL = config.appUrl;

async function sendTemplated(
  to: string | string[],
  subject: string,
  content: EmailContent,
  extra?: Pick<MailMessage, "cc" | "bcc" | "replyTo">
): Promise<void> {
  const { html, text } = renderEmail(content);
  await sendMail({ to, subject, html, text, ...extra });
}

export async function sendWelcomeEmail(to: string, displayName: string): Promise<void> {
  await sendTemplated(to, "Welcome to DataBounty", {
    heading: "Welcome to DataBounty",
    paragraphs: [`Hi ${displayName},`, "Your account is ready — sign in any time from the button below."],
    button: { label: "Go to Dashboard", href: APP_URL },
  });
}

export async function sendWelcomeVerificationEmail(to: string, displayName: string, token: string): Promise<void> {
  const link = `${APP_URL}/verify-email?token=${token}`;
  await sendTemplated(to, "Welcome to DataBounty — verify your email", {
    heading: "Welcome to DataBounty",
    paragraphs: [`Hi ${displayName},`, "Confirm your email address to finish setting up your account."],
    button: { label: "Verify Email", href: link },
    footnote: "This link expires in 24 hours.",
  });
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const link = `${APP_URL}/verify-email?token=${token}`;
  await sendTemplated(to, "Verify your DataBounty email", {
    heading: "Verify your email",
    paragraphs: ["Confirm this is your email address:"],
    button: { label: "Verify Email", href: link },
    footnote: "This link expires in 24 hours.",
  });
}

export async function sendPasswordTokenEmail(
  to: string,
  token: string,
  purpose: "reset" | "set"
): Promise<void> {
  const link = `${APP_URL}/reset-password?token=${token}`;
  const isSet = purpose === "set";
  await sendTemplated(to, isSet ? "Set a password for your DataBounty account" : "Reset your DataBounty password", {
    heading: isSet ? "Set a password" : "Reset your password",
    paragraphs: [
      isSet
        ? "Use the link below to set a password for your account:"
        : "Use the link below to reset your password:",
    ],
    button: { label: isSet ? "Set Password" : "Reset Password", href: link },
    footnote: "This link expires in 1 hour. If you didn't request this, you can ignore this email.",
  });
}

export async function sendAdminInviteEmail(
  to: string,
  token: string,
  role: "admin" | "member" | "support",
  invitedByName: string
): Promise<void> {
  const link = `${config.adminUrl}/accept-invite?token=${token}`;
  const roleLabel = role === "admin" ? "Admin" : role === "member" ? "Member" : "Support";
  await sendTemplated(to, `You've been invited to the DataBounty admin console`, {
    heading: `${roleLabel} invitation`,
    paragraphs: [
      `${invitedByName} invited you to join the DataBounty admin console as ${roleLabel}.`,
      "Accept the invitation from the button below. If you don't have a DataBounty account yet, you'll set one up as part of accepting.",
    ],
    button: { label: "Accept Invitation", href: link },
    footnote: "This invitation expires in 7 days and can only be used once. If you weren't expecting it, ignore this email.",
  });
}
