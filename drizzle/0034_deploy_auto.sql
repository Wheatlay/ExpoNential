-- Źródła deployów wykrywane automatycznie (Server 1.3.24): źródło trafia do środowiska, a nie do projektu.
ALTER TABLE "deploy_envs" ADD COLUMN "source" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "deploy_envs" e SET "source" = p."deploy_source" FROM "projects" p WHERE p."id" = e."project_id" AND p."deploy_source" <> '';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deploy_ignored" text[] DEFAULT '{}' NOT NULL;
