// SPDX-License-Identifier: Apache-2.0

/**
 * Read a non-negative integer from the environment, falling back on anything
 * that is not one.
 *
 * Exists because the obvious `Number(process.env.X ?? DEFAULT)` turns a typo
 * into `NaN`, and every comparison against `NaN` is false — so a misspelt
 * value does not fail loudly, it silently switches OFF whatever limit or sweep
 * the variable controls. That is the worst possible failure mode for a safety
 * knob: the operator believes a bound is in force and nothing enforces it.
 *
 * `allowZero` is for the knobs where 0 is a real, intentional setting (turning
 * a timer or a limit off deliberately) rather than a parse accident.
 */
export function positiveIntEnv(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (value < 0 || (value === 0 && !allowZero)) return fallback;
  return Math.floor(value);
}
