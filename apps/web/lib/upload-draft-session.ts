// SPDX-License-Identifier: Apache-2.0

const KEY_PREFIX = "databounty.upload-draft-token.";

export const UPLOAD_DRAFT_TOKEN_HEADER = "x-upload-draft-token";

export function rememberDraftToken(draftId: string, token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(`${KEY_PREFIX}${draftId}`, token);
  } catch {
    // ignore
  }
}

export function draftToken(draftId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(`${KEY_PREFIX}${draftId}`);
  } catch {
    return null;
  }
}

export function forgetDraftToken(draftId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(`${KEY_PREFIX}${draftId}`);
  } catch {
    // ignore
  }
}

export function draftAuthHeaders(draftId: string): Record<string, string> {
  const token = draftToken(draftId);
  return token ? { [UPLOAD_DRAFT_TOKEN_HEADER]: token } : {};
}
