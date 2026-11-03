ALTER TABLE "oauth_grants" ADD COLUMN "agent_id" text;
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "agent_id" text;
