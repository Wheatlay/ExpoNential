ALTER TABLE "agents" ADD COLUMN "phone_ready_keys" text[] NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "error" text;
