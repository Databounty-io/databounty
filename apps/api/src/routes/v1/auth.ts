// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { User, Role } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import {
  verifyGoogleIdToken,
  isGoogleAuthConfigured,
  type GoogleIdentity,
} from "../../lib/google-auth.js";
import { requireTrustedOrigin } from "../../lib/request-origin.js";
import {
  createSession,
  getUserFromSessionToken,
  revokeAllSessions,
  revokeSession,
} from "../../lib/session.js";
import { hashPassword, verifyPassword, verifyPasswordDummy } from "../../lib/password.js";
import {
  createPasswordResetToken,
  verifyPasswordResetToken,
  claimPasswordResetToken,
  invalidatePasswordResetTokens,
} from "../../lib/password-reset.js";
import {
  createEmailVerificationToken,
  consumeEmailVerificationToken,
} from "../../lib/email-verification.js";
import { displayNameSchema } from "../../lib/display-name.js";
import { verifyAdminInviteToken, consumeAdminInvite } from "../../lib/admin-invite.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import {
  setSessionCookie,
  setAdminSessionCookie,
  clearSessionCookie,
  clearAdminSessionCookie,
  sessionTokenFrom,
} from "../../lib/session-cookie.js";
import { ensurePersonalWorkspace } from "../../lib/workspace.js";
import {
  sendWelcomeEmail,
  sendWelcomeVerificationEmail,
  sendVerificationEmail,
  sendPasswordTokenEmail,
} from "../../lib/auth-notify.js";
import { requireAuth, ADMIN_ROLES, type AuthedUser } from "../../lib/rbac.js";
import { PERSONAS } from "../../lib/persona.js";
import {
  checkLoginLock,
  clearLoginFailures,
  loginAccountKey,
  recordLoginFailure,
} from "../../lib/auth-failure-metrics.js";
import { ensureDefaultWatchPref, seedEmailNotificationChannel } from "../../services/notifications.js";

const emailField = z.string().email().transform((s) => s.toLowerCase());

const googleBody = z.object({ idToken: z.string().min(1) });
const signupBody = z.object({
  email: emailField,
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: displayNameSchema,
});
const loginBody = z.object({ email: emailField, password: z.string().min(1) });
const forgotPasswordBody = z.object({ email: emailField });
const resetPasswordBody = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});
const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});
const setPasswordBody = z.object({
  // Fresh proof of control over the account's email address, minted by
  // POST /request-set-password and delivered by mail. See the /set-password
  // handler for why a session alone is not enough (SEC-07).
  token: z
    .string({ required_error: "A set-password link is required" })
    .min(1, "A set-password link is required"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});
const verifyEmailBody = z.object({ token: z.string().min(1) });
const acceptInviteBody = z.object({
  token: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
  displayName: displayNameSchema.optional(),
});
const onboardingBody = z.object({ persona: z.enum(PERSONAS).nullish() });

// Brute-force / credential-stuffing guard for auth endpoints. Kept hard-coded
// (not an admin_settings-backed value) on purpose: a security control an
// admin session can widen at runtime is one a stolen admin session can widen
// too. Matches v1's AUTH_RATE_LIMIT (databounty-api/src/routes/v1/auth.ts).
const AUTH_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: "1 minute", skipOnError: false } };

function isAdminRole(role: string): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role as any);
}

function serializeUser(user: User, roles: string[]) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    handle: user.handle,
    onboarded: user.onboarded,
    hasPassword: !!user.passwordHash,
    emailVerified: !!user.emailVerifiedAt,
    authMethod: user.authMethod,
    persona: user.persona,
    karmaTotal: user.karmaTotal,
    leaderboardRank: user.leaderboardRank,
    roles: roles.filter(isAdminRole),
  };
}

async function rolesFor(userId: string): Promise<string[]> {
  const rows = await prisma.userRole.findMany({ where: { userId } });
  return rows.map((r) => r.role).filter(isAdminRole);
}

/**
 * Outcome of resolving a verified Google identity onto a local account.
 *
 * `conflict` is a first-class result, not an error path to be smoothed over:
 * the rebuild's mandatory Phase 9 rule forbids collision-based automatic
 * merging, so an ambiguous identity must stop, not pick a winner.
 */
type GoogleResolution =
  | { kind: "subject"; user: User }
  | { kind: "link"; user: User }
  | { kind: "new" }
  | { kind: "conflict"; reason: string; message: string };

