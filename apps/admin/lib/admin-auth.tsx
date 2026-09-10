"use client";

// SPDX-License-Identifier: Apache-2.0

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { API_URL } from "./urls";

export interface AdminUser {
  id: string;
  email: string | null;
  displayName: string;
  roles: string[];
  /** Whether this account has a password set — Google-only admin accounts
   * don't, until they use requestSetPasswordEmail. */
  hasPassword: boolean;
}

interface AdminAuthState {
  status: "loading" | "signed-out" | "signed-in";
  user: AdminUser | null;
  error: string | null;
  /** Exchange a Google ID token for an admin session. Sign-in only — never
   * creates an account. Rejects with a message if the account doesn't
   * exist or isn't admin/member/support (server-enforced; this is UX, not
   * the security boundary). */
  signInWithGoogleIdToken: (idToken: string) => Promise<void>;
  /** Email/password equivalent — same sign-in-only rule. Throws with a
   * user-facing message on failure (also set on `.error`). */
  signInWithPassword: (email: string, password: string) => Promise<void>;
  /** For an admin account that already has a password — throws on failure. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** Emailed-link equivalent of set-password, for a Google-only admin
   * account — same mechanism as forgot-password, tagged purpose "set". */
  requestSetPasswordEmail: () => Promise<void>;
  signOut: () => void;
}

/** POST helper shared by both sign-in methods below — one place that
 * fetches, parses the error body, and throws a clean message, instead of
 * duplicating that try/parse/throw dance per auth method. */
async function postAuth(path: string, body: unknown): Promise<{ user: AdminUser }> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = await res.json().catch(() => ({}));
    const message =
      res.status === 403
        ? "This account does not have admin access."
        : res.status === 429
          ? "Too many attempts. Please wait a minute and try again."
          : parsed.message || "Sign-in failed.";
    throw new Error(message);
  }
  return res.json();
}

const AdminAuthContext = createContext<AdminAuthState | null>(null);

export function useAdminAuth(): AdminAuthState {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error("useAdminAuth must be used within AdminAuthProvider");
  return ctx;
}

/** Single place that derives the three admin-console role booleans from a
 * user — every page/component that needs to gate a section on role should
 * use this (or the `useAdminRoleGates` hook below) instead of re-deriving
 * `roles.includes("admin")` locally, so the gate logic only needs fixing in
 * one place if it ever changes. Takes a plain `AdminUser | null` (rather than
 * reading context) so components that receive `user` as a prop — like the
 * sidebar — can use it too. */
export function adminRoleGates(user: AdminUser | null): { isAdmin: boolean; isMember: boolean; isSupport: boolean } {
  return {
    isAdmin: user?.roles.includes("admin") ?? false,
    isMember: user?.roles.includes("member") ?? false,
    isSupport: user?.roles.includes("support") ?? false,
  };
}

/** Context-reading convenience wrapper around `adminRoleGates` for
 * components that already call `useAdminAuth()`. */
export function useAdminRoleGates(): { isAdmin: boolean; isMember: boolean; isSupport: boolean } {
  const { user } = useAdminAuth();
  return adminRoleGates(user);
}

export function AdminAuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AdminAuthState["status"]>("loading");
  const [user, setUser] = useState<AdminUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The session itself lives in an httpOnly cookie the API set on the
  // sign-in response — nothing to persist client-side.
  const applySession = useCallback((backendUser: AdminUser) => {
    setUser(backendUser);
    setStatus("signed-in");
    setError(null);
  }, []);

  const signOut = useCallback((opts?: { revokeServerSide?: boolean }) => {
    // Revoke server-side too — the API deletes the session row and clears
    // the httpOnly cookie on this response. Fire-and-forget: the local
    // sign-out below must not wait on the network call. Skip it when
    // signing out *because* a call already 401'd — the session is already
    // dead server-side.
    if (opts?.revokeServerSide !== false) {
      fetch(`${API_URL}/v1/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {
        // Non-fatal — this device shows signed-out either way.
      });
    }
    setUser(null);
    setStatus("signed-out");
  }, []);

  const signInWithGoogleIdToken = useCallback(
    async (idToken: string) => {
      setError(null);
      try {
        const data = await postAuth("/v1/auth/google/admin", { idToken });
        applySession(data.user);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Sign-in failed.";
        setError(message);
        setStatus("signed-out");
        throw e;
      }
    },
    [applySession]
  );

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      setError(null);
      try {
        const data = await postAuth("/v1/auth/login/admin", { email, password });
        applySession(data.user);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Sign-in failed.";
        setError(message);
        setStatus("signed-out");
        throw e;
      }
    },
    [applySession]
  );

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await adminAuthedFetch("/v1/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || "Couldn't change your password.");
    // The API revoked every session and set a fresh cookie on this response.
    setUser((u) => (u ? { ...u, hasPassword: true } : u));
  }, []);

  const requestSetPasswordEmail = useCallback(async () => {
    const res = await adminAuthedFetch("/v1/auth/request-set-password", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || "Couldn't send that email.");
  }, []);

  // Restore a session on load — the session lives in an httpOnly cookie,
  // so just ask /me; a 401 means "not signed in".
  useEffect(() => {
    fetch(`${API_URL}/v1/auth/me`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data: { user: AdminUser }) => {
        if (
          !data.user.roles.includes("admin") &&
          !data.user.roles.includes("member") &&
          !data.user.roles.includes("support")
        ) {
          // Session is valid but the account lost admin access since last
          // login (role revoked) — treat as signed out, don't trust a
          // stale client-side role list.
          setStatus("signed-out");
          return;
        }
        setUser(data.user);
        setStatus("signed-in");
      })
      .catch(() => {
        setStatus("signed-out");
      });
  }, []);

  const value = useMemo<AdminAuthState>(
    () => ({
      status,
      user,
      error,
      signInWithGoogleIdToken,
      signInWithPassword,
      changePassword,
      requestSetPasswordEmail,
      signOut,
    }),
    [status, user, error, signInWithGoogleIdToken, signInWithPassword, changePassword, requestSetPasswordEmail, signOut]
  );

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

// Module-level guard against multiple simultaneous 401 redirects.
let redirectingToLogin = false;

/**
 * fetch() wrapper for authenticated `/v1/admin/*` calls. On a 401 (expired
 * or revoked session — there's no refresh token to silently renew it with)
 * this clears the session and hard-redirects to /login, instead of
 * leaving the caller to fail silently with an unauthenticated-looking
 * response. Use this for any admin page that calls a protected endpoint.
 */
export async function adminAuthedFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${API_URL}${path}`, { ...init, credentials: "include" });
  if (res.status === 401 && typeof window !== "undefined" && !redirectingToLogin) {
    redirectingToLogin = true;
    // Hard reload (not router.push) so all in-memory React state gets wiped on session loss.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  }
  return res;
}
