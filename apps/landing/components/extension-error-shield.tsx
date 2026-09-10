"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";

/**
 * Suppresses noisy `unhandledrejection` / `error` events that originate in
 * BROWSER EXTENSIONS (chrome-extension:// | moz-extension:// stack frames), so
 * a user's extension can't surface a crash overlay for our page.
 */
function isExtensionSourced(reason: unknown): boolean {
  const stack =
    reason instanceof Error ? reason.stack ?? "" : typeof reason === "string" ? reason : "";
  return /chrome-extension:\/\/|moz-extension:\/\//.test(stack);
}

export function ExtensionErrorShield() {
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isExtensionSourced(event.reason)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const onError = (event: ErrorEvent) => {
      if (/chrome-extension:\/\/|moz-extension:\/\//.test(event.filename || "") || isExtensionSourced(event.error)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    // Capture phase so we see the event before Next's dev overlay does.
    window.addEventListener("unhandledrejection", onRejection, true);
    window.addEventListener("error", onError, true);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection, true);
      window.removeEventListener("error", onError, true);
    };
  }, []);

  return null;
}
