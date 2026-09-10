// SPDX-License-Identifier: Apache-2.0

export type DatasetCategory =
  | "debugging"
  | "implementation"
  | "test_generation"
  | "error_diagnosis"
  | "migration";

export type GenerationMethod = "human" | "ai_assisted" | "ai_generated";

export type SubmissionStatus =
  | "draft"
  | "submitted"
  | "duplicate_check"
  | "running_tests"
  | "tests_failed"
  | "llm_validation"
  | "needs_fixes"
  | "provisionally_accepted"
  | "in_audit"
  | "in_sponsor_review"
  | "accepted_pending_sample"
  | "flagged"
  | "disputed"
  | "accepted"
  | "rejected";
