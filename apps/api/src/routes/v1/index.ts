// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import { authRoutes } from "./auth.js";
import { meRoutes, watchPrefRoutes } from "./me.js";
import { communityRoutes } from "./community.js";
import { plannerRoutes } from "./planner.js";
import { bountyRoutes } from "./bounties.js";
import { batchRoutes } from "./batches.js";
import { submissionRoutes } from "./submissions.js";
import { auditRoutes } from "./audits.js";
import { artifactRoutes } from "./artifacts.js";
import { uploadReviewDraftRoutes } from "./upload-review-drafts.js";
import { issueRoutes } from "./issues.js";
import { notificationRoutes } from "./notifications.js";
import { adminRoutes } from "./admin.js";
import { adminCommunityRoutes } from "./admin-community.js";
import { adminIssueRoutes } from "./admin-issues.js";
import { adminJobRoutes } from "./admin-jobs.js";
import { adminArtifactRoutes } from "./admin-artifacts.js";
import { adminBadgeRoutes } from "./admin-badges.js";
import { adminDatasetTypeRoutes } from "./admin-dataset-types.js";
import { adminHarnessRoutes } from "./admin-harness.js";
import { adminNotificationOpsRoutes } from "./admin-notifications.js";
import { adminHealthRoutes } from "./admin-health.js";
import { adminExecutionHealthRoutes } from "./admin-execution-health.js";
import { benchmarkRoutes } from "./benchmarks.js";
import { adminBenchmarkRoutes } from "./admin-benchmarks.js";
import { metaRoutes } from "./meta.js";
import { profileRoutes } from "./profiles.js";
import { adminContributorRoutes } from "./admin-contributors.js";
import { adminValidatorRoutes } from "./admin-validators.js";
import { adminSubmissionRoutes } from "./admin-submissions.js";
import { adminInternalRoutes } from "./admin-internal.js";
import { adminLlmRoutes } from "./admin-llm.js";
import { waitlistRoutes } from "./waitlist.js";
import { profileSourceOAuthRoutes } from "./profile-source-oauth.js";
import { integrationRoutes } from "./integrations.js";
import { telegramRoutes } from "./telegram.js";

export async function v1Routes(app: FastifyInstance) {
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(meRoutes, { prefix: "/me" });
  await app.register(watchPrefRoutes, { prefix: "/watch-prefs" });
  await app.register(communityRoutes, { prefix: "/community" });
  await app.register(plannerRoutes, { prefix: "/planner" });
  await app.register(bountyRoutes, { prefix: "/bounties" });
  await app.register(batchRoutes, { prefix: "/batches" });
  await app.register(submissionRoutes, { prefix: "/submissions" });
  await app.register(auditRoutes, { prefix: "/audits" });
  await app.register(artifactRoutes, { prefix: "/artifacts" });
  await app.register(uploadReviewDraftRoutes, { prefix: "/upload-review-drafts" });
  await app.register(issueRoutes, { prefix: "/issues" });
  await app.register(notificationRoutes, { prefix: "/notifications" });
  await app.register(adminRoutes, { prefix: "/admin" });
  await app.register(adminCommunityRoutes, { prefix: "/admin" });
  await app.register(adminIssueRoutes, { prefix: "/admin" });
  await app.register(adminJobRoutes, { prefix: "/admin" });
  await app.register(adminArtifactRoutes, { prefix: "/admin" });
  await app.register(adminBadgeRoutes, { prefix: "/admin" });
  await app.register(adminDatasetTypeRoutes, { prefix: "/admin" });
  await app.register(adminHarnessRoutes, { prefix: "/admin/dataset-types/:id/harness" });
  await app.register(adminNotificationOpsRoutes, { prefix: "/admin" });
  await app.register(adminHealthRoutes, { prefix: "/admin" });
  await app.register(adminExecutionHealthRoutes, { prefix: "/admin" });
  await app.register(benchmarkRoutes, { prefix: "/benchmarks" });
  // Admin authoring surface for the benchmarks the public routes above read.
  // Paths are declared inside the plugin (`/benchmarks`, `/benchmarks/:id`,
  // …) so it registers under the shared `/admin` prefix like the other admin
  // route families, yielding /v1/admin/benchmarks*.
  await app.register(adminBenchmarkRoutes, { prefix: "/admin" });
  await app.register(metaRoutes, { prefix: "/meta" });
  await app.register(profileRoutes, { prefix: "/profiles" });
  await app.register(adminContributorRoutes, { prefix: "/admin" });
  await app.register(adminValidatorRoutes, { prefix: "/admin" });
  await app.register(adminSubmissionRoutes, { prefix: "/admin" });
  await app.register(adminInternalRoutes, { prefix: "/admin" });
  await app.register(adminLlmRoutes, { prefix: "/admin" });
  await app.register(waitlistRoutes, { prefix: "/waitlist" });
  await app.register(profileSourceOAuthRoutes, { prefix: "/profile-sources" });
  await app.register(integrationRoutes, { prefix: "/integrations" });
  await app.register(telegramRoutes, { prefix: "/telegram" });
}
