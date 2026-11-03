-- Dangling references would make the new foreign keys fail: null them first.
UPDATE "issues" SET "parent_id" = NULL WHERE "parent_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "issues" p WHERE p."id" = "issues"."parent_id");--> statement-breakpoint
UPDATE "comments" SET "reply_to_id" = NULL WHERE "reply_to_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "comments" c WHERE c."id" = "comments"."reply_to_id");--> statement-breakpoint
UPDATE "issues" SET "info_comment_id" = NULL WHERE "info_comment_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "comments" c WHERE c."id" = "issues"."info_comment_id");--> statement-breakpoint
UPDATE "issues" SET "info_prev_status_id" = NULL WHERE "info_prev_status_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "statuses" s WHERE s."id" = "issues"."info_prev_status_id");--> statement-breakpoint
UPDATE "agents" SET "current_requester_id" = NULL WHERE "current_requester_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "agents"."current_requester_id");--> statement-breakpoint
-- Logins that differ only by case: rename the later ones (-<id>) so the unique index on lower(login) can be created.
UPDATE "users" SET "login" = "login" || '-' || "id" WHERE EXISTS (SELECT 1 FROM "users" o WHERE lower(o."login") = lower("users"."login") AND o."id" < "users"."id");--> statement-breakpoint
ALTER TABLE "activity" DROP CONSTRAINT "activity_actor_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "comments" DROP CONSTRAINT "comments_author_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_assignee_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_creator_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_current_requester_id_users_id_fk" FOREIGN KEY ("current_requester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_reply_to_id_comments_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_parent_id_issues_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_info_prev_status_id_statuses_id_fk" FOREIGN KEY ("info_prev_status_id") REFERENCES "public"."statuses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_info_comment_id_comments_id_fk" FOREIGN KEY ("info_comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_actor_idx" ON "activity" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_jobs_poll_idx" ON "agent_jobs" USING btree ("user_id","created_at") WHERE "agent_jobs"."claimed_at" is null;--> statement-breakpoint
CREATE INDEX "api_tokens_agent_idx" ON "api_tokens" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "inbox_issue_user_idx" ON "inbox_items" USING btree ("issue_id","user_id");--> statement-breakpoint
CREATE INDEX "issues_analysis_queue_idx" ON "issues" USING btree ("analysis_requested_at") WHERE "issues"."analysis_requested_at" is not null and "issues"."analysis_failed_at" is null;--> statement-breakpoint
CREATE INDEX "issues_analysis_device_idx" ON "issues" USING btree ("analysis_claimed_device") WHERE "issues"."analysis_claimed_device" is not null;--> statement-breakpoint
CREATE INDEX "oauth_grants_agent_idx" ON "oauth_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_login_lower_idx" ON "users" USING btree (lower("login"));--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "local_agent_at";