/**
 * Resolve a verified Google identity to at most one local account,
 * SUBJECT FIRST.
 *
 * WHY — SEC-06 review, 2026-09-05. Both Google login paths used a single
 * unordered `findFirst({ OR: [{ googleId }, { email }] })`, so which row came
 * back for a collision was up to the database, and reconciliation then kept an
 * existing non-empty `googleId` without ever comparing it to the subject that
 * had just authenticated. Proven against the real API: a dummy account already
 * linked to subject A was handed a valid session when the provider asserted
 * subject B with the same verified email — 200, existing account, different
 * subject. A reassigned or recycled Google address crosses an existing
 * identity binding.
 *
 * The Google `sub` is the only stable, non-reassignable identifier in the
 * token; email is mutable and can be transferred between accounts. So:
 *
 *  1. The subject decides. If a local account already carries this `googleId`,
 *     that is the account, full stop — the email is only synced onto it.
 *  2. The verified email may only LINK to an account that is not already bound
 *     to some other subject, and only when nothing else claims that address.
 *  3. Anything ambiguous is rejected. No merging, no "closest match".
 *
 * The original application also resolves subject before email, but its email
 * fallback does not itself reject a mismatched existing binding; this is
 * deliberately stricter.
 */
async function resolveGoogleAccount(identity: GoogleIdentity): Promise<GoogleResolution> {
  // `googleId` is `@unique` in the schema, so >1 row cannot normally exist —
  // findMany/take:2 is here so that if it ever does (a bad backfill, a dropped
  // constraint) the answer is a rejection instead of an arbitrary pick.
  const bySubject = await prisma.user.findMany({
    where: { googleId: identity.googleId },
    take: 2,
  });
  if (bySubject.length > 1) {
    return {
      kind: "conflict",
      reason: "google_subject_ambiguous",
      message: "This Google account is linked to more than one DataBounty account. Contact support.",
    };
  }

  const byEmail = await prisma.user.findUnique({ where: { email: identity.email } });

  if (bySubject.length === 1) {
    const subjectUser = bySubject[0]!;
    if (byEmail && byEmail.id !== subjectUser.id) {
      // Two-account ambiguity: the subject binds one account, the verified
      // address belongs to a different one. Syncing the email here would
      // either collide on the unique index or silently move an address
      // between accounts. Neither is a merge we are allowed to perform.
      return {
        kind: "conflict",
        reason: "google_email_owned_by_other_account",
        message:
          "That email address already belongs to a different DataBounty account. Contact support to resolve it.",
      };
    }
    return { kind: "subject", user: subjectUser };
  }

  if (byEmail) {
    if (!identity.emailVerified) {
      return {
        kind: "conflict",
        reason: "google_email_unverified",
        message: "Google has not verified this email address, so it cannot be linked to an existing account.",
      };
    }
    if (byEmail.googleId) {
      // THE SEC-06 CASE: the address matches, but the account is already bound
      // to a different Google subject.
      return {
        kind: "conflict",
        reason: "google_subject_mismatch",
        message: "This account is already linked to a different Google account. Sign in with that one instead.",
      };
    }
    return { kind: "link", user: byEmail };
  }

  return { kind: "new" };
}

/**
 * Bind a verified Google subject to an existing, currently unlinked account.
 *
 * The write is conditional (`updateMany` filtered on `googleId: null`) so two
 * concurrent first-time logins cannot both claim the same row: the loser sees
 * `count === 0` and gets a conflict rather than an overwritten binding. A
 * `P2002` on the unique `googleId`/`email` index is the same story from the
 * other side and is reported the same way.
 */
async function linkGoogleIdentity(
  user: User,
  identity: GoogleIdentity,
  req: FastifyRequest
): Promise<User | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id: user.id, googleId: null },
        data: {
          googleId: identity.googleId,
          ...(user.email?.toLowerCase() === identity.email ? {} : { email: identity.email }),
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        },
      });
      if (count !== 1) return null;
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "user.google_id_linked",
        targetType: "user",
        targetId: user.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });
      return await tx.user.findUniqueOrThrow({ where: { id: user.id } });
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return null;
    throw err;
  }
}

/**
 * Keep the email of an already-subject-bound account in step with the
 * provider. Only reached after resolveGoogleAccount() has established that no
 * other account holds the incoming address.
 */
