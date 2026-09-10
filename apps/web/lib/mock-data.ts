// SPDX-License-Identifier: Apache-2.0

import type { Bounty, Submission, Dispute } from "./types";

// ---------- Code samples for debugging items ----------

export const SAMPLE_BROKEN_CODE = `function SearchResults({ query }: { query: string }) {
  const [results, setResults] = useState<Result[]>([]);

  useEffect(() => {
    fetchResults(query).then((data) => {
      // BUG: stale closure — this resolves after a newer
      // query has already been dispatched, clobbering it
      setResults(data);
    });
  }, [query]);

  return <ResultList items={results} />;
}`;

export const SAMPLE_FIXED_CODE = `function SearchResults({ query }: { query: string }) {
  const [results, setResults] = useState<Result[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchResults(query).then((data) => {
      if (!cancelled) setResults(data);
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  return <ResultList items={results} />;
}`;

export const SAMPLE_TESTS = `test("shows results for the latest query only", async () => {
  const { rerender } = render(<SearchResults query="react" />);
  rerender(<SearchResults query="react hooks" />);
  resolveFetch("react", [{ id: 1, title: "old" }]);   // late response
  resolveFetch("react hooks", [{ id: 2, title: "new" }]);
  await waitFor(() =>
    expect(screen.getByText("new")).toBeInTheDocument()
  );
  expect(screen.queryByText("old")).not.toBeInTheDocument();
});

test("cleans up pending request on unmount", async () => {
  const { unmount } = render(<SearchResults query="react" />);
  unmount();
  resolveFetch("react", [{ id: 1, title: "late" }]);
  expect(consoleErrorSpy).not.toHaveBeenCalled();
});`;

export const SAMPLE_EXPLANATION =
  "The effect captures setResults in a closure that outlives the query it was created for. When responses resolve out of order, an older response overwrites the newer results. The fix tracks a cancelled flag in the effect cleanup so only the response belonging to the current query commits state.";

export const SAMPLE_FAILING_LOGS = `$ sandbox run --broken
 PASS  search-results.test.tsx (2 tests)   ← expected FAIL

Execution check failed:
  broken_code must fail at least one submitted test, but all
  tests passed against the broken code. The tests do not
  reproduce the bug described in the prompt.

  tests_run: 2
  broken_code_failed_tests: false  (required: true)
  fixed_code_passed_tests:  true`;

export const SAMPLE_PASSING_LOGS = `$ sandbox run --broken
 FAIL  search-results.test.tsx
   ✕ shows results for the latest query only (34 ms)

$ sandbox run --fixed
 PASS  search-results.test.tsx
   ✓ shows results for the latest query only (28 ms)
   ✓ cleans up pending request on unmount (11 ms)

execution: pass  (broken fails 1/2, fixed passes 2/2)`;

// ---------- Delivered pools ----------

