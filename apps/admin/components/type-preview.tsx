"use client";

// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import type { DatasetType, TypeField } from "@/lib/dataset-types";
import { TRUST_TIER_LABELS } from "@/lib/dataset-types";

/* ------------------------------------------------------------------ */
/* TypePreview — renders how a dataset type presents on the three      */
/* surfaces (sponsor spec · contributor form · validator review),      */
/* derived ENTIRELY from field roles. Used by the admin type builder   */
/* preview and the type detail page. Pure mockup, non-functional.      */
/* ------------------------------------------------------------------ */

type Surface = "sponsor" | "contributor" | "validator";

const SURFACES: { key: Surface; label: string }[] = [
  { key: "sponsor", label: "Sponsor spec" },
  { key: "contributor", label: "Contributor form" },
  { key: "validator", label: "Validator review" },
];

export function TypePreview({
  type,
  dark = false,
  initial = "contributor",
}: {
  type: DatasetType;
  /** admin console is dark; dashboard is light */
  dark?: boolean;
  initial?: Surface;
}) {
  const [surface, setSurface] = useState<Surface>(initial);

  const frame = dark
    ? "rounded-xl border border-dark-line bg-dark-field"
    : "rounded-xl border border-line bg-white";
  const tabBase = dark
    ? "text-dark-soft hover:text-dark-text"
    : "text-ink-soft hover:text-ink";
  const tabActive = dark
    ? "bg-[rgba(163,246,10,.12)] text-lime"
    : "bg-[#f2f7e4] text-[#5f7a1e]";

  return (
    <div className={frame}>
      <div
        className={`flex flex-wrap items-center gap-1 border-b px-3 py-2 ${
          dark ? "border-dark-line" : "border-line-soft"
        }`}
      >
        {SURFACES.map((s) => (
          <button
            key={s.key}
            onClick={() => setSurface(s.key)}
            className={`shrink-0 cursor-pointer rounded-md px-2.5 py-2 font-mono text-[11px] transition-colors sm:py-1 ${
              surface === s.key ? tabActive : tabBase
            }`}
          >
            {s.label}
          </button>
        ))}
        <span
          className={`ml-auto font-mono text-[10px] ${
            dark ? "text-dark-dim" : "text-ink-faint"
          }`}
        >
          auto-rendered from field roles
        </span>
      </div>
      <div className="max-h-[430px] overflow-y-auto p-4">
        {surface === "sponsor" && <SponsorSurface type={type} dark={dark} />}
        {surface === "contributor" && (
          <ContributorSurface type={type} dark={dark} />
        )}
        {surface === "validator" && <ValidatorSurface type={type} dark={dark} />}
      </div>
    </div>
  );
}

/* ---------- shared bits ---------- */

function microLabel(dark: boolean) {
  return `font-mono text-[10px] uppercase tracking-[.05em] ${
    dark ? "text-dark-dim" : "text-ink-faint"
  }`;
}

