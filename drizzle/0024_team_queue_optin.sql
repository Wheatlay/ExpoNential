CREATE TABLE "agent_team_projects" (
	"agent_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_team_projects_agent_id_project_id_pk" PRIMARY KEY("agent_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "user_dismissals" (
	"user_id" integer NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_dismissals_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "agent_team_projects" ADD CONSTRAINT "agent_team_projects_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_projects" ADD CONSTRAINT "agent_team_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_dismissals" ADD CONSTRAINT "user_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Dotychczasowi uczestnicy kolejki zespołu zostają: komputery członków z działającym repo w projektach z włączoną kolejką.
INSERT INTO "agent_team_projects" ("agent_id", "project_id")
SELECT DISTINCT r."agent_id", r."project_id" FROM "agent_repos" r
JOIN "projects" p ON p."id" = r."project_id" AND p."agent_team_queue" = true
JOIN "agents" a ON a."id" = r."agent_id"
JOIN "project_members" m ON m."project_id" = r."project_id" AND m."user_id" = a."user_id"
WHERE r."status" = 'ok'
ON CONFLICT DO NOTHING;
