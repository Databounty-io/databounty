// SPDX-License-Identifier: Apache-2.0

export type HandleAvailability = {
  available: boolean;
  claimed?: boolean;
  reason?: string;
  suggestions?: string[];
};

/** Normalizes the response contract shared by onboarding and Profile. */
export async function readHandleAvailability(response: Response): Promise<HandleAvailability> {
  const body = (await response.json().catch(() => ({}))) as HandleAvailability;
  return {
    available: response.ok && body.available === true,
    claimed: body.claimed === true,
    reason: body.reason,
    suggestions: body.suggestions ?? [],
  };
}