export const DELIVERED_BOUNTIES: Bounty[] = [
  {
    id: "d-ts-generics",
    title: "TypeScript Generics Implementation Set",
    description: "Feature-implementation items exercising advanced generics.",
    category: "implementation",
    language: "TypeScript",
    framework: "std",
    targetItems: 1000,
    acceptedItems: 1000,
    submittedItems: 0, needsFixesItems: 0, rejectedItems: 121,
    status: "completed",
    auditMode: "partial",
    license: "non_exclusive",
    karmaPerAcceptedItem: 5.6,
    deadline: "2026-05-01",
    requesterNickname: "typedset",
    duplicateRate: 0.09, llmPassRate: 0.82, contributorCount: 38, validatorCount: 7,
    slots: [],
    deliveredAt: "2026-05-04",
    generationMix: { human: 0.2, aiAssisted: 0.66, aiGenerated: 0.14 },
  },
  {
    id: "d-react-perf",
    title: "React Re-render Debugging Pack",
    description: "Debugging items on unnecessary re-renders and memo misuse.",
    category: "debugging",
    language: "TypeScript",
    framework: "React",
    targetItems: 600,
    acceptedItems: 600,
    submittedItems: 0, needsFixesItems: 0, rejectedItems: 88,
    status: "completed",
    auditMode: "full",
    license: "exclusive",
    karmaPerAcceptedItem: 9.75,
    deadline: "2026-04-15",
    requesterNickname: "anon-buyer-4",
    duplicateRate: 0.07, llmPassRate: 0.85, executionPassRate: 0.78,
    contributorCount: 21, validatorCount: 9,
    slots: [],
    deliveredAt: "2026-04-19",
    generationMix: { human: 0.31, aiAssisted: 0.58, aiGenerated: 0.11 },
  },
  {
    id: "d-py-pandas",
    title: "Pandas Migration to Polars Corpus",
    description: "Migration items converting pandas pipelines to polars.",
    category: "migration",
    language: "Python",
    framework: "polars",
    targetItems: 750,
    acceptedItems: 512,
    submittedItems: 0, needsFixesItems: 0, rejectedItems: 96,
    status: "partially_completed",
    auditMode: "partial",
    license: "non_exclusive",
    karmaPerAcceptedItem: 5,
    deadline: "2026-03-30",
    requesterNickname: "dfbench",
    duplicateRate: 0.12, llmPassRate: 0.78, contributorCount: 26, validatorCount: 5,
    slots: [],
    deliveredAt: "2026-04-02",
    generationMix: { human: 0.18, aiAssisted: 0.71, aiGenerated: 0.11 },
  },
  {
    id: "d-js-tests",
    title: "Jest Unit Test Generation Set",
    description: "Test-generation items for utility-heavy JS codebases.",
    category: "test_generation",
    language: "JavaScript",
    framework: "Jest",
    targetItems: 1500,
    acceptedItems: 1500,
    submittedItems: 0, needsFixesItems: 0, rejectedItems: 203,
    status: "completed",
    auditMode: "llm_only",
    license: "non_exclusive",
    karmaPerAcceptedItem: 4.3,
    deadline: "2026-03-01",
    requesterNickname: "coverageai",
    duplicateRate: 0.15, llmPassRate: 0.76, contributorCount: 52, validatorCount: 0,
    slots: [],
    deliveredAt: "2026-03-06",
    generationMix: { human: 0.09, aiAssisted: 0.62, aiGenerated: 0.29 },
  },
  {
    id: "d-sql-errors",
    title: "PostgreSQL Error Diagnosis Dataset",
    description: "Error-diagnosis items from realistic Postgres failures.",
    category: "error_diagnosis",
    language: "SQL",
    framework: "PostgreSQL",
    targetItems: 800,
    acceptedItems: 800,
    submittedItems: 0, needsFixesItems: 0, rejectedItems: 74,
    status: "completed",
    auditMode: "partial",
    license: "exclusive",
    karmaPerAcceptedItem: 6.5,
    deadline: "2026-02-20",
    requesterNickname: "anon-buyer-2",
    duplicateRate: 0.08, llmPassRate: 0.83, contributorCount: 19, validatorCount: 6,
    slots: [],
    deliveredAt: "2026-02-25",
    generationMix: { human: 0.26, aiAssisted: 0.65, aiGenerated: 0.09 },
  },
  {
    id: "d-swift-debug",
    title: "SwiftUI State Management Bug Set",
    description: "Debugging items on SwiftUI state, bindings, and lifecycle.",
    category: "debugging",
    language: "Swift",
    framework: "SwiftUI",
    targetItems: 450,
    acceptedItems: 450,
    submittedItems: 0, needsFixesItems: 0, rejectedItems: 51,
    status: "completed",
    auditMode: "partial",
    license: "non_exclusive",
    karmaPerAcceptedItem: 7.9,
    deadline: "2026-01-31",
    requesterNickname: "fruitbench",
    duplicateRate: 0.06, llmPassRate: 0.87, contributorCount: 14, validatorCount: 4,
    slots: [],
    deliveredAt: "2026-02-03",
    generationMix: { human: 0.35, aiAssisted: 0.55, aiGenerated: 0.1 },
  },
  {
    id: "d-api-impl",
    title: "REST Handler Implementation Corpus",
    description: "Implementation items: spec to Express/Fastify handlers.",
    category: "implementation",
    language: "TypeScript",
    framework: "Fastify",
    targetItems: 1200,
    acceptedItems: 1200,
    submittedItems: 0, needsFixesItems: 0, rejectedItems: 167,
    status: "completed",
    auditMode: "partial",
    license: "non_exclusive",
    karmaPerAcceptedItem: 5.75,
    deadline: "2026-01-10",
    requesterNickname: "apiforge",
    duplicateRate: 0.11, llmPassRate: 0.8, contributorCount: 41, validatorCount: 8,
    slots: [],
    deliveredAt: "2026-01-14",
    generationMix: { human: 0.15, aiAssisted: 0.7, aiGenerated: 0.15 },
  },

  // ---- Sponsor-owned, delivered (mine) — ready to download ----
  {
    id: "s-completed",
    title: "Python Type-Hint Migration Pack",
    description:
      "Migration items adding precise type hints to untyped Python codebases, verified with mypy --strict.",
    category: "migration",
    language: "Python",
    framework: "mypy",
    targetItems: 800,
    acceptedItems: 800,
    submittedItems: 0,
    needsFixesItems: 0,
    rejectedItems: 92,
    status: "completed",
    auditMode: "partial",
    license: "non_exclusive",
    karmaPerAcceptedItem: 5,
    deadline: "2026-06-20",
    requesterNickname: "you",
    mine: true,
    duplicateRate: 0.08,
    llmPassRate: 0.85,
    contributorCount: 33,
    validatorCount: 6,
    slots: [],
    deliveredAt: "2026-06-24",
    generationMix: { human: 0.19, aiAssisted: 0.68, aiGenerated: 0.13 },
  },
  {
    id: "s-partial",
    title: "Elixir Pattern-Match Diagnosis",
    description:
      "Error-diagnosis items on Elixir pattern-match and GenServer failures. Underfilled by deadline — accepted work delivered.",
    category: "error_diagnosis",
    language: "Elixir",
    framework: "OTP",
    targetItems: 600,
    acceptedItems: 372,
    submittedItems: 0,
    needsFixesItems: 0,
    rejectedItems: 54,
    status: "partially_completed",
    auditMode: "partial",
    license: "non_exclusive",
    karmaPerAcceptedItem: 5.5,
    deadline: "2026-06-01",
    requesterNickname: "you",
    mine: true,
    duplicateRate: 0.11,
    llmPassRate: 0.79,
    contributorCount: 18,
    validatorCount: 4,
    slots: [],
    deliveredAt: "2026-06-05",
    generationMix: { human: 0.22, aiAssisted: 0.64, aiGenerated: 0.14 },
  },
];

