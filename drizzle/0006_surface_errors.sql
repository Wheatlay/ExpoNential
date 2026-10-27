ALTER TABLE "agents" ADD COLUMN "last_error" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "discord_last_error" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "discord_last_error_at" timestamp with time zone;