CREATE TABLE "activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_id" integer NOT NULL,
	"actor_id" integer,
	"via_ai" boolean DEFAULT false NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_id" integer NOT NULL,
	"author_id" integer,
	"body" text NOT NULL,
	"reply_to_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deploys" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer,
	"sha" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_commits" (
	"issue_id" integer NOT NULL,
	"sha" text NOT NULL,
	"message" text NOT NULL,
	"url" text NOT NULL,
	"author" text NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"deployed_at" timestamp with time zone,
	CONSTRAINT "issue_commits_issue_id_sha_pk" PRIMARY KEY("issue_id","sha")
);
--> statement-breakpoint
CREATE TABLE "issue_labels" (
	"issue_id" integer NOT NULL,
	"label_id" integer NOT NULL,
	CONSTRAINT "issue_labels_issue_id_label_id_pk" PRIMARY KEY("issue_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "issue_relations" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"from_issue_id" integer NOT NULL,
	"to_issue_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_views" (
	"user_id" integer NOT NULL,
	"issue_id" integer NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_views_user_id_issue_id_pk" PRIMARY KEY("user_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status_id" integer NOT NULL,
	"assignee_id" integer,
	"creator_id" integer,
	"priority" integer DEFAULT 0 NOT NULL,
	"parent_id" integer,
	"sprint_id" integer,
	"sort_order" double precision DEFAULT 0 NOT NULL,
	"analysis" text DEFAULT '' NOT NULL,
	"analysis_data" jsonb,
	"analysis_requested_at" timestamp with time zone,
	"analysis_updated_at" timestamp with time zone,
	"change_human" text DEFAULT '' NOT NULL,
	"change_ai" text DEFAULT '' NOT NULL,
	"info_from_id" integer,
	"info_question" text DEFAULT '' NOT NULL,
	"info_by_id" integer,
	"info_prev_status_id" integer,
	"info_comment_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_reminders" (
	"meeting_id" integer NOT NULL,
	"offset_minutes" integer NOT NULL,
	CONSTRAINT "meeting_reminders_meeting_id_offset_minutes_pk" PRIMARY KEY("meeting_id","offset_minutes")
);
--> statement-breakpoint
CREATE TABLE "meeting_slots" (
	"id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"proposed_by" integer,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_votes" (
	"slot_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"vote" text NOT NULL,
	CONSTRAINT "meeting_votes_slot_id_user_id_pk" PRIMARY KEY("slot_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"location_url" text DEFAULT '' NOT NULL,
	"sprint_id" integer,
	"manually_edited" boolean DEFAULT false NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#5e6ad2' NOT NULL,
	"discord_webhook_url" text,
	"meeting_location_url" text DEFAULT '' NOT NULL,
	"sprint_length_days" integer DEFAULT 14 NOT NULL,
	"review_time" text DEFAULT '15:00' NOT NULL,
	"review_minutes" integer DEFAULT 45 NOT NULL,
	"prompt_start" text DEFAULT '' NOT NULL,
	"prompt_analyze" text DEFAULT '' NOT NULL,
	"prompt_close" text DEFAULT '' NOT NULL,
	"github_repo" text DEFAULT '' NOT NULL,
	"deploy_branch" text DEFAULT 'master' NOT NULL,
	"deploy_source" text DEFAULT '' NOT NULL,
	"deploy_source_ref" text DEFAULT '' NOT NULL,
	"default_view" jsonb,
	"issue_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "reminder_sends" (
	"meeting_id" integer NOT NULL,
	"offset_minutes" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_sends_meeting_id_offset_minutes_starts_at_pk" PRIMARY KEY("meeting_id","offset_minutes","starts_at")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sprints" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"review_notes" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statuses" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"color" text NOT NULL,
	"position" integer NOT NULL,
	"hidden_on_board" boolean DEFAULT false NOT NULL,
	"role" text
);
--> statement-breakpoint
CREATE TABLE "user_notification_settings" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"push" boolean DEFAULT true NOT NULL,
	"discord" boolean DEFAULT true NOT NULL,
	"notify_prompt_shown" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_views" (
	"user_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"view" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_views_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_id" bigint,
	"login" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"avatar_url" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"calendar_token" text,
	"local_agent_at" timestamp with time zone,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id"),
	CONSTRAINT "users_login_unique" UNIQUE("login"),
	CONSTRAINT "users_calendar_token_unique" UNIQUE("calendar_token")
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_commits" ADD CONSTRAINT "issue_commits_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_from_issue_id_issues_id_fk" FOREIGN KEY ("from_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_to_issue_id_issues_id_fk" FOREIGN KEY ("to_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_views" ADD CONSTRAINT "issue_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_views" ADD CONSTRAINT "issue_views_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_status_id_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."statuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_info_from_id_users_id_fk" FOREIGN KEY ("info_from_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_info_by_id_users_id_fk" FOREIGN KEY ("info_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_reminders" ADD CONSTRAINT "meeting_reminders_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_slots" ADD CONSTRAINT "meeting_slots_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_slots" ADD CONSTRAINT "meeting_slots_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_votes" ADD CONSTRAINT "meeting_votes_slot_id_meeting_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."meeting_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_votes" ADD CONSTRAINT "meeting_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_sends" ADD CONSTRAINT "reminder_sends_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statuses" ADD CONSTRAINT "statuses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification_settings" ADD CONSTRAINT "user_notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_views" ADD CONSTRAINT "user_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_views" ADD CONSTRAINT "user_views_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_issue_idx" ON "activity" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_hash_idx" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "comments_issue_idx" ON "comments" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_commits_sha_idx" ON "issue_commits" USING btree ("sha");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_relations_uniq" ON "issue_relations" USING btree ("kind","from_issue_id","to_issue_id");--> statement-breakpoint
CREATE INDEX "issue_relations_to_idx" ON "issue_relations" USING btree ("to_issue_id");--> statement-breakpoint
CREATE INDEX "issues_status_idx" ON "issues" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX "issues_parent_idx" ON "issues" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_project_number_uniq" ON "issues" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_project_name_uniq" ON "labels" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "meeting_slots_meeting_idx" ON "meeting_slots" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "meetings_project_idx" ON "meetings" USING btree ("project_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_sprint_uniq" ON "meetings" USING btree ("sprint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sprints_project_starts_uniq" ON "sprints" USING btree ("project_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "statuses_project_name_uniq" ON "statuses" USING btree ("project_id","name");