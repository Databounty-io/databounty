-- DataBounty Community — consolidated initial migration.
--
-- Squashed from the eleven migrations dated 2026-08-31 .. 2026-09-02 that
-- preceded the first public release. Their history is not interesting to
-- anyone installing this repo, and a single init is the honest starting point
-- for a project that has not shipped yet.
--
-- WHAT A NAIVE SQUASH WOULD HAVE LOST. `prisma migrate diff` reproduces only
-- what `schema.prisma` can express: tables, columns, enums, plain indexes and
-- foreign keys. It emits ZERO of the CHECK constraints, ZERO of the partial
-- unique indexes, and none of the seeded catalog data. Those were restored
-- from V1 by hand in raw SQL precisely because Prisma cannot model them, so
-- they are re-appended below verbatim rather than regenerated from intent.
-- Verified by object-level diff against a database built from the original
-- eleven migrations: identical.
--
-- Sections:
--   1. Schema (generated -- tables, enums, indexes, foreign keys)
--   2. Partial unique index: race-free duplicate guard
--   3. CHECK constraints and the one-open-dispute index restored from V1
--   4. Seed data: launch badge catalog
--
-- The one thing deliberately NOT carried over is the data-only statement from
-- 20260902160000 (`UPDATE validation_results SET stage='dedupe' WHERE
-- stage='duplicate_check'`). It rewrote rows written before the rename; on the
-- empty database an init runs against it matches nothing. The new spelling is
-- already the one in `schema.prisma`.

-- ============================================================
-- 1. Schema
-- ============================================================
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AuthMethod" AS ENUM ('google', 'email');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('sponsor', 'contributor', 'validator', 'admin', 'member', 'support');

-- CreateEnum
CREATE TYPE "ChannelKind" AS ENUM ('email', 'telegram', 'discord', 'slack', 'google_chat', 'microsoft_teams');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('pending', 'digesting', 'done', 'dead');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('pending', 'processing', 'sent', 'failed', 'dead');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('pending', 'processing', 'done', 'failed', 'dead', 'cancelled');

-- CreateEnum
CREATE TYPE "ProfileSourceKind" AS ENUM ('linkedin', 'github', 'scholar', 'orcid', 'kaggle', 'x', 'website');

-- CreateEnum
CREATE TYPE "SponsorUse" AS ENUM ('training', 'evaluation', 'fine_tuning', 'benchmark');

-- CreateEnum
CREATE TYPE "ApiKeyScope" AS ENUM ('read', 'contribute', 'validate', 'artifact', 'sponsor', 'account');

-- CreateEnum
CREATE TYPE "DatasetCategory" AS ENUM ('debugging', 'implementation', 'test_generation', 'error_diagnosis', 'migration');

-- CreateEnum
CREATE TYPE "DomainId" AS ENUM ('coding', 'legal', 'healthcare', 'finance', 'science');

-- CreateEnum
CREATE TYPE "TrustTier" AS ENUM ('execution_verified', 'llm_verified', 'expert_audited');

-- CreateEnum
CREATE TYPE "DatasetTypeStatus" AS ENUM ('active', 'draft', 'coming_soon', 'platform_review');

-- CreateEnum
CREATE TYPE "DatasetTypeOrigin" AS ENUM ('platform', 'sponsor');

-- CreateEnum
CREATE TYPE "AuditMode" AS ENUM ('llm_only', 'partial', 'full');

-- CreateEnum
CREATE TYPE "GenerationMethod" AS ENUM ('human', 'ai_assisted', 'ai_generated');

-- CreateEnum
CREATE TYPE "BountyStatus" AS ENUM ('draft', 'planning', 'platform_review', 'active', 'paused', 'closing', 'export_ready', 'completed', 'partially_completed', 'cancelled', 'disputed');

-- CreateEnum
CREATE TYPE "BountyKind" AS ENUM ('community');

-- CreateEnum
CREATE TYPE "DatasetRequestStatus" AS ENUM ('submitted', 'under_review', 'changes_requested', 'approved', 'declined', 'disputed', 'implemented');

-- CreateEnum
CREATE TYPE "CommunityPublicationStatus" AS ENUM ('not_requested', 'pending', 'publishing', 'published', 'failed', 'manual_review', 'retracted', 'not_configured', 'awaiting_manual_upload');

-- CreateEnum
CREATE TYPE "PublicationTarget" AS ENUM ('huggingface', 'github', 'aikosh');

-- CreateEnum
CREATE TYPE "KarmaEventType" AS ENUM ('community_item_accepted', 'community_item_reversed', 'community_audit_completed', 'community_request_approved', 'community_bounty_published', 'community_flag_confirmed', 'community_publish_bonus', 'admin_adjustment');

-- CreateEnum
CREATE TYPE "BadgeMetric" AS ENUM ('verified_credentials', 'accepted_items', 'clean_delivery_streak', 'completed_audits', 'confirmed_flags', 'karma_total', 'published_datasets', 'flag_accuracy_pct', 'leaderboard_rank', 'zero_abandons', 'zero_dismissed_flags', 'manual');

-- CreateEnum
CREATE TYPE "BadgeFamily" AS ENUM ('build', 'audit', 'platform');

-- CreateEnum
CREATE TYPE "BadgeIcon" AS ENUM ('check', 'code', 'shield', 'clock', 'eye', 'award', 'flag', 'sparkles', 'zap', 'users', 'database', 'layers', 'coins', 'beaker');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('draft', 'submitted', 'duplicate_check', 'contamination_check', 'running_tests', 'tests_failed', 'llm_validation', 'needs_fixes', 'provisionally_accepted', 'in_audit', 'in_sponsor_review', 'flagged', 'disputed', 'accepted', 'accepted_pending_sample', 'rejected');

-- CreateEnum
CREATE TYPE "ContributorBatchStatus" AS ENUM ('available', 'claimed', 'submitted', 'needs_fixes', 'partially_accepted', 'accepted', 'abandoned');

-- CreateEnum
CREATE TYPE "FlagReason" AS ENUM ('duplicate', 'contaminated', 'tests_invalid', 'solution_incorrect', 'too_trivial', 'low_quality', 'off_spec', 'other');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('open', 'fixed', 'disputed', 'confirmed', 'dismissed');

-- CreateEnum
CREATE TYPE "AuditVerdict" AS ENUM ('ok', 'flagged');

-- CreateEnum
CREATE TYPE "SponsorExampleReviewStatus" AS ENUM ('pending', 'approved', 'needs_changes', 'rejected');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('open', 'resolved');

-- CreateEnum
CREATE TYPE "ArtifactKind" AS ENUM ('sponsor_reference', 'submission_attachment', 'bulk_submission_source', 'validation_log', 'validation_report', 'export_bundle', 'public_sample', 'benchmark_manifest', 'benchmark_private_split', 'benchmark_run_output', 'publication_bundle');

-- CreateEnum
CREATE TYPE "ArtifactVisibility" AS ENUM ('private', 'work_brief', 'accepted_delivery', 'public_sample');

-- CreateEnum
CREATE TYPE "ArtifactStatus" AS ENUM ('pending_upload', 'scanning', 'ready', 'quarantined', 'deleted');

-- CreateEnum
CREATE TYPE "BulkParseStatus" AS ENUM ('not_applicable', 'skipped', 'pending', 'processing', 'done', 'failed');

-- CreateEnum
CREATE TYPE "ArtifactModality" AS ENUM ('image', 'video', 'audio', 'document', 'archive', 'code', 'text', 'other');

-- CreateEnum
CREATE TYPE "ArtifactScanStatus" AS ENUM ('not_required', 'pending', 'clean', 'infected', 'error', 'content_mismatch');

-- CreateEnum
CREATE TYPE "BenchmarkStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "BenchmarkVersionStatus" AS ENUM ('draft', 'building', 'validating', 'ready', 'published', 'failed', 'archived');

-- CreateEnum
CREATE TYPE "BenchmarkTaskSplit" AS ENUM ('public_sample', 'private_holdout');

-- CreateEnum
CREATE TYPE "BenchmarkRunStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "BenchmarkTaskResultStatus" AS ENUM ('pending', 'running', 'passed', 'failed', 'errored', 'skipped', 'cancelled');

-- CreateEnum
CREATE TYPE "WorkspaceKind" AS ENUM ('personal', 'team');

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "PasswordTokenPurpose" AS ENUM ('reset', 'set');

-- CreateEnum
CREATE TYPE "DatasetTypeHarnessStatus" AS ENUM ('draft', 'proof_pending', 'verified', 'retired');

-- CreateEnum
CREATE TYPE "AgentIssueStatus" AS ENUM ('received', 'triaged', 'investigating', 'needs_info', 'duplicate', 'not_reproducible', 'resolved', 'rejected');

-- CreateEnum
CREATE TYPE "AgentIssueCategory" AS ENUM ('contract', 'validation', 'mcp', 'upload_processing', 'data_quality', 'security_privacy', 'abuse', 'other');

-- CreateEnum
CREATE TYPE "AgentIssueImpact" AS ENUM ('blocked', 'degraded', 'suggestion');

