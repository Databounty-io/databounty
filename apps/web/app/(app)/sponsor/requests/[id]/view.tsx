"use client";

// SPDX-License-Identifier: Apache-2.0

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { authedFetch } from "@/lib/store";
import { API } from "@/lib/api-endpoints";
import { BackLink, Empty } from "@/components/ui";
import { DatasetRequestView, type DatasetRequestFull, type SampleGate } from "@/components/dataset-request-detail";
import type { ApiArtifact } from "@/lib/api-artifacts";

function SponsorRequestPageInner() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();
  const from = useSearchParams().get("from");
  const back = from === "community"
    ? { href: "/community", label: "Back to community" }
    : { href: "/sponsor", label: "Back to sponsor" };

  const [request, setRequest] = useState<DatasetRequestFull | null>(null);
  const [samples, setSamples] = useState<ApiArtifact[]>([]);
  const [sampleGate, setSampleGate] = useState<SampleGate | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "notfound" | "error">("loading");

  const load = useCallback(() => {
    if (!id) return;
    setStatus((s) => (s === "ready" ? s : "loading"));
    authedFetch(API.community.request(id))
      .then(async (r) => {
        if (r.status === 404) { setStatus("notfound"); return; }
        if (!r.ok) { setStatus("error"); return; }
        const data = (await r.json()) as {
          request: DatasetRequestFull;
          samples?: ApiArtifact[];
          sampleGate?: SampleGate | null;
        };
        setRequest(data.request);
        setSamples(data.samples ?? []);
        setSampleGate(data.sampleGate ?? null);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, [id]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (status === "ready" && request?.mintedBountyId) {
      router.replace(`/sponsor/${request.mintedBountyId}`);
    }
  }, [status, request?.mintedBountyId, router]);

  if (status === "ready" && request?.mintedBountyId) {
    return (
      <div className="mx-auto max-w-3xl">
        <Empty
          title="Opening the live program…"
          description="This request has been minted, so its full tracking view is the home for it."
        />
      </div>
    );
  }

  if (status === "ready" && request) {
    return (
      <DatasetRequestView
        request={request}
        samples={samples}
        sampleGate={sampleGate}
        onChanged={load}
        backHref={back.href}
        backLabel={back.label}
      />
    );
  }

  const message =
    status === "notfound"
      ? { title: "Request not found", description: "This dataset request doesn’t exist, or it isn’t yours." }
      : status === "error"
        ? { title: "Couldn’t load this request", description: "Please try again in a moment." }
        : { title: "Loading request…", description: "Fetching your dataset request." };

  return (
    <div className="mx-auto max-w-3xl">
      <BackLink href={back.href}>{back.label}</BackLink>
      <div className="mt-3">
        <Empty title={message.title} description={message.description} />
      </div>
    </div>
  );
}

export function SponsorRequestView() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-3xl">
          <Empty title="Loading request…" description="Fetching your dataset request." />
        </div>
      }
    >
      <SponsorRequestPageInner />
    </Suspense>
  );
}
