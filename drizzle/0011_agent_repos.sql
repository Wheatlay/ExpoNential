CREATE TABLE "agent_repos" (
	"agent_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'hook' NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_repos_agent_id_project_id_pk" PRIMARY KEY("agent_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "agents_may_clone" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_repos" ADD CONSTRAINT "agent_repos_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_repos" ADD CONSTRAINT "agent_repos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;