async function syncGoogleEmail(
  user: User,
  identity: GoogleIdentity,
  req: FastifyRequest
): Promise<User | null> {
  const nextEmail = user.email?.toLowerCase() === identity.email ? null : identity.email;
  if (!nextEmail && user.emailVerifiedAt) return user;

  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: user.id },
        data: {
          ...(nextEmail ? { email: nextEmail } : {}),
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        },
      });
      if (nextEmail) {
        await writeAuditLog(tx, {
          actorUserId: user.id,
          action: "user.google_email_synced",
          targetType: "user",
          targetId: user.id,
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
      }
      return row;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return null;
    throw err;
  }
}

/**
 * Shared resolution for both Google login paths (`/google` and
 * `/google/admin`). Both paths shared the defective lookup, so both share the
 * fix; do not re-open a second copy of it.
 *
 * `{ kind: "existing" }` carries the reconciled account. `{ kind: "absent" }`
 * lets each caller decide what "no such account" means — sign-up for the
 * member path, refusal for the admin path. `{ kind: "rejected" }` carries a
 * reply the caller must return unchanged.
 */
type GoogleSignInOutcome =
  | { kind: "existing"; user: User }
  | { kind: "absent" }
  | { kind: "rejected"; reply: FastifyReply };

async function resolveGoogleSignIn(
  identity: GoogleIdentity,
  req: FastifyRequest,
  reply: FastifyReply
): Promise<GoogleSignInOutcome> {
  const resolution = await resolveGoogleAccount(identity);

  if (resolution.kind === "conflict") {
    req.log.warn({ reason: resolution.reason }, "google identity resolution rejected");
    return { kind: "rejected", reply: reply.conflict(resolution.message) };
  }

  if (resolution.kind === "new") return { kind: "absent" };

  const updated =
    resolution.kind === "link"
      ? await linkGoogleIdentity(resolution.user, identity, req)
      : await syncGoogleEmail(resolution.user, identity, req);

  if (!updated) {
    req.log.warn({ reason: "google_identity_race" }, "google identity binding lost a concurrent race");
    return {
      kind: "rejected",
      reply: reply.conflict("This Google account is being linked already. Try signing in again."),
    };
  }

  return { kind: "existing", user: updated };
}

