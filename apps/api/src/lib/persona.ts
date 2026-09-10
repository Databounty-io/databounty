// SPDX-License-Identifier: Apache-2.0

export const PERSONAS = ["contributor", "validator", "sponsor"] as const;
export type Persona = (typeof PERSONAS)[number];

export function isPersona(val: unknown): val is Persona {
  return typeof val === "string" && (PERSONAS as readonly string[]).includes(val);
}
