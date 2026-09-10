"use client";

// SPDX-License-Identifier: Apache-2.0

import { num } from "@/lib/format";
import { DASHBOARD_URL } from "@/lib/urls";
import type { ValidationPage } from "@/lib/public-data";
import { ValidationCard } from "@/components/pool-card";
import { AutoRefresh } from "@/components/auto-refresh";
import { ListingBrowser } from "@/components/listing-browser";

export default function ValidationView({ result, q }: { result: ValidationPage; q: string }) {
  const { totals, total } = result;
  return (
    <ListingBrowser
      basePath="/validation"
      heading="Validation queue"
      countSuffix="pools"
      noun={{ one: "pool", many: "validation work" }}
      headerAside={<AutoRefresh />}
      lead={
        total === null ? (
          <>The size of the validation queue is unavailable right now.</>
        ) : total === 0 && q ? (
          // A search that matched nothing says nothing about the queue as a
          // whole — stating "0 items are waiting across 0 pools" here read as a
          // global fact while 40 items were in fact queued.
          <>Nothing in the validation queue matches that search.</>
        ) : (
          <>
            {num(totals.items)} {totals.items === 1 ? "item is" : "items are"} waiting on a human
            validator across {num(totals.pools)} {totals.pools === 1 ? "pool" : "pools"}. Auditing an
            item earns karma whichever way the call goes. Deepest queue first.
          </>
        )
      }
      result={result}
      q={q}
      searchLabel="Search the validation queue"
      searchPlaceholder="search title or description…"
      renderCard={(b) => <ValidationCard key={b.id} pool={b} />}
      noResults={{
        title: "No queued validation work matches that search.",
        description: "Try a broader term, or clear the search to see the whole queue.",
      }}
      empty={{
        title: "No items are waiting on a validator right now.",
        description:
          "Validation work appears here as soon as contributions clear the automated checks. Contributing is open in the meantime.",
        action: { label: "become_a_validator", href: `${DASHBOARD_URL}/validator`, external: true },
      }}
    />
  );
}
