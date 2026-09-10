"use client";

// SPDX-License-Identifier: Apache-2.0

import { createContext, useCallback, useContext, useRef, useState } from "react";

export interface AdminToast {
  id: string;
  variant: "error" | "success" | "info";
  title: string;
  /** Optional secondary line, e.g. the backend's error message. */
  body?: string;
}

interface AdminToastContextValue {
  toasts: AdminToast[];
  pushToast: (t: Omit<AdminToast, "id">) => string;
  dismissToast: (id: string) => void;
}

const AdminToastContext = createContext<AdminToastContextValue | null>(null);

let counter = 0;
function nextId(prefix: string) {
  counter += 1;
  return `${prefix}_${Date.now()}_${counter}`;
}

/** Mount once at the admin root so any page can raise a transient toast for
 * action feedback. */
export function AdminToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<AdminToast[]>([]);
  const timeouts = useRef<number[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (t: Omit<AdminToast, "id">): string => {
      const id = nextId("admin_toast");
      setToasts((prev) => [...prev, { ...t, id }]);
      // Errors linger (8s) so the operator can read the reason; success/info
      // are briefer (4s).
      const ttl = t.variant === "error" ? 8000 : 4000;
      const handle = window.setTimeout(() => dismissToast(id), ttl);
      timeouts.current.push(handle);
      return id;
    },
    [dismissToast]
  );

  return (
    <AdminToastContext.Provider value={{ toasts, pushToast, dismissToast }}>
      {children}
    </AdminToastContext.Provider>
  );
}

export function useAdminToast(): AdminToastContextValue {
  const ctx = useContext(AdminToastContext);
  if (!ctx) throw new Error("useAdminToast must be used within AdminToastProvider");
  return ctx;
}
