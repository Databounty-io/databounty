-- Async bulk-submit progress tracking for SubmissionUploadDraft.
--
-- Backs the real `upload_draft.submit` background job (services/jobs/upload-draft-submit.ts):
-- POST /:id/submit now only CAS-claims the draft into `submitting` and enqueues a job, it never
-- creates Submission rows itself. The job needs somewhere durable to record how far it got and
-- why it stopped, so a crash mid-run and a resumed run both read an honest state.
--
-- All columns/index are additive and nullable — zero data risk, no backfill required.
ALTER TABLE "submission_upload_drafts"
  ADD COLUMN "submit_cursor_row_number" INTEGER,
  ADD COLUMN "submit_error" TEXT;

ALTER TABLE "submission_upload_draft_items"
  ADD COLUMN "submission_id" TEXT;

CREATE INDEX "submission_upload_draft_items_draft_id_submission_id_idx"
  ON "submission_upload_draft_items" ("draft_id", "submission_id");
