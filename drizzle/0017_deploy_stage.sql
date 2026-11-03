ALTER TABLE "deploys" ADD COLUMN "env" text DEFAULT 'prod' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_commits" ADD COLUMN "staged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "stage_source_ref" text DEFAULT '' NOT NULL;