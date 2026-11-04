ALTER TABLE "agents" ADD COLUMN "last_ok_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "analysis_consent_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "editor" text DEFAULT 'vscode' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "analysis_toast_sticky" boolean DEFAULT true NOT NULL;