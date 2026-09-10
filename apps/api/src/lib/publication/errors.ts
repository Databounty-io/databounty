// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-neutral publish failure. `permanent` distinguishes a client-side or
 * config error that retrying cannot fix (bad request, invalid metadata, auth,
 * oversize) from a transient one (provider 5xx/down, network, timeout,
 * rate-limit) that should be retried.
 *
 * Lives at the port, not in one adapter, because the JOB RUNNER branches on
 * it (`error instanceof PublicationError && error.permanent` → record failed
 * without burning the retry budget; otherwise back off and retry). Every
 * adapter throws this type (or a subclass of it) so a permanent GitHub error
 * — a bad token, a rejected repo name — is classified by the exact same rule
 * as a permanent Hugging Face one. Ported from v1
 * (`databounty-api/src/lib/publication/errors.ts`).
 */
export class PublicationError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
    this.name = "PublicationError";
  }
}

/** True for an HTTP status that retrying cannot fix: any 4xx except 429
 * (rate-limit, which IS transient). 5xx and network/timeout are transient. */
export function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}
