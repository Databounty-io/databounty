"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import { API_URL } from "@/lib/urls";

/**
 * Subscribe to the admin push feed (`GET /v1/admin/notifications/stream`).
 * STRICTLY ADDITIVE. Callers keep whatever poll they already had: the stream
 * only makes rows appear sooner.
 */
const RETRY_MS = 60_000;

export function useAdminNotificationStream(onEvent: () => void): void {
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let stopped = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (stopped) return;
      const es = new EventSource(`${API_URL}/v1/admin/notifications/stream`, { withCredentials: true });
      source = es;
      let delivered = false;
      es.addEventListener("notification", () => {
        delivered = true;
        handler.current();
      });
      es.onerror = () => {
        if (delivered || stopped) return;
        es.close();
        if (source === es) source = null;
        retry = setTimeout(open, RETRY_MS);
      };
    };

    open();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, []);
}
