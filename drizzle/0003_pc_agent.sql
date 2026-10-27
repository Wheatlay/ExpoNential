CREATE TABLE "agent_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"issue_id" integer NOT NULL,
	"kind" text DEFAULT 'start' NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_device" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"busy" boolean DEFAULT false NOT NULL,
	"repo_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "analysis_requested_by" integer;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "analysis_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "analysis_claimed_by" integer;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "analysis_claimed_device" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "analysis_local_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "agent_team_queue" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_analysis_requested_by_users_id_fk" FOREIGN KEY ("analysis_requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_analysis_claimed_by_users_id_fk" FOREIGN KEY ("analysis_claimed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;