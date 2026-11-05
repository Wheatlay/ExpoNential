CREATE TABLE "project_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"actor_id" integer,
	"kind" text NOT NULL,
	"target_user_id" integer,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_log" ADD CONSTRAINT "project_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_log" ADD CONSTRAINT "project_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_log" ADD CONSTRAINT "project_log_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_log_project_created_idx" ON "project_log" USING btree ("project_id","created_at" DESC NULLS LAST);