-- CreateEnum
CREATE TYPE "AgentIssueSeverity" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "SystemAlertSeverity" AS ENUM ('info', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "SystemAlertStatus" AS ENUM ('active', 'resolved');

-- CreateEnum
CREATE TYPE "OperationalAlertDeliveryStatus" AS ENUM ('pending', 'processing', 'sent', 'failed', 'dead');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "auth_method" "AuthMethod" NOT NULL,
    "email" TEXT,
    "google_id" TEXT,
    "password_hash" TEXT,
    "display_name" TEXT NOT NULL,
    "handle" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "onboarded" BOOLEAN NOT NULL DEFAULT false,
    "persona" TEXT,
    "profile_public" BOOLEAN NOT NULL DEFAULT false,
    "karma_total" INTEGER NOT NULL DEFAULT 0,
    "leaderboard_rank" INTEGER,
    "leaderboard_rank_at" TIMESTAMP(3),
    "leaderboard_rank_prev" INTEGER,
    "leaderboard_rank_moved_at" TIMESTAMP(3),
    "public_profile_prefs" JSONB,
    "email_verified_at" TIMESTAMP(3),
    "revocation_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "WorkspaceKind" NOT NULL DEFAULT 'personal',
    "owner_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'owner',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("workspace_id","user_id")
);

