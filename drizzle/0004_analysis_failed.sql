ALTER TABLE "issues" ADD COLUMN "analysis_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "analysis_error" text DEFAULT '' NOT NULL;