// ---------- Contributor data ----------

export const MY_SUBMISSIONS: Submission[] = [
  {
    id: "sub-1",
    bountyId: "b-react-hooks",
    batchId: "cb-active",
    title: "Stale useEffect closure in filtered search",
    prompt:
      "The component below returns stale search results after the query changes quickly. Fix the bug so only the latest query's results are shown.",
    language: "typescript",
    framework: "react",
    difficulty: "intermediate",
    bugType: "stale_closure",
    concepts: ["useEffect", "closures", "async state"],
    brokenCode: SAMPLE_BROKEN_CODE,
    fixedCode: SAMPLE_FIXED_CODE,
    tests: SAMPLE_TESTS,
    explanation: SAMPLE_EXPLANATION,
    expectedBehavior:
      "Only results for the most recent query render, even when responses resolve out of order.",
    generationMethod: "ai_assisted",
    status: "accepted",
    duplicateScore: 0.12,
    llmScore: 0.86,
    execution: {
      brokenCodeFailedTests: true,
      fixedCodePassedTests: true,
      testsRun: 2,
      logs: SAMPLE_PASSING_LOGS,
      decision: "pass",
    },
    flags: [],
    reward: 6,
    submittedAt: "2026-07-03",
  },
  {
    id: "sub-2",
    bountyId: "b-react-hooks",
    batchId: "cb-active",
    title: "Interval cleanup missing in countdown hook",
    prompt:
      "This custom useCountdown hook keeps ticking after unmount and doubles its speed on re-render. Fix both problems.",
    language: "typescript",
    framework: "react",
    difficulty: "intermediate",
    bugType: "effect_cleanup",
    concepts: ["useEffect", "setInterval", "cleanup"],
    brokenCode: `function useCountdown(seconds: number) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    // BUG: no cleanup — interval leaks on unmount
    // and stacks on every re-render
    setInterval(() => setLeft((s) => s - 1), 1000);
  });
  return left;
}`,
    fixedCode: `function useCountdown(seconds: number) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const id = setInterval(() => setLeft((s) => s - 1), 1000);
    return () => clearInterval(id);
  }, []);
  return left;
}`,
    tests: `test("stops ticking after unmount", () => { /* ... */ });
test("ticks once per second, not faster", () => { /* ... */ });`,
    explanation:
      "The effect has no dependency array and no cleanup, so every render registers another interval and none are cleared on unmount.",
    expectedBehavior: "One interval, cleared on unmount.",
    generationMethod: "ai_assisted",
    status: "tests_failed",
    duplicateScore: 0.18,
    execution: {
      brokenCodeFailedTests: false,
      fixedCodePassedTests: true,
      testsRun: 2,
      logs: SAMPLE_FAILING_LOGS,
      decision: "fail",
    },
    reviewNotes: [
      "Execution check: the submitted tests pass against the broken code, so they do not reproduce the bug. Use fake timers and assert tick counts to make the broken version fail.",
    ],
    flags: [],
    reward: 6,
    submittedAt: "2026-07-04",
  },
  {
    id: "sub-3",
    bountyId: "b-react-hooks",
    batchId: "cb-active",
    title: "Derived state duplicated into useState",
    prompt:
      "Filtered list is copied into state and drifts out of sync with props. Refactor so the derived data stays consistent.",
    language: "typescript",
    framework: "react",
    difficulty: "beginner",
    bugType: "derived_state",
    concepts: ["useState", "useMemo", "props sync"],
    brokenCode: `const [visible, setVisible] = useState(items.filter(f));
// BUG: never updates when items changes`,
    fixedCode: `const visible = useMemo(() => items.filter(f), [items, f]);`,
    tests: `test("updates visible list when items prop changes", () => { /* ... */ });`,
    explanation:
      "Deriving state in useState's initializer runs once. useMemo recomputes when inputs change and removes the second source of truth.",
    expectedBehavior: "Visible list always reflects current props.",
    generationMethod: "human",
    status: "flagged",
    duplicateScore: 0.22,
    llmScore: 0.71,
    execution: {
      brokenCodeFailedTests: true,
      fixedCodePassedTests: true,
      testsRun: 1,
      logs: "execution: pass (broken fails 1/1, fixed passes 1/1)",
      decision: "pass",
    },
    flags: [
      {
        id: "flag-1",
        submissionId: "sub-3",
        validatorUserId: "usr_mock_validator_9mQz",
        reason: "too_trivial",
        details:
          "Single-line fix with a one-assertion test. Bounty spec asks for intermediate-complexity items with realistic component context — this reads as a lint rule, not a debugging scenario.",
        status: "open",
      },
    ],
    reward: 6,
    submittedAt: "2026-07-04",
  },
];