export async function authRoutes(app: FastifyInstance) {
  // Google sign in / sign up
  app.post("/google", { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    // Fail closed before anything else: with no GOOGLE_CLIENT_ID there is no
    // audience to check the provider response against, so this route cannot
    // establish that a token was minted for THIS application. See
    // isGoogleAuthConfigured() (SEC-05).
    if (!isGoogleAuthConfigured()) {
      return reply.serviceUnavailable("Google sign-in is not configured on this deployment");
    }

    const parsed = googleBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const identity = await verifyGoogleIdToken(parsed.data.idToken);
    if (!identity) return reply.unauthorized("Invalid Google identity token");

    const outcome = await resolveGoogleSignIn(identity, req, reply);
    if (outcome.kind === "rejected") return outcome.reply;

    let user: User;

    if (outcome.kind === "absent") {
      user = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            authMethod: "google",
            googleId: identity.googleId,
            email: identity.email,
            displayName: identity.name,
            emailVerifiedAt: new Date(),
            status: "active",
          },
        });
        await writeAuditLog(tx, {
          actorUserId: newUser.id,
          action: "user.signup.google",
          targetType: "user",
          targetId: newUser.id,
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
        return newUser;
      });

      void ensurePersonalWorkspace(user.id, user.displayName);
      void seedEmailNotificationChannel(user.id, identity.email);
      void ensureDefaultWatchPref(user.id);
      void sendWelcomeEmail(identity.email, identity.name).catch((err) => {
      // Fire-and-forget on purpose: the request must not fail, and must not
      // reveal whether an address exists. But an EMPTY catch here hid a broken
      // mailer completely — the user simply never received the welcome mail and
      // nothing anywhere recorded it. Log, do not rethrow.
      console.error(`[mail] welcome email failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    } else {
      user = outcome.user;
    }

    if (user.status !== "active") return reply.forbidden("Account is suspended");

    const sessionToken = await createSession(user.id, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });

    setSessionCookie(reply, sessionToken);
    const roles = await rolesFor(user.id);

    return reply.send({
      user: serializeUser(user, roles),
    });
  });

  // Google Admin Sign In
  app.post("/google/admin", { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    // Same fail-closed gate as the member path (SEC-05).
    if (!isGoogleAuthConfigured()) {
      return reply.serviceUnavailable("Google sign-in is not configured on this deployment");
    }

    const parsed = googleBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const identity = await verifyGoogleIdToken(parsed.data.idToken);
    if (!identity) return reply.unauthorized("Invalid Google identity token");

    // Subject-first resolution, identical to the member path (SEC-06). The
    // admin console never creates accounts, so "absent" is a refusal.
    const outcome = await resolveGoogleSignIn(identity, req, reply);
    if (outcome.kind === "rejected") return outcome.reply;
    if (outcome.kind === "absent") return reply.forbidden("Admin account not found");

    const user = outcome.user;
    const roles = await rolesFor(user.id);
    if (!roles.length) return reply.forbidden("User is not an administrator");

    const sessionToken = await createSession(user.id, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });

    setAdminSessionCookie(reply, sessionToken);

    return reply.send({
      user: serializeUser(user, roles),
    });
  });

  // Email Signup
  app.post("/signup", { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    const parsed = signupBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const { email, password, displayName } = parsed.data;

    // Deliberately vague: a pentest (2026-08-31, ported from V1's
    // fix(auth): remove enumeration-friendly text from duplicate-signup
    // response) flagged the old literal "email already exists" text as an
    // enumeration oracle — a scripted attacker could grep the response body
    // to confirm registered emails at scale. The 409 status code itself is a
    // lesser residual signal (closing it fully means dropping signup's
    // instant auto-login for a verify-by-email flow, a bigger product change
    // than this fix); this at least kills the trivially automatable
    // phrase-matching vector.
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.conflict("Couldn't create an account with these details. If you already have one, try signing in instead.");
    }

    const passwordHash = await hashPassword(password);

    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          authMethod: "email",
          email,
          passwordHash,
          displayName,
          status: "active",
        },
      });
      await writeAuditLog(tx, {
        actorUserId: newUser.id,
        action: "user.signup.email",
        targetType: "user",
        targetId: newUser.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });
      return newUser;
    });

    void ensurePersonalWorkspace(user.id, user.displayName);
    void seedEmailNotificationChannel(user.id, email);
    void ensureDefaultWatchPref(user.id);

    const verificationToken = await createEmailVerificationToken(user.id);
    void sendWelcomeVerificationEmail(email, displayName, verificationToken).catch((err) => {
      // Fire-and-forget on purpose: the request must not fail, and must not
      // reveal whether an address exists. But an EMPTY catch here hid a broken
      // mailer completely — the user simply never received the welcome+verification mail and
      // nothing anywhere recorded it. Log, do not rethrow.
      console.error(`[mail] welcome+verification email failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    const sessionToken = await createSession(user.id, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });

    setSessionCookie(reply, sessionToken);

    return reply.status(201).send({
      user: serializeUser(user, []),
    });
  });

  // Email Login
  app.post("/login", { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const { email, password } = parsed.data;
    const accountKey = loginAccountKey(email);

    const lock = await checkLoginLock(accountKey);
    if (lock.locked) {
      await verifyPasswordDummy(password);
      return reply.unauthorized("Too many failed attempts. Please try again later.");
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      await verifyPasswordDummy(password);
      await recordLoginFailure(accountKey, app.log);
      return reply.unauthorized("Invalid email or password");
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      await recordLoginFailure(accountKey, app.log);
      return reply.unauthorized("Invalid email or password");
    }

    await clearLoginFailures(accountKey);

    if (user.status !== "active") return reply.forbidden("Account is suspended");

    const sessionToken = await createSession(user.id, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });

    setSessionCookie(reply, sessionToken);
    const roles = await rolesFor(user.id);

    return reply.send({
      user: serializeUser(user, roles),
    });
  });

  // Admin Login
  //
  // Was missing the lockout state machine `/login` (member) already has —
  // admin accounts are the highest-value target and were getting WEAKER
  // brute-force protection than an ordinary member login. `AUTH_RATE_LIMIT`
  // alone doesn't cover this: it's keyed by IP, so credential-stuffing
  // spread across a rotating IP pool faced zero per-account throttling here
  // while the same attack against `/login` was halted after 5 attempts
  // regardless of IP. Prefixed key so an admin lockout and a member lockout
  // on the same email never share (or reset) each other's counter.
  app.post("/login/admin", { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const { email, password } = parsed.data;
    const accountKey = `admin:${loginAccountKey(email)}`;

    const lock = await checkLoginLock(accountKey);
    if (lock.locked) {
      await verifyPasswordDummy(password);
      return reply.unauthorized("Too many failed attempts. Please try again later.");
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      await verifyPasswordDummy(password);
      await recordLoginFailure(accountKey, app.log);
      return reply.unauthorized("Invalid credentials");
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      await recordLoginFailure(accountKey, app.log);
      return reply.unauthorized("Invalid credentials");
    }

    const roles = await rolesFor(user.id);
    if (!roles.length) {
      // Not a lockout-worthy failure — the password was correct, the account
      // just isn't an admin. Clearing here would let a correct non-admin
      // password reset an attacker's failure count against an admin email
      // that happens to share it, which it never can (emails are unique) —
      // clearing is simply the honest thing to do for THIS account's own key.
      await clearLoginFailures(accountKey);
      return reply.forbidden("Not an admin");
    }

    await clearLoginFailures(accountKey);

    const sessionToken = await createSession(user.id, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });

    setAdminSessionCookie(reply, sessionToken);

    return reply.send({
      user: serializeUser(user, roles),
    });
  });

  // Get Current User (whoami)
  app.get("/me", async (req, reply) => {
    const token = sessionTokenFrom(req);
    if (!token) return reply.unauthorized("Sign in required");

    const user = await getUserFromSessionToken(token);
    if (!user) return reply.unauthorized("Sign in required");

    const roles = await rolesFor(user.id);
    return reply.send({ user: serializeUser(user, roles) });
  });

  // Logout
  app.post("/logout", async (req, reply) => {
    const token = sessionTokenFrom(req);
    if (token) {
      // Look up the user BEFORE revoking the session so the revocation
      // version bump below (which invalidates any outstanding Enterprise
      // assertion minted while this session was active — see
      // ENTERPRISE_COMPOSITION_CONTRACT.md point 6) still has a userId even
      // though the session row itself is about to be deleted.
      const user = await getUserFromSessionToken(token);
      await revokeSession(token);
      if (user) {
        await prisma.user
          .update({ where: { id: user.id }, data: { revocationVersion: { increment: 1 } } })
          .catch(() => {});
      }
    }
    clearSessionCookie(reply);
    clearAdminSessionCookie(reply);
    return reply.send({ ok: true });
  });

  // Logout of every device — kills every session row for the authenticated
  // user, not just the one used to call this endpoint. Deliberately a
  // separate opt-in endpoint from /logout: a plain logout must keep only
  // killing the current session (that matches ordinary user expectation),
  // this one is for "someone else might have my token" / lost-device cases.
  app.post("/logout-all", { preHandler: [requireAuth] }, async (req, reply) => {
    const authedUser = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    await revokeAllSessions(authedUser.id);
    clearSessionCookie(reply);
    clearAdminSessionCookie(reply);
    return reply.send({ ok: true });
  });

  // Onboarding Complete
  app.post("/onboarding-complete", { preHandler: [requireAuth] }, async (req, reply) => {
    const authedUser = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = onboardingBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const updated = await prisma.user.update({
      where: { id: authedUser.id },
      data: {
        onboarded: true,
        ...(parsed.data.persona !== undefined ? { persona: parsed.data.persona } : {}),
      },
    });

    const roles = await rolesFor(updated.id);
    return reply.send({ user: serializeUser(updated, roles) });
  });

  // Forgot Password
  app.post("/forgot-password", { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    const parsed = forgotPasswordBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (user && user.passwordHash) {
      const token = await createPasswordResetToken(user.id, "reset");
      void sendPasswordTokenEmail(user.email!, token, "reset").catch((err) => {
      // Fire-and-forget on purpose: the request must not fail, and must not
      // reveal whether an address exists. But an EMPTY catch here hid a broken
      // mailer completely — the user simply never received the password reset mail and
      // nothing anywhere recorded it. Log, do not rethrow.
      console.error(`[mail] password reset email failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    }

    return reply.send({ ok: true, message: "If an account exists, a reset link was sent." });
  });

  // Reset Password
  app.post("/reset-password", { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    const parsed = resetPasswordBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const passwordHash = await hashPassword(parsed.data.newPassword);

    // Claim happens INSIDE the transaction, atomically with the password
    // write: two concurrent requests presenting the identical token can no
    // longer both pass (see claimPasswordResetToken's docstring), and a claim
    // that isn't followed by a successful write rolls back with it.
    let claimedUserId: string | null = null;
    await prisma.$transaction(async (tx) => {
      const claimed = await claimPasswordResetToken(parsed.data.token, tx);
      if (!claimed) return;
      claimedUserId = claimed.userId;
      await tx.user.update({
        where: { id: claimed.userId },
        data: { passwordHash },
      });
      // Burn every OTHER outstanding token too, not just the one spent here.
      // Leaving the siblings live was an account takeover: an older reset mail
      // could reset the password again straight after the legitimate reset,
      // locking the real owner out. See invalidatePasswordResetTokens().
      await invalidatePasswordResetTokens(claimed.userId, tx);
      await tx.session.deleteMany({ where: { userId: claimed.userId } });
      await writeAuditLog(tx, {
        actorUserId: claimed.userId,
        action: "user.password_reset",
        targetType: "user",
        targetId: claimed.userId,
        ip: req.ip,
      });
    });

    if (!claimedUserId) return reply.badRequest("Invalid or expired password reset link");
    return reply.send({ ok: true, message: "Password has been successfully updated." });
  });

  // Change Password
  app.post("/change-password", { preHandler: [requireAuth], config: AUTH_RATE_LIMIT }, async (req, reply) => {
    const authedUser = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = changePasswordBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const user = await prisma.user.findUnique({ where: { id: authedUser.id } });
    if (!user || !user.passwordHash) return reply.badRequest("No password set on this account");

    const valid = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
    if (!valid) return reply.unauthorized("Current password is incorrect");

    const passwordHash = await hashPassword(parsed.data.newPassword);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });
      // Same class of event as a reset: any pending reset link is now stale,
      // and a change is often the response to a suspected compromise — the
      // one moment an attacker's outstanding token must stop working.
      await invalidatePasswordResetTokens(user.id, tx);
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "user.password_changed",
        targetType: "user",
        targetId: user.id,
        ip: req.ip,
      });
    });

    // A password change is a credential change, same class of event as
    // reset-password (which already wipes every session). Kill every other
    // session in case the change was prompted by a compromised device —
    // this also revokes the session making this very request, so the
    // caller needs to sign in again afterward.
    await revokeAllSessions(user.id);
    clearSessionCookie(reply);
    clearAdminSessionCookie(reply);

    return reply.send({ ok: true });
  });

  // Set Password (for accounts created with OAuth only)
  //
  // TWO controls beyond the session, both added for SEC-07 (2026-09-05):
  //
  // 1. `requireTrustedOrigin` — a cookie-authenticated form POST from
  //    `http://untrusted.localhost:9999` returned 200 and wrote a password
  //    hash for an OAuth-only victim account. CORS did not stop it and cannot:
  //    it withholds the response, not the request. See lib/request-origin.ts.
  //
  // 2. A set-password token. `/change-password` already demands the current
  //    password, so it carries its own proof that the caller is the account
  //    owner right now. This endpoint had NO equivalent — an OAuth-only
  //    account has no password to re-enter, so a bare session was the whole
  //    authorization for planting the first one, which is the highest-value
  //    write in the API (it converts a stolen session into permanent
  //    credentials). Proof of control over the account's email address is the
  //    substitute: call POST /request-set-password, then submit the token from
  //    that mail. Nothing new ships to support this — /request-set-password
  //    already mints a `set`-purpose token and mails it.
  app.post(
    "/set-password",
    { preHandler: [requireTrustedOrigin, requireAuth], config: AUTH_RATE_LIMIT },
    async (req, reply) => {
    const authedUser = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const parsed = setPasswordBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const user = await prisma.user.findUnique({ where: { id: authedUser.id } });
    if (!user) return reply.notFound("User not found");
    if (user.passwordHash) return reply.badRequest("Password already exists; use change-password instead");

    // The token must be live, unused, of the `set` purpose, AND belong to the
    // session's own account — a token minted for another user is not proof of
    // anything about this one.
    const proof = await verifyPasswordResetToken(parsed.data.token);
    if (!proof || proof.purpose !== "set" || proof.userId !== user.id) {
      return reply.badRequest(
        "Invalid or expired set-password link. Request a new one and use the link in that email."
      );
    }

    const passwordHash = await hashPassword(parsed.data.newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });
      // Consumes the pending "set" window as well: the account now has a
      // password, so every token issued to establish one is spent.
      await invalidatePasswordResetTokens(user.id, tx);
      await writeAuditLog(tx, {
        actorUserId: user.id,
        action: "user.password_set",
        targetType: "user",
        targetId: user.id,
        ip: req.ip,
      });
    });

    return reply.send({ ok: true });
  });

  // Request set password link
  app.post(
    "/request-set-password",
    { preHandler: [requireTrustedOrigin, requireAuth], config: AUTH_RATE_LIMIT },
    async (req, reply) => {
    const authedUser = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const user = await prisma.user.findUnique({ where: { id: authedUser.id } });
    if (!user || !user.email) return reply.badRequest("No email on account");

    const token = await createPasswordResetToken(user.id, "set");
    void sendPasswordTokenEmail(user.email, token, "set").catch((err) => {
      // Fire-and-forget on purpose: the request must not fail, and must not
      // reveal whether an address exists. But an EMPTY catch here hid a broken
      // mailer completely — the user simply never received the set password mail and
      // nothing anywhere recorded it. Log, do not rethrow.
      console.error(`[mail] set password email failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    return reply.send({ ok: true });
  });

  // Verify Email
  app.post("/verify-email", { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    const parsed = verifyEmailBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const userId = await consumeEmailVerificationToken(parsed.data.token);
    if (!userId) return reply.badRequest("Invalid or expired verification link");

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: new Date() },
      });
      await writeAuditLog(tx, {
        actorUserId: userId,
        action: "user.email_verified",
        targetType: "user",
        targetId: userId,
        ip: req.ip,
      });
    });

    return reply.send({ ok: true, message: "Email verified successfully" });
  });

  // Resend Email Verification
  app.post(
    "/resend-verification",
    { preHandler: [requireAuth], config: AUTH_RATE_LIMIT },
    async (req, reply) => {
    const authedUser = (req as FastifyRequest & { authedUser: AuthedUser }).authedUser;
    const user = await prisma.user.findUnique({ where: { id: authedUser.id } });
    if (!user || !user.email) return reply.badRequest("No email address found");
    if (user.emailVerifiedAt) return reply.badRequest("Email is already verified");

    const token = await createEmailVerificationToken(user.id);
    void sendVerificationEmail(user.email, token).catch((err) => {
      // Fire-and-forget on purpose: the request must not fail, and must not
      // reveal whether an address exists. But an EMPTY catch here hid a broken
      // mailer completely — the user simply never received the verification mail and
      // nothing anywhere recorded it. Log, do not rethrow.
      console.error(`[mail] verification email failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    return reply.send({ ok: true, message: "Verification link sent." });
  });

  // Accept Admin Invite
  app.post("/accept-invite", { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    const parsed = acceptInviteBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const invite = await verifyAdminInviteToken(parsed.data.token);
    if (!invite) return reply.badRequest("Invalid or expired invite link");

    let user = await prisma.user.findUnique({ where: { email: invite.email } });

    if (!user) {
      if (!parsed.data.password) {
        return reply.badRequest("Password required to create admin account");
      }
      const passwordHash = await hashPassword(parsed.data.password);
      user = await prisma.user.create({
        data: {
          authMethod: "email",
          email: invite.email,
          passwordHash,
          displayName: parsed.data.displayName ?? invite.email.split("@")[0] ?? "Admin",
          emailVerifiedAt: new Date(),
          status: "active",
        },
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.userRole.upsert({
        where: {
          userId_role: {
            userId: user!.id,
            role: invite.role,
          },
        },
        create: {
          userId: user!.id,
          role: invite.role,
        },
        update: {},
      });

      await consumeAdminInvite(invite.id);
      await writeAuditLog(tx, {
        actorUserId: user!.id,
        action: "admin.invite_accepted",
        targetType: "user",
        targetId: user!.id,
        after: { role: invite.role },
        ip: req.ip,
      });
    });

    const sessionToken = await createSession(user.id, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });

    setAdminSessionCookie(reply, sessionToken);
    const roles = await rolesFor(user.id);

    return reply.send({
      user: serializeUser(user, roles),
    });
  });
}