-- CreateTable
CREATE TABLE "admin_invites" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_nonces" (
    "id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "message" TEXT,
    "used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_clients" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_hash" TEXT,
    "client_name" TEXT,
    "redirect_uris" TEXT[],
    "grant_types" TEXT[] DEFAULT ARRAY['authorization_code', 'refresh_token']::TEXT[],
    "token_endpoint_auth_method" TEXT NOT NULL DEFAULT 'none',
    "owner_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_authorization_requests" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT,
    "redirect_uri" TEXT NOT NULL,
    "scope" TEXT[],
    "state" TEXT,
    "code_challenge" TEXT NOT NULL,
    "resource" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "approved_at" TIMESTAMP(3),
    "denied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorization_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_authorization_codes" (
    "id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "scope" TEXT[],
    "code_challenge" TEXT NOT NULL,
    "resource" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_access_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scope" TEXT[],
    "resource" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_refresh_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scope" TEXT[],
    "resource" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "rotated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_audit_events" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "client_id" TEXT,
    "user_id" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "purpose" "PasswordTokenPurpose" NOT NULL DEFAULT 'reset',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "admin_settings_history" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "action" TEXT NOT NULL,
    "changed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_settings_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_audit_log" (
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "user_id" TEXT,
    "account_id" TEXT,
    "prompt_hash" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "output_hash" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_micro_usd" BIGINT NOT NULL,
    "fallback_used" BOOLEAN NOT NULL,
    "failover_used" BOOLEAN NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_quota_reservations" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "user_id" TEXT,
    "reserved_cost_micro_usd" BIGINT NOT NULL,
    "quota_day" TIMESTAMP(3),
    "quota_shard" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_quota_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_quota_buckets" (
    "quota_day" TIMESTAMP(3) NOT NULL,
    "shard" INTEGER NOT NULL,
    "limit_micro_usd" BIGINT NOT NULL,
    "reserved_micro_usd" BIGINT NOT NULL DEFAULT 0,
    "settled_micro_usd" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_quota_buckets_pkey" PRIMARY KEY ("quota_day","shard")
);

-- CreateTable
CREATE TABLE "llm_cache" (
    "key" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_cache_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "llm_routing_overrides" (
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "account_id" TEXT,
    "model_key" TEXT,
    "max_tokens" INTEGER,
    "temperature" DOUBLE PRECISION,
    "timeout_ms" INTEGER,
    "enabled" BOOLEAN,
    "eval_id" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_routing_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_change_evaluations" (
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "account_id" TEXT,
    "target" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "config_hash" TEXT NOT NULL,
    "candidate_prompt" TEXT,
    "candidate_config" JSONB,
    "sample_count" INTEGER NOT NULL DEFAULT 0,
    "pass_rate" DOUBLE PRECISION,
    "regression_rate" DOUBLE PRECISION,
    "canary_percent" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_by" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_change_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channels" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" "ChannelKind" NOT NULL,
    "address" TEXT NOT NULL,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "deliver" BOOLEAN NOT NULL DEFAULT false,
    "deliver_digest" BOOLEAN NOT NULL DEFAULT true,
    "verified_at" TIMESTAMP(3),
    "last_error" TEXT,
    "last_failure_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "verify_code_hash" TEXT,
    "verify_code_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_oauth_states" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "state_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_links" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "telegram_user_id" TEXT,
    "telegram_handle" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "link_code_expires_at" TIMESTAMP(3),
    "linked_at" TIMESTAMP(3),

    CONSTRAINT "telegram_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watch_prefs" (
    "user_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "domains" TEXT[] DEFAULT ARRAY['coding']::TEXT[],
    "categories" TEXT[],
    "languages" TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watch_prefs_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "profile_sources" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source" "ProfileSourceKind" NOT NULL,
    "handle_or_url" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "external_id" TEXT,
    "verified_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "next_check_at" TIMESTAMP(3),
    "verification_state" TEXT NOT NULL DEFAULT 'unverified',
    "verify_challenge" TEXT,
    "verify_last_error" TEXT,
    "access_token_enc" TEXT,
    "refresh_token_enc" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_source_verifications" (
    "id" TEXT NOT NULL,
    "profile_source_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "check_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "adapter_version" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "error_code" TEXT,
    "evidence" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "profile_source_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_workspace_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "team_name" TEXT NOT NULL,
    "bot_user_id" TEXT NOT NULL,
    "bot_token_enc" TEXT NOT NULL,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_workspace_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_provider_circuits" (
    "provider" TEXT NOT NULL,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "open_until" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_provider_circuits_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "sponsor_scopes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "domains" TEXT[] DEFAULT ARRAY['coding']::TEXT[],
    "dataset_type_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categories" TEXT[],
    "languages" TEXT[],
    "volume" TEXT,
    "uses" TEXT[],
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sponsor_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" "ApiKeyScope"[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key_rate_buckets" (
    "key_id" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "api_key_rate_buckets_pkey" PRIMARY KEY ("key_id","window_start")
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_snapshot" JSONB,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "result" TEXT NOT NULL DEFAULT 'success',
    "metadata" JSONB,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "prev_hash" TEXT,
    "row_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_chain_repairs" (
    "id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "first_invalid_id" TEXT NOT NULL,
    "affected_rows" INTEGER NOT NULL,
    "original_head_hash" TEXT,
    "repaired_head_hash" TEXT,
    "manifest" JSONB NOT NULL,
    "repaired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_chain_repairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_types" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "supersedes_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "domain" "DomainId" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "DatasetTypeStatus" NOT NULL,
    "origin" "DatasetTypeOrigin" NOT NULL,
    "category" "DatasetCategory" NOT NULL,
    "trust_tier" "TrustTier" NOT NULL,
    "fields" JSONB NOT NULL,
    "verification" JSONB NOT NULL,
    "sample_assets" JSONB,
    "complexity_score" INTEGER,
    "verification_units" INTEGER,
    "review_note" TEXT,
    "difficulty_levels" TEXT[],
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "forked_from_id" TEXT,
    "author_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dataset_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_type_harnesses" (
    "id" TEXT NOT NULL,
    "dataset_type_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "DatasetTypeHarnessStatus" NOT NULL DEFAULT 'draft',
    "source" TEXT NOT NULL,
    "source_sha" TEXT NOT NULL,
    "declared_runtimes" TEXT[],
    "proof_evidence" JSONB,
    "proof_samples" JSONB,
    "proof_job_id" TEXT,
    "author_user_id" TEXT,
    "review_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dataset_type_harnesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" TEXT NOT NULL,
    "domain" "DomainId" NOT NULL,
    "user_id" TEXT,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bounties" (
    "id" TEXT NOT NULL,
    "requester_user_id" TEXT NOT NULL,
    "kind" "BountyKind" NOT NULL DEFAULT 'community',
    "community_requester_user_id" TEXT,
    "karma_per_accepted_item" INTEGER NOT NULL DEFAULT 0,
    "community_license" TEXT,
    "community_license_url" TEXT,
    "publication_status" "CommunityPublicationStatus" NOT NULL DEFAULT 'not_requested',
    "hugging_face_dataset" TEXT,
    "dataset_type_id" TEXT,
    "dataset_type_version" INTEGER,
    "karma_quote" JSONB,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "dataset_category" "DatasetCategory" NOT NULL,
    "language" TEXT NOT NULL,
    "framework" TEXT NOT NULL,
    "target_items" BIGINT NOT NULL,
    "required_sponsor_examples" INTEGER NOT NULL DEFAULT 3,
    "status" "BountyStatus" NOT NULL DEFAULT 'draft',
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "audit_mode" "AuditMode" NOT NULL,
    "audit_coverage_pct" INTEGER NOT NULL,
    "community_validation_mode" TEXT,
    "human_audit_window_size" INTEGER,
    "human_audit_failure_threshold_pct" INTEGER,
    "pool_difficulty" TEXT,
    "hold_days" INTEGER NOT NULL,
    "dispute_window_hours" INTEGER,
    "deadline" TIMESTAMP(3),
    "revision_note" TEXT,
    "accepted_items" BIGINT NOT NULL DEFAULT 0,
    "final_accepted_items" BIGINT NOT NULL DEFAULT 0,
    "pool_closed_at" TIMESTAMP(3),
    "pool_sampling_started_at" TIMESTAMP(3),
    "pool_sampling_completed_at" TIMESTAMP(3),
    "dispute_cycle_window_opens_at" TIMESTAMP(3),
    "dispute_cycle_settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bounties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_publications" (
    "id" TEXT NOT NULL,
    "bounty_id" TEXT NOT NULL,
    "target" "PublicationTarget" NOT NULL,
    "status" "CommunityPublicationStatus" NOT NULL DEFAULT 'pending',
    "external_id" TEXT,
    "url" TEXT,
    "pushed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "published_by_user_id" TEXT,
    "bundle_artifact_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dataset_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_audit_windows" (
    "id" TEXT NOT NULL,
    "bounty_id" TEXT NOT NULL,
    "window_index" INTEGER NOT NULL,
    "eligible_count" INTEGER NOT NULL,
    "quota" INTEGER NOT NULL,
    "carry_numerator" INTEGER NOT NULL DEFAULT 0,
    "closure_reason" TEXT NOT NULL,
    "selection_version" TEXT NOT NULL DEFAULT 'hmac-sha256-v1',
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "rejected_selected_count" INTEGER,
    "superseded_at" TIMESTAMP(3),
    "superseded_reason" TEXT,
    "claimed_by_user_id" TEXT,
    "claimed_at" TIMESTAMP(3),
    "claim_expires_at" TIMESTAMP(3),
    "audit_batch_id" TEXT,

    CONSTRAINT "human_audit_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_audit_window_memberships" (
    "id" TEXT NOT NULL,
    "window_id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "rank" TEXT NOT NULL,

    CONSTRAINT "human_audit_window_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_requests" (
    "id" TEXT NOT NULL,
    "requester_user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "dataset_type_id" TEXT,
    "domain" "DomainId",
    "proposed_license" TEXT NOT NULL,
    "language" TEXT,
    "framework" TEXT,
    "target_items" INTEGER,
    "difficulty_mix" TEXT,
    "audit_coverage_pct" INTEGER,
    "idempotency_key" TEXT NOT NULL,
    "status" "DatasetRequestStatus" NOT NULL DEFAULT 'submitted',
    "admin_note" TEXT,
    "resubmit_count" INTEGER NOT NULL DEFAULT 0,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "minted_bounty_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dataset_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_request_comments" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "author_user_id" TEXT NOT NULL,
    "author_role" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "internal_only" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_request_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_issues" (
    "id" TEXT NOT NULL,
    "reporter_user_id" TEXT,
    "reporter_label" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "credential_ref" TEXT,
    "client_name" TEXT,
    "tool_name" TEXT,
    "request_id" TEXT,
    "category" "AgentIssueCategory" NOT NULL,
    "impact" "AgentIssueImpact" NOT NULL,
    "severity" "AgentIssueSeverity",
    "status" "AgentIssueStatus" NOT NULL DEFAULT 'received',
    "summary" TEXT NOT NULL,
    "expected" TEXT NOT NULL,
    "actual" TEXT NOT NULL,
    "steps" TEXT,
    "log_excerpt" TEXT,
    "context" JSONB,
    "context_collection" TEXT NOT NULL DEFAULT 'complete',
    "redaction_applied" BOOLEAN NOT NULL DEFAULT false,
    "fingerprint" TEXT NOT NULL,
    "canonical_issue_id" TEXT,
    "assigned_to_user_id" TEXT,
    "resolution_note" TEXT,
    "resolution_ref" TEXT,
    "resolved_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_issue_events" (
    "id" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_role" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT,
    "internal_only" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_issue_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "karma_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_type" "KarmaEventType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "karma_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_karma_awards" (
    "id" TEXT NOT NULL,
    "bounty_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_type" "KarmaEventType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),
    "reversed_at" TIMESTAMP(3),
    "reversed_reason" TEXT,

    CONSTRAINT "pending_karma_awards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badges" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "family" "BadgeFamily" NOT NULL,
    "label" TEXT NOT NULL,
    "criteria" TEXT NOT NULL,
    "icon" "BadgeIcon" NOT NULL,
    "metric" "BadgeMetric" NOT NULL,
    "threshold" INTEGER NOT NULL DEFAULT 1,
    "min_sample" INTEGER NOT NULL DEFAULT 0,
    "auto_granted" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_badges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "badge_id" TEXT NOT NULL,
    "earned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by_user_id" TEXT,
    "measured_value" INTEGER,

    CONSTRAINT "user_badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bounty_plans" (
    "id" TEXT NOT NULL,
    "bounty_id" TEXT NOT NULL,
    "plan_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bounty_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planner_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "answers_json" JSONB NOT NULL,
    "transcript" JSONB NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "created_bounty" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planner_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bounty_slots" (
    "id" TEXT NOT NULL,
    "bounty_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "item_count" INTEGER NOT NULL,
    "filled" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bounty_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bounty_batch_plans" (
    "id" TEXT NOT NULL,
    "bounty_id" TEXT NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "item_target" INTEGER NOT NULL,
    "shard_items" INTEGER NOT NULL,
    "open_batch_window" INTEGER NOT NULL,
    "total_batch_count" INTEGER NOT NULL,
    "materialized_batch_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bounty_batch_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bounty_work_shards" (
    "id" TEXT NOT NULL,
    "batch_plan_id" TEXT NOT NULL,
    "slot_id" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "batch_ordinal_start" INTEGER NOT NULL,
    "item_count" INTEGER NOT NULL,
    "batch_count" INTEGER NOT NULL,
    "materialized_batch_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bounty_work_shards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contributor_batches" (
    "id" TEXT NOT NULL,
    "bounty_id" TEXT NOT NULL,
    "slot_id" TEXT,
    "batch_plan_id" TEXT,
    "work_shard_id" TEXT,
    "ordinal_in_shard" INTEGER,
    "contributor_user_id" TEXT,
    "slot_name" TEXT NOT NULL,
    "category" "DatasetCategory" NOT NULL,
    "difficulty" TEXT NOT NULL,
    "item_count" BIGINT NOT NULL,
    "submitted_count" INTEGER NOT NULL DEFAULT 0,
    "status" "ContributorBatchStatus" NOT NULL DEFAULT 'available',
    "deadline" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contributor_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" TEXT NOT NULL,
    "bounty_id" TEXT NOT NULL,
    "slot_id" TEXT,
    "contributor_batch_id" TEXT,
    "contributor_user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "generation_method" "GenerationMethod" NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'submitted',
    "duplicate_score" DOUBLE PRECISION,
    "duplicate_method" TEXT,
    "duplicate_of_submission_id" TEXT,
    "duplicate_decision" TEXT,
    "contamination_score" DOUBLE PRECISION,
    "llm_score" DOUBLE PRECISION,
    "revision_count" INTEGER NOT NULL DEFAULT 0,
    "validation_attempt" INTEGER NOT NULL DEFAULT 0,
    "accepted_at" TIMESTAMP(3),
    "pending_human_review" BOOLEAN NOT NULL DEFAULT false,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_lsh_bands" (
    "id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "band_index" INTEGER NOT NULL,
    "band_hash" TEXT NOT NULL,

    CONSTRAINT "submission_lsh_bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_revisions" (
    "id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "generation_method" "GenerationMethod" NOT NULL,
    "status" "SubmissionStatus" NOT NULL,
    "duplicate_score" DOUBLE PRECISION,
    "contamination_score" DOUBLE PRECISION,
    "llm_score" DOUBLE PRECISION,
    "validation_evidence" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validation_results" (
    "id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "validation_attempt" INTEGER NOT NULL DEFAULT 0,
    "stage" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "score" DOUBLE PRECISION,
    "detail_json" JSONB,
    "provider" TEXT,
    "outcome" TEXT,
    "duration_ms" INTEGER,
    "isolation_verified" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validation_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flags" (
    "id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "validator_user_id" TEXT,
    "reason" "FlagReason" NOT NULL,
    "details" TEXT,
    "status" "FlagStatus" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" TEXT NOT NULL,
    "bounty_id" TEXT,
    "submission_id" TEXT,
    "raised_by_user_id" TEXT,
    "bounty_title" TEXT NOT NULL,
    "submission_title" TEXT NOT NULL,
    "flag_reason" "FlagReason" NOT NULL,
    "contributor_argument" TEXT NOT NULL,
    "validator_argument" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolution_decision" TEXT,
    "resolved_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranks" (
    "user_id" TEXT NOT NULL,
    "contributor_rank" TEXT,
    "validator_rank" TEXT,
    "accepted_items" INTEGER NOT NULL DEFAULT 0,
    "audits_completed" INTEGER NOT NULL DEFAULT 0,
    "contributor_missed_deadlines" INTEGER NOT NULL DEFAULT 0,
    "contributor_abandons" INTEGER NOT NULL DEFAULT 0,
    "contributor_consecutive_clean_deliveries" INTEGER NOT NULL DEFAULT 0,
    "validator_missed_deadlines" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ranks_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'pending',
    "event_key" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "link_bounty_id" TEXT,
    "data" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "notification_id" TEXT NOT NULL,
    "channel" "ChannelKind" NOT NULL,
    "address" TEXT NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_queue" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "workspace_id" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "job_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" TEXT NOT NULL,
    "kind" "ArtifactKind" NOT NULL,
    "visibility" "ArtifactVisibility" NOT NULL DEFAULT 'private',
    "status" "ArtifactStatus" NOT NULL DEFAULT 'pending_upload',
    "scan_status" "ArtifactScanStatus" NOT NULL DEFAULT 'not_required',
    "sponsor_review_status" "SponsorExampleReviewStatus",
    "sponsor_review_note" TEXT,
    "sponsor_reviewed_at" TIMESTAMP(3),
    "sponsor_reviewed_by" TEXT,
    "workspace_id" TEXT,
    "owner_user_id" TEXT,
    "bounty_id" TEXT,
    "planner_session_id" TEXT,
    "dataset_request_id" TEXT,
    "submission_id" TEXT,
    "contributor_batch_id" TEXT,
    "validation_result_id" TEXT,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "declared_size_bytes" BIGINT,
    "size_bytes" BIGINT,
    "checksum_sha256" TEXT,
    "storage_driver" TEXT NOT NULL DEFAULT 'local',
    "storage_bucket" TEXT,
    "storage_key" TEXT NOT NULL,
    "upload_expires_at" TIMESTAMP(3),
    "multipart_upload_id" TEXT,
    "version_of_artifact_id" TEXT,
    "bulk_parse_status" "BulkParseStatus" NOT NULL DEFAULT 'not_applicable',
    "bulk_parse_cursor" INTEGER NOT NULL DEFAULT 0,
    "bulk_parse_row_count" INTEGER,
    "bulk_parse_created" INTEGER NOT NULL DEFAULT 0,
    "bulk_parse_skipped_rows" INTEGER NOT NULL DEFAULT 0,
    "bulk_parse_error" TEXT,
    "modality" "ArtifactModality",
    "detected_mime_type" TEXT,
    "parser_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "purged_at" TIMESTAMP(3),

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_upload_drafts" (
    "id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "target_kind" TEXT NOT NULL,
    "bounty_id" TEXT,
    "contributor_batch_id" TEXT,
    "generation_method" "GenerationMethod" NOT NULL,
    "expected_item_count" INTEGER,
    "source_description" TEXT,
    "auto_submit_authorized_at" TIMESTAMP(3),
    "token_hash" TEXT NOT NULL,
    "access_token_hash" TEXT,
    "token_expires_at" TIMESTAMP(3) NOT NULL,
    "draft_expires_at" TIMESTAMP(3) NOT NULL,
    "redeemed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "source_artifact_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'awaiting_upload',
    "preview_summary" JSONB,
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "submission_upload_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_upload_draft_items" (
    "id" TEXT NOT NULL,
    "draft_id" TEXT NOT NULL,
    "row_number" INTEGER NOT NULL,
    "payload" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_upload_draft_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifact_processing_events" (
    "id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "handler_version" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_processing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benchmark_corpora" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benchmark_corpora_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benchmark_items" (
    "id" TEXT NOT NULL,
    "corpus_id" TEXT NOT NULL,
    "canonical_hash" TEXT NOT NULL,
    "shingles" TEXT[],
    "label" TEXT,

    CONSTRAINT "benchmark_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benchmarks" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "BenchmarkStatus" NOT NULL DEFAULT 'draft',
    "supported_domains" "DomainId"[],
    "supported_languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "benchmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benchmark_versions" (
    "id" TEXT NOT NULL,
    "benchmark_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "BenchmarkVersionStatus" NOT NULL DEFAULT 'draft',
    "contract" JSONB NOT NULL,
    "source_manifest" JSONB NOT NULL,
    "source_manifest_sha256" TEXT NOT NULL,
    "public_manifest_artifact_id" TEXT,
    "private_manifest_artifact_id" TEXT,
    "private_manifest_sha256" TEXT,
    "task_count" INTEGER NOT NULL DEFAULT 0,
    "public_task_count" INTEGER NOT NULL DEFAULT 0,
    "private_task_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" TEXT NOT NULL,
    "approved_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "frozen_at" TIMESTAMP(3),
    "validated_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure_evidence" JSONB,

    CONSTRAINT "benchmark_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benchmark_tasks" (
    "id" TEXT NOT NULL,
    "benchmark_version_id" TEXT NOT NULL,
    "source_submission_id" TEXT NOT NULL,
    "source_submission_revision_id" TEXT NOT NULL,
    "split" "BenchmarkTaskSplit" NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "task_key" TEXT NOT NULL,
    "source_payload_sha256" TEXT NOT NULL,
    "public_metadata" JSONB,
    "private_evidence" JSONB,
    "provenance_evidence" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benchmark_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benchmark_runs" (
    "id" TEXT NOT NULL,
    "benchmark_version_id" TEXT NOT NULL,
    "status" "BenchmarkRunStatus" NOT NULL DEFAULT 'pending',
    "idempotency_key" TEXT NOT NULL,
    "model_provider" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "model_version" TEXT,
    "model_config" JSONB NOT NULL,
    "evaluator_image" TEXT NOT NULL,
    "scoring_profile" JSONB NOT NULL,
    "requested_by_user_id" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "score" DOUBLE PRECISION,
    "passed_task_count" INTEGER NOT NULL DEFAULT 0,
    "evaluated_task_count" INTEGER NOT NULL DEFAULT 0,
    "evidence" JSONB,
    "failure_evidence" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "benchmark_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benchmark_run_task_results" (
    "id" TEXT NOT NULL,
    "benchmark_run_id" TEXT NOT NULL,
    "benchmark_task_id" TEXT NOT NULL,
    "status" "BenchmarkTaskResultStatus" NOT NULL DEFAULT 'pending',
    "passed" BOOLEAN,
    "score" DOUBLE PRECISION,
    "duration_ms" INTEGER,
    "output_artifact_id" TEXT,
    "evidence" JSONB NOT NULL,
    "error_summary" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benchmark_run_task_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_signups" (
    "id" TEXT NOT NULL,
    "domain" "DomainId" NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "waitlist_signups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "name" TEXT NOT NULL,
    "last_run_at" TIMESTAMP(3) NOT NULL,
    "last_error" TEXT,
    "interval_ms" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "system_alerts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "severity" "SystemAlertSeverity" NOT NULL,
    "status" "SystemAlertStatus" NOT NULL DEFAULT 'active',
    "context" JSONB NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "system_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operational_alert_destinations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "ChannelKind" NOT NULL,
    "address_ciphertext" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "minimum_severity" "SystemAlertSeverity" NOT NULL DEFAULT 'warning',
    "last_error" TEXT,
    "last_success_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operational_alert_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operational_alert_routes" (
    "id" TEXT NOT NULL,
    "destination_id" TEXT NOT NULL,
    "alert_code" TEXT NOT NULL DEFAULT '*',
    "minimum_severity" "SystemAlertSeverity" NOT NULL DEFAULT 'warning',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operational_alert_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operational_alert_deliveries" (
    "id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "destination_id" TEXT NOT NULL,
    "transition_key" TEXT NOT NULL,
    "status" "OperationalAlertDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operational_alert_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_metrics_snapshots" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_metrics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_batches" (
    "id" TEXT NOT NULL,
    "bounty_id" TEXT NOT NULL,
    "validator_user_id" TEXT,
    "item_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "deadline" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_items" (
    "id" TEXT NOT NULL,
    "audit_batch_id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "verdict" "AuditVerdict",
    "flag_reason" "FlagReason",
    "note" TEXT,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "audit_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_handle_key" ON "users"("handle");

-- CreateIndex
CREATE INDEX "users_profile_public_handle_karma_total_idx" ON "users"("profile_public", "handle", "karma_total");

-- CreateIndex
CREATE INDEX "workspaces_owner_id_idx" ON "workspaces"("owner_id");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_invites_token_hash_key" ON "admin_invites"("token_hash");

-- CreateIndex
CREATE INDEX "admin_invites_email_idx" ON "admin_invites"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_nonces_nonce_key" ON "auth_nonces"("nonce");

-- CreateIndex
CREATE INDEX "auth_nonces_expires_at_idx" ON "auth_nonces"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "oauth_clients"("client_id");

-- CreateIndex
CREATE INDEX "oauth_clients_owner_user_id_idx" ON "oauth_clients"("owner_user_id");

-- CreateIndex
CREATE INDEX "oauth_authorization_requests_client_id_expires_at_idx" ON "oauth_authorization_requests"("client_id", "expires_at");

-- CreateIndex
CREATE INDEX "oauth_authorization_requests_user_id_expires_at_idx" ON "oauth_authorization_requests"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorization_codes_code_hash_key" ON "oauth_authorization_codes"("code_hash");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_client_id_expires_at_idx" ON "oauth_authorization_codes"("client_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_access_tokens_token_hash_key" ON "oauth_access_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "oauth_access_tokens_user_id_revoked_at_idx" ON "oauth_access_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "oauth_access_tokens_client_id_expires_at_idx" ON "oauth_access_tokens"("client_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_refresh_tokens_token_hash_key" ON "oauth_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "oauth_refresh_tokens_user_id_revoked_at_idx" ON "oauth_refresh_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "oauth_refresh_tokens_client_id_expires_at_idx" ON "oauth_refresh_tokens"("client_id", "expires_at");

-- CreateIndex
CREATE INDEX "oauth_audit_events_client_id_created_at_idx" ON "oauth_audit_events"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "oauth_audit_events_user_id_created_at_idx" ON "oauth_audit_events"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens"("user_id");

-- CreateIndex
CREATE INDEX "admin_settings_history_key_created_at_idx" ON "admin_settings_history"("key", "created_at");

-- CreateIndex
CREATE INDEX "admin_settings_history_changed_by_idx" ON "admin_settings_history"("changed_by");

-- CreateIndex
CREATE INDEX "llm_audit_log_created_at_idx" ON "llm_audit_log"("created_at");

-- CreateIndex
CREATE INDEX "llm_audit_log_user_id_created_at_idx" ON "llm_audit_log"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "llm_audit_log_feature_created_at_idx" ON "llm_audit_log"("feature", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "llm_quota_reservations_idempotency_key_key" ON "llm_quota_reservations"("idempotency_key");

-- CreateIndex
CREATE INDEX "llm_quota_reservations_created_at_status_idx" ON "llm_quota_reservations"("created_at", "status");

-- CreateIndex
CREATE INDEX "llm_quota_reservations_expires_at_idx" ON "llm_quota_reservations"("expires_at");

-- CreateIndex
CREATE INDEX "llm_quota_reservations_user_id_created_at_status_idx" ON "llm_quota_reservations"("user_id", "created_at", "status");

-- CreateIndex
CREATE INDEX "llm_quota_reservations_quota_day_shard_status_idx" ON "llm_quota_reservations"("quota_day", "quota_shard", "status");

-- CreateIndex
CREATE INDEX "llm_cache_expires_at_idx" ON "llm_cache"("expires_at");

-- CreateIndex
CREATE INDEX "llm_routing_overrides_account_id_idx" ON "llm_routing_overrides"("account_id");

-- CreateIndex
CREATE INDEX "llm_routing_overrides_eval_id_idx" ON "llm_routing_overrides"("eval_id");

-- CreateIndex
CREATE UNIQUE INDEX "llm_routing_overrides_feature_account_id_key" ON "llm_routing_overrides"("feature", "account_id");

-- CreateIndex
CREATE INDEX "llm_change_evaluations_feature_status_idx" ON "llm_change_evaluations"("feature", "status");

-- CreateIndex
CREATE INDEX "llm_change_evaluations_account_id_idx" ON "llm_change_evaluations"("account_id");

-- CreateIndex
CREATE INDEX "llm_change_evaluations_config_hash_idx" ON "llm_change_evaluations"("config_hash");

-- CreateIndex
CREATE UNIQUE INDEX "notification_channels_user_id_channel_key" ON "notification_channels"("user_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "notification_oauth_states_state_hash_key" ON "notification_oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "notification_oauth_states_provider_expires_at_idx" ON "notification_oauth_states"("provider", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_links_user_id_key" ON "telegram_links"("user_id");

-- CreateIndex
CREATE INDEX "profile_sources_verified_next_check_at_idx" ON "profile_sources"("verified", "next_check_at");

-- CreateIndex
CREATE UNIQUE INDEX "profile_sources_user_id_source_key" ON "profile_sources"("user_id", "source");

-- CreateIndex
CREATE UNIQUE INDEX "profile_source_verifications_idempotency_key_key" ON "profile_source_verifications"("idempotency_key");

-- CreateIndex
CREATE INDEX "profile_source_verifications_profile_source_id_started_at_idx" ON "profile_source_verifications"("profile_source_id", "started_at");

-- CreateIndex
CREATE INDEX "profile_source_verifications_status_started_at_idx" ON "profile_source_verifications"("status", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "slack_workspace_connections_user_id_key" ON "slack_workspace_connections"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sponsor_scopes_user_id_key" ON "sponsor_scopes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- CreateIndex
CREATE INDEX "api_key_rate_buckets_window_start_idx" ON "api_key_rate_buckets"("window_start");

-- CreateIndex
CREATE INDEX "admin_audit_log_actor_user_id_idx" ON "admin_audit_log"("actor_user_id");

-- CreateIndex
CREATE INDEX "admin_audit_log_target_type_target_id_idx" ON "admin_audit_log"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "admin_audit_log_action_created_at_idx" ON "admin_audit_log"("action", "created_at");

-- CreateIndex
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_types_supersedes_id_key" ON "dataset_types"("supersedes_id");

-- CreateIndex
CREATE INDEX "dataset_types_family_id_status_idx" ON "dataset_types"("family_id", "status");

-- CreateIndex
CREATE INDEX "dataset_types_status_domain_origin_trust_tier_updated_at_idx" ON "dataset_types"("status", "domain", "origin", "trust_tier", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_types_family_id_version_key" ON "dataset_types"("family_id", "version");

-- CreateIndex
CREATE INDEX "dataset_type_harnesses_dataset_type_id_status_idx" ON "dataset_type_harnesses"("dataset_type_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_type_harnesses_dataset_type_id_version_key" ON "dataset_type_harnesses"("dataset_type_id", "version");

-- CreateIndex
CREATE INDEX "waitlist_entries_domain_idx" ON "waitlist_entries"("domain");

-- CreateIndex
CREATE INDEX "bounties_requester_user_id_idx" ON "bounties"("requester_user_id");

-- CreateIndex
CREATE INDEX "bounties_status_idx" ON "bounties"("status");

-- CreateIndex
CREATE INDEX "bounties_requester_user_id_status_created_at_idx" ON "bounties"("requester_user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "bounties_visibility_idx" ON "bounties"("visibility");

-- CreateIndex
CREATE INDEX "bounties_kind_visibility_status_created_at_idx" ON "bounties"("kind", "visibility", "status", "created_at");

-- CreateIndex
CREATE INDEX "bounties_kind_community_validation_mode_status_idx" ON "bounties"("kind", "community_validation_mode", "status");

-- CreateIndex
CREATE INDEX "dataset_publications_status_idx" ON "dataset_publications"("status");

-- CreateIndex
CREATE INDEX "dataset_publications_target_status_idx" ON "dataset_publications"("target", "status");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_publications_bounty_id_target_key" ON "dataset_publications"("bounty_id", "target");

-- CreateIndex
CREATE UNIQUE INDEX "human_audit_windows_audit_batch_id_key" ON "human_audit_windows"("audit_batch_id");

-- CreateIndex
CREATE INDEX "human_audit_windows_bounty_id_closed_at_idx" ON "human_audit_windows"("bounty_id", "closed_at");

-- CreateIndex
CREATE INDEX "human_audit_windows_bounty_id_superseded_at_idx" ON "human_audit_windows"("bounty_id", "superseded_at");

-- CreateIndex
CREATE INDEX "human_audit_windows_bounty_id_settled_at_idx" ON "human_audit_windows"("bounty_id", "settled_at");

-- CreateIndex
CREATE INDEX "human_audit_windows_claim_expires_at_idx" ON "human_audit_windows"("claim_expires_at");

-- CreateIndex
CREATE INDEX "human_audit_windows_claimed_by_user_id_settled_at_idx" ON "human_audit_windows"("claimed_by_user_id", "settled_at");

-- CreateIndex
CREATE UNIQUE INDEX "human_audit_windows_bounty_id_window_index_key" ON "human_audit_windows"("bounty_id", "window_index");

-- CreateIndex
CREATE INDEX "human_audit_window_memberships_submission_id_idx" ON "human_audit_window_memberships"("submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "human_audit_window_memberships_window_id_submission_id_key" ON "human_audit_window_memberships"("window_id", "submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "human_audit_window_memberships_window_id_rank_key" ON "human_audit_window_memberships"("window_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_requests_minted_bounty_id_key" ON "dataset_requests"("minted_bounty_id");

-- CreateIndex
CREATE INDEX "dataset_requests_status_created_at_idx" ON "dataset_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "dataset_requests_requester_user_id_created_at_idx" ON "dataset_requests"("requester_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_requests_requester_user_id_idempotency_key_key" ON "dataset_requests"("requester_user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "dataset_request_comments_request_id_created_at_idx" ON "dataset_request_comments"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_issues_status_created_at_idx" ON "agent_issues"("status", "created_at");

-- CreateIndex
CREATE INDEX "agent_issues_reporter_user_id_created_at_idx" ON "agent_issues"("reporter_user_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_issues_fingerprint_created_at_idx" ON "agent_issues"("fingerprint", "created_at");

-- CreateIndex
CREATE INDEX "agent_issues_canonical_issue_id_idx" ON "agent_issues"("canonical_issue_id");

-- CreateIndex
CREATE INDEX "agent_issues_assigned_to_user_id_status_idx" ON "agent_issues"("assigned_to_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_issues_reporter_user_id_idempotency_key_key" ON "agent_issues"("reporter_user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "agent_issue_events_issue_id_created_at_idx" ON "agent_issue_events"("issue_id", "created_at");

-- CreateIndex
CREATE INDEX "karma_events_user_id_created_at_idx" ON "karma_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "karma_events_source_type_source_id_idx" ON "karma_events"("source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "karma_events_user_id_event_type_source_type_source_id_key" ON "karma_events"("user_id", "event_type", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "pending_karma_awards_bounty_id_released_at_idx" ON "pending_karma_awards"("bounty_id", "released_at");

-- CreateIndex
CREATE UNIQUE INDEX "pending_karma_awards_user_id_event_type_source_type_source__key" ON "pending_karma_awards"("user_id", "event_type", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "badges_key_key" ON "badges"("key");

-- CreateIndex
CREATE INDEX "badges_active_family_sort_order_idx" ON "badges"("active", "family", "sort_order");

-- CreateIndex
CREATE INDEX "user_badges_badge_id_idx" ON "user_badges"("badge_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_badges_user_id_badge_id_key" ON "user_badges"("user_id", "badge_id");

-- CreateIndex
CREATE UNIQUE INDEX "bounty_plans_bounty_id_key" ON "bounty_plans"("bounty_id");

-- CreateIndex
CREATE INDEX "planner_sessions_user_id_idx" ON "planner_sessions"("user_id");

-- CreateIndex
CREATE INDEX "bounty_slots_bounty_id_idx" ON "bounty_slots"("bounty_id");

-- CreateIndex
CREATE UNIQUE INDEX "bounty_batch_plans_bounty_id_key" ON "bounty_batch_plans"("bounty_id");

-- CreateIndex
CREATE INDEX "bounty_batch_plans_materialized_batch_count_idx" ON "bounty_batch_plans"("materialized_batch_count");

-- CreateIndex
CREATE INDEX "bounty_work_shards_batch_plan_id_materialized_batch_count_idx" ON "bounty_work_shards"("batch_plan_id", "materialized_batch_count");

-- CreateIndex
CREATE UNIQUE INDEX "bounty_work_shards_batch_plan_id_ordinal_key" ON "bounty_work_shards"("batch_plan_id", "ordinal");

-- CreateIndex
CREATE INDEX "creator_batches_bounty_id_idx" ON "contributor_batches"("bounty_id");

-- CreateIndex
CREATE INDEX "creator_batches_status_idx" ON "contributor_batches"("status");

-- CreateIndex
CREATE INDEX "creator_batches_creator_user_id_idx" ON "contributor_batches"("contributor_user_id");

-- CreateIndex
CREATE INDEX "creator_batches_creator_user_id_status_idx" ON "contributor_batches"("contributor_user_id", "status");

-- CreateIndex
CREATE INDEX "creator_batches_creator_user_id_status_claimed_at_idx" ON "contributor_batches"("contributor_user_id", "status", "claimed_at");

-- CreateIndex
CREATE INDEX "contributor_batches_status_deadline_idx" ON "contributor_batches"("status", "deadline");

-- CreateIndex
CREATE INDEX "creator_batches_batch_plan_id_status_idx" ON "contributor_batches"("batch_plan_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "creator_batches_work_shard_id_ordinal_in_shard_key" ON "contributor_batches"("work_shard_id", "ordinal_in_shard");

-- CreateIndex
CREATE INDEX "submissions_bounty_id_idx" ON "submissions"("bounty_id");

-- CreateIndex
CREATE INDEX "submissions_creator_user_id_idx" ON "submissions"("contributor_user_id");

-- CreateIndex
CREATE INDEX "submissions_status_idx" ON "submissions"("status");

-- CreateIndex
CREATE INDEX "submissions_creator_user_id_status_idx" ON "submissions"("contributor_user_id", "status");

-- CreateIndex
CREATE INDEX "submissions_creator_user_id_creator_batch_id_created_at_idx" ON "submissions"("contributor_user_id", "contributor_batch_id", "created_at");

-- CreateIndex
CREATE INDEX "submissions_creator_batch_id_idx" ON "submissions"("contributor_batch_id");

-- CreateIndex
CREATE INDEX "submissions_bounty_id_dedupe_key_idx" ON "submissions"("bounty_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "submissions_bounty_id_created_at_idx" ON "submissions"("bounty_id", "created_at");

-- CreateIndex
CREATE INDEX "submissions_created_at_idx" ON "submissions"("created_at");

-- CreateIndex
CREATE INDEX "submissions_bounty_id_status_idx" ON "submissions"("bounty_id", "status");

-- CreateIndex
CREATE INDEX "submission_lsh_bands_band_index_band_hash_idx" ON "submission_lsh_bands"("band_index", "band_hash");

-- CreateIndex
CREATE UNIQUE INDEX "submission_lsh_bands_submission_id_band_index_key" ON "submission_lsh_bands"("submission_id", "band_index");

-- CreateIndex
CREATE INDEX "submission_revisions_submission_id_created_at_idx" ON "submission_revisions"("submission_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "submission_revisions_submission_id_revision_number_key" ON "submission_revisions"("submission_id", "revision_number");

-- CreateIndex
CREATE INDEX "validation_results_submission_id_validation_attempt_created_idx" ON "validation_results"("submission_id", "validation_attempt", "created_at");

-- CreateIndex
CREATE INDEX "validation_results_stage_passed_idx" ON "validation_results"("stage", "passed");

-- CreateIndex
CREATE INDEX "validation_results_stage_created_at_idx" ON "validation_results"("stage", "created_at");

-- CreateIndex
CREATE INDEX "flags_submission_id_idx" ON "flags"("submission_id");

-- CreateIndex
CREATE INDEX "flags_validator_user_id_status_idx" ON "flags"("validator_user_id", "status");

-- CreateIndex
CREATE INDEX "disputes_status_idx" ON "disputes"("status");

-- CreateIndex
CREATE INDEX "disputes_resolved_by_user_id_idx" ON "disputes"("resolved_by_user_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_created_at_idx" ON "notifications"("user_id", "read", "created_at");

-- CreateIndex
CREATE INDEX "notifications_status_created_at_idx" ON "notifications"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_event_key_key" ON "notifications"("user_id", "event_key");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_next_attempt_at_idx" ON "notification_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_notification_id_channel_key" ON "notification_deliveries"("notification_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "job_queue_idempotency_key_key" ON "job_queue"("idempotency_key");

-- CreateIndex
CREATE INDEX "job_queue_type_status_next_attempt_at_idx" ON "job_queue"("type", "status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "job_queue_status_next_attempt_at_idx" ON "job_queue"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "job_queue_type_workspace_id_created_at_idx" ON "job_queue"("type", "workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "job_queue_type_finished_at_idx" ON "job_queue"("type", "finished_at");

-- CreateIndex
CREATE INDEX "artifacts_bounty_id_kind_idx" ON "artifacts"("bounty_id", "kind");

-- CreateIndex
CREATE INDEX "artifacts_planner_session_id_kind_idx" ON "artifacts"("planner_session_id", "kind");

-- CreateIndex
CREATE INDEX "artifacts_dataset_request_id_kind_idx" ON "artifacts"("dataset_request_id", "kind");

-- CreateIndex
CREATE INDEX "artifacts_submission_id_idx" ON "artifacts"("submission_id");

-- CreateIndex
CREATE INDEX "artifacts_owner_user_id_idx" ON "artifacts"("owner_user_id");

-- CreateIndex
CREATE INDEX "artifacts_status_idx" ON "artifacts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "submission_upload_drafts_token_hash_key" ON "submission_upload_drafts"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "submission_upload_drafts_access_token_hash_key" ON "submission_upload_drafts"("access_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "submission_upload_drafts_source_artifact_id_key" ON "submission_upload_drafts"("source_artifact_id");

-- CreateIndex
CREATE INDEX "submission_upload_drafts_owner_user_id_status_idx" ON "submission_upload_drafts"("owner_user_id", "status");

-- CreateIndex
CREATE INDEX "submission_upload_drafts_token_expires_at_idx" ON "submission_upload_drafts"("token_expires_at");

-- CreateIndex
CREATE INDEX "submission_upload_drafts_draft_expires_at_idx" ON "submission_upload_drafts"("draft_expires_at");

-- CreateIndex
CREATE INDEX "submission_upload_drafts_bounty_id_idx" ON "submission_upload_drafts"("bounty_id");

-- CreateIndex
CREATE INDEX "submission_upload_drafts_creator_batch_id_idx" ON "submission_upload_drafts"("contributor_batch_id");

-- CreateIndex
CREATE INDEX "submission_upload_draft_items_draft_id_error_code_idx" ON "submission_upload_draft_items"("draft_id", "error_code");

-- CreateIndex
CREATE UNIQUE INDEX "submission_upload_draft_items_draft_id_row_number_key" ON "submission_upload_draft_items"("draft_id", "row_number");

-- CreateIndex
CREATE INDEX "artifact_processing_events_artifact_id_idx" ON "artifact_processing_events"("artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_corpora_name_version_key" ON "benchmark_corpora"("name", "version");

-- CreateIndex
CREATE INDEX "benchmark_items_corpus_id_idx" ON "benchmark_items"("corpus_id");

-- CreateIndex
CREATE INDEX "benchmark_items_canonical_hash_idx" ON "benchmark_items"("canonical_hash");

-- CreateIndex
CREATE UNIQUE INDEX "benchmarks_slug_key" ON "benchmarks"("slug");

-- CreateIndex
CREATE INDEX "benchmarks_status_created_at_idx" ON "benchmarks"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_versions_public_manifest_artifact_id_key" ON "benchmark_versions"("public_manifest_artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_versions_private_manifest_artifact_id_key" ON "benchmark_versions"("private_manifest_artifact_id");

-- CreateIndex
CREATE INDEX "benchmark_versions_benchmark_id_status_version_idx" ON "benchmark_versions"("benchmark_id", "status", "version");

-- CreateIndex
CREATE INDEX "benchmark_versions_status_created_at_idx" ON "benchmark_versions"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_versions_benchmark_id_version_key" ON "benchmark_versions"("benchmark_id", "version");

-- CreateIndex
CREATE INDEX "benchmark_tasks_benchmark_version_id_split_ordinal_idx" ON "benchmark_tasks"("benchmark_version_id", "split", "ordinal");

-- CreateIndex
CREATE INDEX "benchmark_tasks_source_submission_id_idx" ON "benchmark_tasks"("source_submission_id");

-- CreateIndex
CREATE INDEX "benchmark_tasks_source_submission_revision_id_idx" ON "benchmark_tasks"("source_submission_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_tasks_benchmark_version_id_task_key_key" ON "benchmark_tasks"("benchmark_version_id", "task_key");

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_tasks_benchmark_version_id_ordinal_key" ON "benchmark_tasks"("benchmark_version_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_runs_idempotency_key_key" ON "benchmark_runs"("idempotency_key");

-- CreateIndex
CREATE INDEX "benchmark_runs_benchmark_version_id_status_created_at_idx" ON "benchmark_runs"("benchmark_version_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "benchmark_runs_status_created_at_idx" ON "benchmark_runs"("status", "created_at");

-- CreateIndex
CREATE INDEX "benchmark_runs_model_provider_model_name_created_at_idx" ON "benchmark_runs"("model_provider", "model_name", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_run_task_results_output_artifact_id_key" ON "benchmark_run_task_results"("output_artifact_id");

-- CreateIndex
CREATE INDEX "benchmark_run_task_results_benchmark_task_id_idx" ON "benchmark_run_task_results"("benchmark_task_id");

-- CreateIndex
CREATE INDEX "benchmark_run_task_results_status_created_at_idx" ON "benchmark_run_task_results"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "benchmark_run_task_results_benchmark_run_id_benchmark_task__key" ON "benchmark_run_task_results"("benchmark_run_id", "benchmark_task_id");

-- CreateIndex
CREATE INDEX "waitlist_signups_domain_idx" ON "waitlist_signups"("domain");

-- CreateIndex
CREATE INDEX "waitlist_signups_domain_notified_at_idx" ON "waitlist_signups"("domain", "notified_at");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_signups_domain_email_key" ON "waitlist_signups"("domain", "email");

-- CreateIndex
CREATE UNIQUE INDEX "system_alerts_dedupe_key_key" ON "system_alerts"("dedupe_key");

-- CreateIndex
CREATE INDEX "system_alerts_status_last_seen_at_idx" ON "system_alerts"("status", "last_seen_at");

-- CreateIndex
CREATE INDEX "operational_alert_destinations_enabled_minimum_severity_idx" ON "operational_alert_destinations"("enabled", "minimum_severity");

-- CreateIndex
CREATE INDEX "operational_alert_routes_alert_code_enabled_idx" ON "operational_alert_routes"("alert_code", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "operational_alert_routes_destination_id_alert_code_key" ON "operational_alert_routes"("destination_id", "alert_code");

-- CreateIndex
CREATE INDEX "operational_alert_deliveries_status_next_attempt_at_idx" ON "operational_alert_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "operational_alert_deliveries_alert_id_destination_id_transi_key" ON "operational_alert_deliveries"("alert_id", "destination_id", "transition_key");

-- CreateIndex
CREATE INDEX "audit_batches_bounty_id_idx" ON "audit_batches"("bounty_id");

-- CreateIndex
CREATE INDEX "audit_batches_status_validator_user_id_deadline_created_at_idx" ON "audit_batches"("status", "validator_user_id", "deadline", "created_at");

-- CreateIndex
CREATE INDEX "audit_batches_validator_user_id_status_claimed_at_idx" ON "audit_batches"("validator_user_id", "status", "claimed_at");

-- CreateIndex
CREATE INDEX "audit_items_audit_batch_id_idx" ON "audit_items"("audit_batch_id");

-- CreateIndex
CREATE INDEX "audit_items_submission_id_idx" ON "audit_items"("submission_id");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_invites" ADD CONSTRAINT "admin_invites_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_requests" ADD CONSTRAINT "oauth_authorization_requests_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_requests" ADD CONSTRAINT "oauth_authorization_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_audit_events" ADD CONSTRAINT "oauth_audit_events_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_audit_events" ADD CONSTRAINT "oauth_audit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_prefs" ADD CONSTRAINT "watch_prefs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_sources" ADD CONSTRAINT "profile_sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_source_verifications" ADD CONSTRAINT "profile_source_verifications_profile_source_id_fkey" FOREIGN KEY ("profile_source_id") REFERENCES "profile_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsor_scopes" ADD CONSTRAINT "sponsor_scopes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_types" ADD CONSTRAINT "dataset_types_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_types" ADD CONSTRAINT "dataset_types_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "dataset_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_type_harnesses" ADD CONSTRAINT "dataset_type_harnesses_dataset_type_id_fkey" FOREIGN KEY ("dataset_type_id") REFERENCES "dataset_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_type_harnesses" ADD CONSTRAINT "dataset_type_harnesses_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_community_requester_user_id_fkey" FOREIGN KEY ("community_requester_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_dataset_type_id_fkey" FOREIGN KEY ("dataset_type_id") REFERENCES "dataset_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_publications" ADD CONSTRAINT "dataset_publications_bounty_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_publications" ADD CONSTRAINT "dataset_publications_published_by_user_id_fkey" FOREIGN KEY ("published_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_publications" ADD CONSTRAINT "dataset_publications_bundle_artifact_id_fkey" FOREIGN KEY ("bundle_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_audit_windows" ADD CONSTRAINT "human_audit_windows_audit_batch_id_fkey" FOREIGN KEY ("audit_batch_id") REFERENCES "audit_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_audit_windows" ADD CONSTRAINT "human_audit_windows_bounty_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_audit_windows" ADD CONSTRAINT "human_audit_windows_claimed_by_user_id_fkey" FOREIGN KEY ("claimed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_audit_window_memberships" ADD CONSTRAINT "human_audit_window_memberships_window_id_fkey" FOREIGN KEY ("window_id") REFERENCES "human_audit_windows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_audit_window_memberships" ADD CONSTRAINT "human_audit_window_memberships_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_requests" ADD CONSTRAINT "dataset_requests_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_requests" ADD CONSTRAINT "dataset_requests_dataset_type_id_fkey" FOREIGN KEY ("dataset_type_id") REFERENCES "dataset_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_requests" ADD CONSTRAINT "dataset_requests_minted_bounty_id_fkey" FOREIGN KEY ("minted_bounty_id") REFERENCES "bounties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_request_comments" ADD CONSTRAINT "dataset_request_comments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "dataset_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_issues" ADD CONSTRAINT "agent_issues_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_issues" ADD CONSTRAINT "agent_issues_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_issues" ADD CONSTRAINT "agent_issues_canonical_issue_id_fkey" FOREIGN KEY ("canonical_issue_id") REFERENCES "agent_issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_issue_events" ADD CONSTRAINT "agent_issue_events_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "agent_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "karma_events" ADD CONSTRAINT "karma_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_karma_awards" ADD CONSTRAINT "pending_karma_awards_bounty_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_karma_awards" ADD CONSTRAINT "pending_karma_awards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bounty_plans" ADD CONSTRAINT "bounty_plans_bounty_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bounty_slots" ADD CONSTRAINT "bounty_slots_bounty_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bounty_batch_plans" ADD CONSTRAINT "bounty_batch_plans_bounty_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bounty_work_shards" ADD CONSTRAINT "bounty_work_shards_batch_plan_id_fkey" FOREIGN KEY ("batch_plan_id") REFERENCES "bounty_batch_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bounty_work_shards" ADD CONSTRAINT "bounty_work_shards_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "bounty_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contributor_batches" ADD CONSTRAINT "creator_batches_bounty_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contributor_batches" ADD CONSTRAINT "creator_batches_batch_plan_id_fkey" FOREIGN KEY ("batch_plan_id") REFERENCES "bounty_batch_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contributor_batches" ADD CONSTRAINT "creator_batches_work_shard_id_fkey" FOREIGN KEY ("work_shard_id") REFERENCES "bounty_work_shards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contributor_batches" ADD CONSTRAINT "creator_batches_creator_user_id_fkey" FOREIGN KEY ("contributor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_bounty_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_creator_batch_id_fkey" FOREIGN KEY ("contributor_batch_id") REFERENCES "contributor_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_creator_user_id_fkey" FOREIGN KEY ("contributor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_lsh_bands" ADD CONSTRAINT "submission_lsh_bands_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_revisions" ADD CONSTRAINT "submission_revisions_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_results" ADD CONSTRAINT "validation_results_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flags" ADD CONSTRAINT "flags_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_bounty_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_raised_by_user_id_fkey" FOREIGN KEY ("raised_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranks" ADD CONSTRAINT "ranks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_bounty_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_planner_session_id_fkey" FOREIGN KEY ("planner_session_id") REFERENCES "planner_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_dataset_request_id_fkey" FOREIGN KEY ("dataset_request_id") REFERENCES "dataset_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_validation_result_id_fkey" FOREIGN KEY ("validation_result_id") REFERENCES "validation_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_version_of_artifact_id_fkey" FOREIGN KEY ("version_of_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_upload_drafts" ADD CONSTRAINT "submission_upload_drafts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_upload_drafts" ADD CONSTRAINT "submission_upload_drafts_bounty_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_upload_drafts" ADD CONSTRAINT "submission_upload_drafts_creator_batch_id_fkey" FOREIGN KEY ("contributor_batch_id") REFERENCES "contributor_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_upload_drafts" ADD CONSTRAINT "submission_upload_drafts_source_artifact_id_fkey" FOREIGN KEY ("source_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_upload_draft_items" ADD CONSTRAINT "submission_upload_draft_items_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "submission_upload_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_items" ADD CONSTRAINT "benchmark_items_corpus_id_fkey" FOREIGN KEY ("corpus_id") REFERENCES "benchmark_corpora"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmarks" ADD CONSTRAINT "benchmarks_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_versions" ADD CONSTRAINT "benchmark_versions_benchmark_id_fkey" FOREIGN KEY ("benchmark_id") REFERENCES "benchmarks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_versions" ADD CONSTRAINT "benchmark_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_versions" ADD CONSTRAINT "benchmark_versions_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_versions" ADD CONSTRAINT "benchmark_versions_public_manifest_artifact_id_fkey" FOREIGN KEY ("public_manifest_artifact_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_versions" ADD CONSTRAINT "benchmark_versions_private_manifest_artifact_id_fkey" FOREIGN KEY ("private_manifest_artifact_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_tasks" ADD CONSTRAINT "benchmark_tasks_benchmark_version_id_fkey" FOREIGN KEY ("benchmark_version_id") REFERENCES "benchmark_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_tasks" ADD CONSTRAINT "benchmark_tasks_source_submission_id_fkey" FOREIGN KEY ("source_submission_id") REFERENCES "submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_tasks" ADD CONSTRAINT "benchmark_tasks_source_submission_revision_id_fkey" FOREIGN KEY ("source_submission_revision_id") REFERENCES "submission_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_runs" ADD CONSTRAINT "benchmark_runs_benchmark_version_id_fkey" FOREIGN KEY ("benchmark_version_id") REFERENCES "benchmark_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_runs" ADD CONSTRAINT "benchmark_runs_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_run_task_results" ADD CONSTRAINT "benchmark_run_task_results_benchmark_run_id_fkey" FOREIGN KEY ("benchmark_run_id") REFERENCES "benchmark_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_run_task_results" ADD CONSTRAINT "benchmark_run_task_results_benchmark_task_id_fkey" FOREIGN KEY ("benchmark_task_id") REFERENCES "benchmark_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benchmark_run_task_results" ADD CONSTRAINT "benchmark_run_task_results_output_artifact_id_fkey" FOREIGN KEY ("output_artifact_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_alert_routes" ADD CONSTRAINT "operational_alert_routes_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "operational_alert_destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_alert_deliveries" ADD CONSTRAINT "operational_alert_deliveries_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "system_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_alert_deliveries" ADD CONSTRAINT "operational_alert_deliveries_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "operational_alert_destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_batches" ADD CONSTRAINT "audit_batches_bounty_id_fkey" FOREIGN KEY ("bounty_id") REFERENCES "bounties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_batches" ADD CONSTRAINT "audit_batches_validator_user_id_fkey" FOREIGN KEY ("validator_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_items" ADD CONSTRAINT "audit_items_audit_batch_id_fkey" FOREIGN KEY ("audit_batch_id") REFERENCES "audit_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_items" ADD CONSTRAINT "audit_items_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================
-- 2. Partial unique index: race-free duplicate guard
--    (from 20260902090000_add_submission_dedupe_active_unique)
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS "submissions_bounty_batch_dedupe_key_active_unique"
  ON "submissions" ("bounty_id", COALESCE("contributor_batch_id", ''), "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL AND "status" <> 'rejected';

-- ============================================================
-- 3. Integrity constraints restored from V1
--    (from 20260902100000_restore_v1_integrity_constraints)
-- ============================================================
DO $$
DECLARE
  c record;
  added int := 0;
  checks text[][] := ARRAY[
    ARRAY['bounties', 'bounties_community_validation_mode_valid',
          '((community_validation_mode IS NULL) OR (community_validation_mode = ANY (ARRAY[''full_human''::text, ''automation_only''::text])))'],
    ARRAY['bounties', 'bounties_human_audit_failure_threshold_pct_range',
          '((human_audit_failure_threshold_pct IS NULL) OR ((human_audit_failure_threshold_pct >= 1) AND (human_audit_failure_threshold_pct <= 100)))'],
    ARRAY['bounties', 'bounties_human_audit_window_size_nonnegative',
          '((human_audit_window_size IS NULL) OR (human_audit_window_size >= 0))'],
    ARRAY['bounties', 'bounties_required_sponsor_examples_bounds',
          '((required_sponsor_examples >= 0) AND (required_sponsor_examples < target_items))'],
    ARRAY['human_audit_windows', 'human_audit_windows_rejected_selected_count_nonnegative',
          '((rejected_selected_count IS NULL) OR (rejected_selected_count >= 0))'],
    ARRAY['llm_quota_buckets', 'llm_quota_buckets_nonnegative',
          '((limit_micro_usd >= 0) AND (reserved_micro_usd >= 0) AND (settled_micro_usd >= 0))'],
    ARRAY['submission_upload_drafts', 'submission_upload_drafts_target_shape_check',
          '((((target_kind = ''claimed_batch''::text) AND (contributor_batch_id IS NOT NULL) AND (bounty_id IS NOT NULL)) OR ((target_kind = ''community_pool''::text) AND (bounty_id IS NOT NULL) AND (contributor_batch_id IS NULL))))'],
    ARRAY['users', 'users_handle_lowercase_check',
          '((handle IS NULL) OR (handle = lower(handle)))']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(checks, 1) LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint pc
      JOIN pg_namespace n ON n.oid = pc.connamespace
      WHERE n.nspname = 'public' AND pc.conname = checks[i][2]
    ) THEN
      RAISE NOTICE 'constraint % already present, skipping', checks[i][2];
    ELSE
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK %s',
                     checks[i][1], checks[i][2], checks[i][3]);
      added := added + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'restored % CHECK constraint(s)', added;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "disputes_one_open_per_submission"
  ON public.disputes (submission_id)
  WHERE ((submission_id IS NOT NULL) AND (status = 'open'::"DisputeStatus"));

-- ============================================================
-- 4. Seed data: launch badge catalog
--    (from 20260831120000_seed_badge_catalog)
-- ============================================================
INSERT INTO "badges" ("id", "key", "family", "label", "criteria", "icon", "metric", "threshold", "min_sample", "auto_granted", "active", "sort_order", "updated_at") VALUES
  -- build
  ('bdg_shipped',              'shipped_dataset',       'build',    'Shipped dataset',          'Contributed accepted work to a dataset that was published',        'sparkles', 'published_datasets',     1,   0,  true,  true, 5,  CURRENT_TIMESTAMP),
  ('bdg_verified_credentials', 'verified_credentials',  'build',    'Verified credentials',     'Connect and verify at least one external credential',              'check',    'verified_credentials',   1,   0,  true,  true, 10, CURRENT_TIMESTAMP),
  ('bdg_accepted_work',        'accepted_work',         'build',    'Accepted work',            'Have at least one submission accepted',                            'code',     'accepted_items',         1,   0,  true,  true, 20, CURRENT_TIMESTAMP),
  ('bdg_items_50',             'items_50',              'build',    '{value} items accepted',   '50 accepted items across all programs',                            'code',     'accepted_items',         50,  0,  true,  true, 21, CURRENT_TIMESTAMP),
  ('bdg_items_100',            'items_100',             'build',    '{value} items accepted',   '100 accepted items across all programs',                           'code',     'accepted_items',         100, 0,  true,  true, 22, CURRENT_TIMESTAMP),
  ('bdg_items_500',            'items_500',             'build',    '{value} items accepted',   '500 accepted items across all programs',                           'code',     'accepted_items',         500, 0,  true,  true, 23, CURRENT_TIMESTAMP),
  ('bdg_clean_streak',         'clean_delivery_streak', 'build',    'Clean delivery streak',    'Deliver consecutive batches with no flags',                        'shield',   'clean_delivery_streak',  1,   0,  true,  true, 30, CURRENT_TIMESTAMP),
  ('bdg_streak_7',             'clean_streak_7',        'build',    '7 clean deliveries',       '7 consecutive deliveries with no flags',                           'zap',      'clean_delivery_streak',  7,   0,  true,  true, 31, CURRENT_TIMESTAMP),
  ('bdg_streak_21',            'clean_streak_21',       'build',    '21 clean deliveries',      '21 consecutive deliveries with no flags',                          'zap',      'clean_delivery_streak',  21,  0,  true,  true, 32, CURRENT_TIMESTAMP),
  ('bdg_no_abandons',          'no_abandons',           'build',    'No abandonments',          'Accepted work on record with zero abandoned claims',               'clock',    'zero_abandons',          1,   0,  true,  true, 40, CURRENT_TIMESTAMP),
  -- audit
  ('bdg_completed_audits',     'completed_audits',      'audit',    'Completed audits',         'Complete at least one validator audit',                            'eye',      'completed_audits',       1,   0,  true,  true, 10, CURRENT_TIMESTAMP),
  ('bdg_audits_10',            'audits_10',             'audit',    '{value} audits completed', '10 completed audits',                                              'eye',      'completed_audits',       10,  0,  true,  true, 11, CURRENT_TIMESTAMP),
  ('bdg_audits_25',            'audits_25',             'audit',    '{value} audits completed', '25 completed audits',                                              'eye',      'completed_audits',       25,  0,  true,  true, 12, CURRENT_TIMESTAMP),
  ('bdg_audits_100',           'audits_100',            'audit',    '{value} audits completed', '100 completed audits',                                             'eye',      'completed_audits',       100, 0,  true,  true, 13, CURRENT_TIMESTAMP),
  ('bdg_zero_false_flags',     'zero_false_flags',      'audit',    'Zero dismissed flags',     'Decided flags on record with none dismissed by the platform',      'shield',   'zero_dismissed_flags',   1,   0,  true,  true, 20, CURRENT_TIMESTAMP),
  ('bdg_flags_10',             'flags_10',              'audit',    '{value} confirmed flags',  '10 flags confirmed by the platform',                               'flag',     'confirmed_flags',        10,  0,  true,  true, 31, CURRENT_TIMESTAMP),
  ('bdg_flags_50',             'flags_50',              'audit',    '{value} confirmed flags',  '50 flags confirmed by the platform',                               'flag',     'confirmed_flags',        50,  0,  true,  true, 32, CURRENT_TIMESTAMP),
  -- A ratio badge, so it carries a real minimum sample: 25 decided flags before
  -- 95% accuracy means anything. Without it, one confirmed flag is 100%.
  ('bdg_accuracy_95',          'flag_accuracy_95',      'audit',    '95% flag accuracy',        '95% of decided flags confirmed, minimum 25 decided flags',         'shield',   'flag_accuracy_pct',      95,  25, true,  true, 41, CURRENT_TIMESTAMP),
  -- platform
  -- auto_granted = false: nothing is measured, so the evaluator must never
  -- award it. It exists only to be granted from the admin console.
  ('bdg_founding',             'founding_member',       'platform', 'Founding contributor',     'Active before public launch, granted by an administrator',         'award',    'manual',                 1,   0,  false, true, 11, CURRENT_TIMESTAMP),
  -- leaderboard_rank is compared INVERTED (rank <= threshold), and the
  -- evaluator reports no rank at all for a member who is not actually listed.
  ('bdg_top_10',               'leaderboard_top_10',    'platform', 'Top 10 all time',          'Top 10 on the all-time open leaderboard',                          'users',    'leaderboard_rank',       10,  0,  true,  true, 21, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