export const DISPUTES: Dispute[] = [
  {
    id: "disp-1",
    bountyTitle: "React Hooks Debugging Dataset",
    submissionTitle: "Context re-render storm in theme provider",
    flagReason: "solution_incorrect",
    contributorArgument:
      "The fix memoizes the context value, which resolves the re-render storm the prompt describes. Validator expected a context-splitting refactor, but the spec does not require one.",
    validatorArgument:
      "Memoizing the value object hides the issue for the given tree but the provider still re-renders all consumers when unrelated state changes. The fix does not match the explanation.",
    status: "open",
  },
  {
    id: "disp-2",
    bountyTitle: "Go Table-Driven Test Generation Set",
    submissionTitle: "Tests for path normalization helpers",
    flagReason: "contaminated",
    contributorArgument:
      "These are standard-library-style cases anyone would write for path handling. No benchmark was copied.",
    validatorArgument:
      "Case names and inputs match an existing submission nearly verbatim; duplicate similarity 0.81 supports the flag.",
    status: "open",
  },
  {
    id: "disp-3",
    bountyTitle: "Python Async Error Diagnosis Corpus",
    submissionTitle: "Deadlock from nested event loop",
    flagReason: "low_quality",
    contributorArgument:
      "Nested loop calls happen constantly in notebook and legacy-integration contexts. The trace is realistic.",
    validatorArgument:
      "The provided traceback mixes asyncio and trio frames in a way that cannot occur in one process.",
    status: "open",
  },
];
