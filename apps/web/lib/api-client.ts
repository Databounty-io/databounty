// SPDX-License-Identifier: Apache-2.0

import { authedFetch } from "@/lib/store";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Fastify's built-in 404 handler writes messages of the exact shape
// "Route POST:/v1/foo/bar not found" whenever a route genuinely doesn't
// exist server-side — a routing implementation detail, never something a
// real handler would phrase that way. Trusting it blindly meant a missing
// backend route displayed that raw string to the user instead of the
// caller's own fallback. A handler's own `reply.notFound("...")`-style
// message never matches this pattern, so it still passes through
// untouched. This is the shared HTTP client every `apiClient.*` call goes
// through, so fixing it here covers every caller that doesn't build its
// own error message.
const FASTIFY_ROUTE_NOT_FOUND = /^Route (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):.* not found$/;

function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    for (const key of ["message", "error", "detail"]) {
      const value = rec[key];
      if (typeof value === "string" && value && !FASTIFY_ROUTE_NOT_FOUND.test(value)) return value;
    }
  }
  return fallback;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  const hasBody = body !== undefined;
  const res = await authedFetch(path, {
    method,
    ...init,
    headers: {
      Accept: "application/json",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  const parsed: unknown = text ? safeJson(text) : undefined;

  if (!res.ok) {
    throw new ApiError(
      res.status,
      path,
      messageFromBody(parsed, `${method} ${path} failed (${res.status})`),
      parsed,
    );
  }
  return parsed as T;
}

export const apiClient = {
  get: <T>(path: string, init?: RequestInit) => request<T>("GET", path, undefined, init),
  post: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>("POST", path, body, init),
  put: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>("PUT", path, body, init),
  patch: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>("PATCH", path, body, init),
  del: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>("DELETE", path, body, init),
};
