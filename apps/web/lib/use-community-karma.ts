"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { authedFetch } from "@/lib/store";
import { API } from "@/lib/api-endpoints";
import type { KarmaHold, KarmaHoldsByRole, KarmaReleaseRule } from "@/lib/karma-state";

export interface KarmaTier {
  name: string;
  label: string;
  color: string;
  earlyAccessHours: number;
  concurrencyBonus: number;
}

export interface NextKarmaTier {
  name: string;
  label: string;
  minKarma: number;
  karmaToGo: number;
}

export interface CommunityKarma {
  total: number | null;
  tier: KarmaTier | null;
  nextTier: NextKarmaTier | null;
  securedTotal: number;
  reversedTotal: number;
  inReviewItems: number;
  inReviewProjected: number;
  validatorOpenAudits: number;
  validatorOpenItems: number;
  validatorInReviewProjected: number;
  holds: KarmaHold[];
  byRole: KarmaHoldsByRole | null;
  releaseRule: KarmaReleaseRule | null;
  loading: boolean;
}

const EMPTY: Omit<CommunityKarma, "loading"> = {
  total: null,
  tier: null,
  nextTier: null,
  securedTotal: 0,
  reversedTotal: 0,
  inReviewItems: 0,
  inReviewProjected: 0,
  validatorOpenAudits: 0,
  validatorOpenItems: 0,
  validatorInReviewProjected: 0,
  holds: [],
  byRole: null,
  releaseRule: null,
};

export function useCommunityKarma(enabled = true): CommunityKarma {
  const [state, setState] = useState<CommunityKarma>({ ...EMPTY, loading: enabled });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    authedFetch(API.me.communityKarma)
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as {
          total: number;
          tier: KarmaTier;
          nextTier: NextKarmaTier | null;
          pendingTotal?: number;
          reversedTotal?: number;
          inReview?: { items: number; projectedKarma: number };
          inReviewValidator?: { openAudits: number; openItems: number; projectedKarma: number };
          holds?: KarmaHold[];
          holdsByRole?: KarmaHoldsByRole;
          releaseRule?: KarmaReleaseRule;
        };
        if (cancelled) return;
        setState({
          total: body.total,
          tier: body.tier,
          nextTier: body.nextTier,
          securedTotal: body.pendingTotal ?? 0,
          reversedTotal: body.reversedTotal ?? 0,
          inReviewItems: body.inReview?.items ?? 0,
          inReviewProjected: body.inReview?.projectedKarma ?? 0,
          validatorOpenAudits: body.inReviewValidator?.openAudits ?? 0,
          validatorOpenItems: body.inReviewValidator?.openItems ?? 0,
          validatorInReviewProjected: body.inReviewValidator?.projectedKarma ?? 0,
          holds: body.holds ?? [],
          byRole: body.holdsByRole ?? null,
          releaseRule: body.releaseRule ?? null,
          loading: false,
        });
      })
      .catch(() => {
        if (!cancelled) setState((s) => ({ ...s, loading: false }));
      })
      .finally(() => {
        if (!cancelled) setState((s) => (s.loading ? { ...s, loading: false } : s));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
