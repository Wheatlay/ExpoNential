ALTER TABLE "projects" ADD COLUMN "github_token" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "github_webhook_at" timestamp with time zone;
