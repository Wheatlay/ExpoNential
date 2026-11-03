CREATE TABLE "agent_tombstones" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_tombstones" ADD CONSTRAINT "agent_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;