function CodeBlockMock({
  label,
  lang,
  dark,
  lines = 3,
}: {
  label: string;
  lang?: string;
  dark: boolean;
  lines?: number;
}) {
  return (
    <div className={`overflow-hidden rounded-lg border ${dark ? "border-dark-line bg-dark" : "border-line bg-panel"}`}>
      <div className={`flex items-center justify-between border-b px-3 py-1.5 ${dark ? "border-[#1c2a19]" : "border-line"}`}>
        <span className={`font-mono text-[10px] ${dark ? "text-[#8a9382]" : "text-ink-faint"}`}>{label}</span>
        {lang && (
          <span className="rounded bg-[#12160f] px-1.5 py-px font-mono text-[9px] text-lime">
            {lang}
          </span>
        )}
      </div>
      <div className="space-y-1.5 px-3 py-2.5">
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className="h-2 rounded-sm bg-[#1c2a19]"
            style={{ width: `${[82, 64, 73, 48][i % 4]}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function TextBlockMock({ dark, lines = 2 }: { dark: boolean; lines?: number }) {
  return (
    <div
      className={`space-y-1.5 rounded-lg border px-3 py-2.5 ${
        dark ? "border-dark-line bg-[#12160f]" : "border-line bg-[#fafbf8]"
      }`}
    >
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className={`h-2 rounded-sm ${dark ? "bg-[#2a3a26]" : "bg-line"}`}
          style={{ width: `${[90, 71, 55][i % 3]}%` }}
        />
      ))}
    </div>
  );
}

/* ---------- sponsor: what the type provides ---------- */

function SponsorSurface({ type, dark }: { type: DatasetType; dark: boolean }) {
  const text = dark ? "text-dark-text" : "text-ink";
  const soft = dark ? "text-dark-soft" : "text-ink-soft";
  return (
    <div className="space-y-3.5">
      <div>
        <div className={microLabel(dark)}>each accepted item contains</div>
        <div className="mt-2 flex flex-col gap-1.5">
          {type.fields.map((f) => (
            <div key={f.key} className="flex items-center gap-2 text-[12.5px]">
              <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-lime" />
              <span className={`font-mono ${text}`}>{f.key}</span>
              <span className={`font-mono text-[10px] ${soft}`}>
                {f.role}
                {f.required ? " · required" : ""}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className={microLabel(dark)}>verification pipeline</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
          {type.verification.pipeline.map((p, i) => (
            <span key={p} className={`flex items-center gap-1.5 ${soft}`}>
              {i > 0 && <span className={dark ? "text-dark-dim" : "text-ink-faint"}>→</span>}
              <span
                className={`rounded px-1.5 py-0.5 ${
                  dark ? "bg-[#12160f] text-dark-text" : "bg-panel text-ink"
                }`}
              >
                {p}
              </span>
            </span>
          ))}
        </div>
        {type.verification.executionEnv && (
          <div className={`mt-1.5 font-mono text-[10px] ${soft}`}>
            sandbox: {type.verification.executionEnv}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-[#f2f7e4] px-2.5 py-1 font-mono text-[10px] font-bold text-[#5f7a1e]">
          {TRUST_TIER_LABELS[type.trustTier]}
        </span>
        <span className={`font-mono text-[10px] ${soft}`}>
          difficulty mix: {type.difficultyLevels.join(" / ")}
        </span>
      </div>
    </div>
  );
}

/* ---------- contributor: the submission form ---------- */

function FieldInput({ f, dark }: { f: TypeField; dark: boolean }) {
  const labelCls = `mb-1.5 flex items-center gap-2 font-mono text-[11px] font-bold ${
    dark ? "text-dark-text" : "text-ink"
  }`;
  const req = f.required && (
    <span className="font-normal text-amber-500">*</span>
  );
  switch (f.role) {
    case "input_code":
    case "solution_code":
    case "tests":
      return (
        <div>
          <div className={labelCls}>{f.label} {req}</div>
          <CodeBlockMock label={f.key} lang={f.lang} dark={dark} lines={f.role === "tests" ? 2 : 3} />
          {f.help && (
            <p className={`mt-1 text-[10.5px] ${dark ? "text-dark-dim" : "text-ink-faint"}`}>{f.help}</p>
          )}
        </div>
      );
    case "enum":
      return (
        <div>
          <div className={labelCls}>{f.label} {req}</div>
          <div className="flex flex-wrap gap-1.5">
            {(f.options ?? []).slice(0, 5).map((o) => (
              <span
                key={o}
                className={`rounded-full border px-2.5 py-1 font-mono text-[10px] ${
                  dark ? "border-dark-line text-dark-soft" : "border-line text-ink-soft"
                }`}
              >
                {o}
              </span>
            ))}
          </div>
        </div>
      );
    case "list":
      return (
        <div>
          <div className={labelCls}>{f.label} {req}</div>
          <div className="flex flex-wrap gap-1.5">
            {["item one", "item two", "+ add"].map((o) => (
              <span
                key={o}
                className={`rounded-md border border-dashed px-2 py-1 font-mono text-[10px] ${
                  dark ? "border-dark-line text-dark-dim" : "border-line text-ink-faint"
                }`}
              >
                {o}
              </span>
            ))}
          </div>
        </div>
      );
    case "expected_output":
      return (
        <div>
          <div className={labelCls}>{f.label} {req}</div>
          <CodeBlockMock label={f.key} lang="json" dark={dark} lines={2} />
        </div>
      );
    default:
      // instruction, input_context, rationale, reference
      return (
        <div>
          <div className={labelCls}>{f.label} {req}</div>
          <TextBlockMock dark={dark} lines={f.role === "rationale" ? 3 : 2} />
        </div>
      );
  }
}

function ContributorSurface({ type, dark }: { type: DatasetType; dark: boolean }) {
  return (
    <div className="space-y-3.5">
      {type.fields.map((f) => (
        <FieldInput key={f.key} f={f} dark={dark} />
      ))}
      <div className="flex justify-end pt-1">
        <span className="rounded-lg bg-lime px-4 py-2 font-mono text-[11px] font-bold text-dark">
          submit item →
        </span>
      </div>
    </div>
  );
}

/* ---------- validator: the review card ---------- */

function ValidatorSurface({ type, dark }: { type: DatasetType; dark: boolean }) {
  const soft = dark ? "text-dark-soft" : "text-ink-soft";
  const inputs = type.fields.filter((f) =>
    ["instruction", "input_context", "input_code"].includes(f.role)
  );
  const outputs = type.fields.filter((f) =>
    ["solution_code", "tests", "expected_output", "rationale", "list", "enum", "reference"].includes(f.role)
  );
  return (
    <div className="space-y-3.5">
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <div>
          <div className={microLabel(dark)}>given</div>
          <div className="mt-1.5 space-y-2">
            {inputs.map((f) =>
              f.role === "input_code" ? (
                <CodeBlockMock key={f.key} label={f.key} lang={f.lang} dark={dark} lines={2} />
              ) : (
                <TextBlockMock key={f.key} dark={dark} lines={1} />
              )
            )}
          </div>
        </div>
        <div>
          <div className={microLabel(dark)}>submitted</div>
          <div className="mt-1.5 space-y-2">
            {outputs.slice(0, 3).map((f) =>
              ["solution_code", "tests"].includes(f.role) ? (
                <CodeBlockMock key={f.key} label={f.key} lang={f.lang} dark={dark} lines={2} />
              ) : (
                <TextBlockMock key={f.key} dark={dark} lines={1} />
              )
            )}
          </div>
        </div>
      </div>
      <div className={`flex flex-wrap items-center gap-2 font-mono text-[10px] ${soft}`}>
        {type.verification.pipeline
          .filter((p) => p !== "human_audit")
          .map((p) => (
            <span key={p} className="flex items-center gap-1">
              <span className="text-[#5f7a1e]">✓</span> {p}
            </span>
          ))}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <span className="rounded-lg bg-emerald-600 px-3.5 py-1.5 font-mono text-[11px] font-bold text-white">
          approve
        </span>
        <span
          className={`rounded-lg border px-3.5 py-1.5 font-mono text-[11px] ${
            dark ? "border-dark-line text-dark-soft" : "border-line text-ink-soft"
          }`}
        >
          reject + reason
        </span>
      </div>
    </div>
  );
}
