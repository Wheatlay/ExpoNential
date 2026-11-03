CREATE TABLE "deploy_envs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"source_ref" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_production" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_commit_deploys" (
	"issue_id" integer NOT NULL,
	"sha" text NOT NULL,
	"env_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_commit_deploys_issue_id_sha_env_id_pk" PRIMARY KEY("issue_id","sha","env_id")
);
--> statement-breakpoint
ALTER TABLE "deploy_envs" ADD CONSTRAINT "deploy_envs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_commit_deploys" ADD CONSTRAINT "issue_commit_deploys_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_commit_deploys" ADD CONSTRAINT "issue_commit_deploys_env_id_deploy_envs_id_fk" FOREIGN KEY ("env_id") REFERENCES "public"."deploy_envs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deploy_envs_project_name_idx" ON "deploy_envs" USING btree ("project_id",lower("name"));--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "env_id" integer;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_env_id_deploy_envs_id_fk" FOREIGN KEY ("env_id") REFERENCES "public"."deploy_envs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Dane przed kasowaniem kolumn.
insert into deploy_envs (project_id, name, source_ref, position, is_production) select id, 'Prod', deploy_source_ref, 0, true from projects where deploy_source <> '' or deploy_source_ref <> '';--> statement-breakpoint
insert into deploy_envs (project_id, name, source_ref, position, is_production) select id, 'Stage', stage_source_ref, 1, false from projects where stage_source_ref <> '';--> statement-breakpoint
update deploys d set env_id = e.id from deploy_envs e where e.project_id = d.project_id and lower(e.name) = d.env;--> statement-breakpoint
insert into issue_commit_deploys (issue_id, sha, env_id, at) select ic.issue_id, ic.sha, e.id, ic.deployed_at from issue_commits ic join issues i on i.id = ic.issue_id join deploy_envs e on e.project_id = i.project_id and e.is_production where ic.deployed_at is not null on conflict do nothing;--> statement-breakpoint
insert into issue_commit_deploys (issue_id, sha, env_id, at) select ic.issue_id, ic.sha, e.id, ic.staged_at from issue_commits ic join issues i on i.id = ic.issue_id join deploy_envs e on e.project_id = i.project_id and e.name = 'Stage' where ic.staged_at is not null on conflict do nothing;--> statement-breakpoint
ALTER TABLE "deploys" DROP COLUMN "env";--> statement-breakpoint
ALTER TABLE "issue_commits" DROP COLUMN "staged_at";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "deploy_source_ref";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "stage_source_ref";