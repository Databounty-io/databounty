// SPDX-License-Identifier: Apache-2.0

/** Date helpers for the admin console.
 *
 * Date filters are calendar-day filters in the operator's browser timezone.
 * The API receives UTC instants so a selected day is inclusive from
 * local 00:00:00.000 through local 23:59:59.999.
 */

export function browserTimeZone(): string {
  if (typeof Intl === "undefined") return "local time";
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
}

export function dateInputValue(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateFromInput(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function startOfLocalDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function endOfLocalDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

export function localDateBounds(value: string): { from: string; to: string } {
  const day = dateFromInput(value);
  return { from: startOfLocalDay(day).toISOString(), to: endOfLocalDay(day).toISOString() };
}

export function formatDateInput(value: string): string {
  return dateFromInput(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatAdminDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatAdminDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatUtcDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}
