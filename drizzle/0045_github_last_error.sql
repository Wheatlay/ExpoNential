ALTER TABLE "projects" ADD COLUMN "github_last_error" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "github_last_error_at" timestamp with time zone;
